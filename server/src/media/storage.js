import axios from "axios";
import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import { fileURLToPath } from "url";
import { query } from "../db.js";

let schemaReady = false;
let schemaPromise = null;

function storageRoot() {
  if (process.env.MEDIA_STORAGE_DIR) return process.env.MEDIA_STORAGE_DIR;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "..", "storage", "media");
}

function safeCallId(callId) {
  return String(callId || "").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function mediaDir(kind) {
  return path.join(storageRoot(), kind === "screen" ? "screens" : "audio");
}

function mediaBucket(kind) {
  return kind === "screen" ? "screens" : "audio";
}

function guessExtFromUrl(value, fallback = "bin") {
  const lower = String(value || "").toLowerCase();
  if (lower.includes(".mp3")) return "mp3";
  if (lower.includes(".wav")) return "wav";
  if (lower.includes(".m4a")) return "m4a";
  if (lower.includes(".aac")) return "aac";
  if (lower.includes(".mp4")) return "mp4";
  if (lower.includes(".webm")) return "webm";
  if (lower.includes(".m3u8")) return "m3u8";
  if (lower.includes(".json")) return "json";
  return fallback;
}

function absoluteMediaPath(storedPath) {
  if (!storedPath) return null;
  const text = String(storedPath);
  return path.isAbsolute(text) ? text : path.join(storageRoot(), text);
}

function relativeMediaPath(absolutePath) {
  if (!absolutePath) return null;
  return path.relative(storageRoot(), absolutePath);
}

function sanitizeUrlForStorage(urlValue) {
  try {
    const url = new URL(urlValue);
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

function mediaTimezone() {
  return process.env.REPORTS_TIMEZONE || process.env.BACKUP_TIMEZONE || "America/Bogota";
}

function mediaDayFolderFromTimestamp(value) {
  if (!value) return "undated";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "undated";
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: mediaTimezone(),
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${byType.month}-${byType.day}-${byType.year}`;
  } catch {
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    const year = String(date.getUTCFullYear());
    return `${month}-${day}-${year}`;
  }
}

function buildMediaRelativePath({ kind, callId, startTime, fileName = null, ext = null }) {
  const resolvedExt = (ext || "").replace(/^\./, "") || "bin";
  const resolvedFileName = fileName || `${safeCallId(callId)}.${resolvedExt}`;
  return path.join(mediaBucket(kind), mediaDayFolderFromTimestamp(startTime), resolvedFileName);
}

async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

function fileExists(filePath) {
  try {
    return Boolean(filePath && fs.existsSync(filePath));
  } catch {
    return false;
  }
}

export function storedMediaPathExists(storedPath) {
  return fileExists(absoluteMediaPath(storedPath));
}

function safeUrl(value) {
  try {
    return new URL(String(value || ""));
  } catch {
    return null;
  }
}

function isFive9Host(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "wfo.five9.com" || host.endsWith(".wfo.five9.com") || host.endsWith(".five9.com");
}

function isSignedAwsMediaHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host.endsWith(".amazonaws.com") && host.includes(".s3.");
}

function buildDownloadHeaders({ url, sessionHeaders, kind }) {
  const headers = {};
  const parsed = safeUrl(url);
  if (!parsed) return headers;

  const userAgent = sessionHeaders?.["user-agent"] || sessionHeaders?.["User-Agent"];
  if (userAgent) headers["user-agent"] = userAgent;

  if (kind === "audio") {
    headers.accept = "audio/*,*/*;q=0.8";
  } else if (kind === "screen") {
    headers.accept = "video/*,*/*;q=0.8";
  } else {
    headers.accept = "*/*";
  }

  if (isFive9Host(parsed.hostname)) {
    for (const key of ["accept-language", "authorization", "cookie", "origin", "referer"]) {
      if (sessionHeaders?.[key]) headers[key] = sessionHeaders[key];
    }
    return headers;
  }

  if (isSignedAwsMediaHost(parsed.hostname)) {
    return headers;
  }

  return headers;
}

function normalizeDownloadError({ error, url, kind, attempt, maxAttempts }) {
  const parsed = safeUrl(url);
  const status = error?.response?.status || null;
  const host = parsed?.hostname || "unknown_host";
  const code = error?.code || error?.errno || "unknown";
  const message = error?.message || String(error);
  
  let reason;
  if (status != null) {
    reason = `${kind || "media"}_download_http_${status}@${host}`;
  } else if (code === "ETIMEDOUT" || code === "EHOSTUNREACH" || code === "ECONNREFUSED") {
    reason = `${kind || "media"}_download_network@${host}`;
  } else {
    reason = `${kind || "media"}_download_failed@${host}`;
  }

  const wrapped = new Error(reason);
  wrapped.code = reason;
  wrapped.status = status;
  wrapped.host = host;
  wrapped.kind = kind || "media";
  wrapped.cause = error;
  wrapped.attempt = attempt || 1;
  wrapped.maxAttempts = maxAttempts || 1;
  wrapped.originalMessage = message;
  
  return wrapped;
}

async function downloadToPath({ url, targetPath, headers, kind, maxAttempts = 3 }) {
  const tmpPath = `${targetPath}.tmp`;
  await ensureDir(path.dirname(targetPath));
  
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await axios.get(url, {
        headers: headers || {},
        responseType: "stream",
        maxRedirects: 5,
        timeout: Number(process.env.MEDIA_DOWNLOAD_TIMEOUT_MS || 180000),
        validateStatus: (status) => status >= 200 && status < 400,
        httpAgent: null,
        httpsAgent: null
      });
      
      await pipeline(response.data, fs.createWriteStream(tmpPath));
      await fs.promises.rename(tmpPath, targetPath);
      
      return {
        contentType: response.headers?.["content-type"] || null,
        contentLength: response.headers?.["content-length"] ? Number(response.headers["content-length"]) : null
      };
    } catch (error) {
      lastError = error;
      
      // Clean up temp file
      try {
        await fs.promises.rm(tmpPath, { force: true });
      } catch {
        // ignore cleanup errors
      }
      
      const status = error?.response?.status;
      const isRetryable = !status || (status >= 500 && status < 600) || error?.code === "ETIMEDOUT" || error?.code === "ECONNREFUSED";
      
      if (!isRetryable || attempt === maxAttempts) {
        throw normalizeDownloadError({ error, url, kind, attempt, maxAttempts });
      }
      
      // Exponential backoff: 1s, 2s, 4s
      const delayMs = Math.min(10000, 1000 * Math.pow(2, attempt - 1));
      console.warn(`Download attempt ${attempt}/${maxAttempts} failed for ${url}, retrying in ${delayMs}ms...`, error.message);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  
  throw normalizeDownloadError({ error: lastError, url, kind, attempt: maxAttempts, maxAttempts });
}

export async function ensureMediaStorageSchema() {
  if (schemaReady) return;
  if (schemaPromise) return schemaPromise;

  schemaPromise = (async () => {
    await query(`SELECT pg_advisory_lock(73420342);`);
    try {
      await ensureDir(mediaDir("audio"));
      await ensureDir(mediaDir("screen"));
      await query(`
        ALTER TABLE calls
          ADD COLUMN IF NOT EXISTS local_audio_path TEXT,
          ADD COLUMN IF NOT EXISTS local_audio_source_url TEXT,
          ADD COLUMN IF NOT EXISTS local_audio_cached_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS local_audio_purged_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS local_screen_path TEXT,
          ADD COLUMN IF NOT EXISTS local_screen_source_url TEXT,
          ADD COLUMN IF NOT EXISTS local_screen_cached_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS local_media_updated_at TIMESTAMPTZ;
      `);
      await migrateStoredMediaLayout();
    } finally {
      await query(`SELECT pg_advisory_unlock(73420342);`);
    }
    schemaReady = true;
  })()
    .catch((error) => {
      schemaReady = false;
      throw error;
    })
    .finally(() => {
      schemaPromise = null;
    });

  return schemaPromise;
}

export async function getStoredMedia(callId) {
  await ensureMediaStorageSchema();
  const result = await query(
    `
    SELECT
      call_id,
      start_time,
      local_audio_path,
      local_audio_source_url,
      local_audio_cached_at,
      local_audio_purged_at,
      local_screen_path,
      local_screen_source_url,
      local_screen_cached_at
    FROM calls
    WHERE call_id = $1
    `,
    [callId]
  );

  const row = result.rows?.[0] || null;
  if (!row) return null;

  return {
    ...row,
    localAudioAbsolutePath: absoluteMediaPath(row.local_audio_path),
    localScreenAbsolutePath: absoluteMediaPath(row.local_screen_path),
    hasLocalAudio: fileExists(absoluteMediaPath(row.local_audio_path)),
    hasLocalScreen: fileExists(absoluteMediaPath(row.local_screen_path))
  };
}

async function migrateStoredMediaLayout() {
  const result = await query(
    `
    SELECT
      call_id,
      start_time,
      local_audio_path,
      local_screen_path
    FROM calls
    WHERE local_audio_path IS NOT NULL
       OR local_screen_path IS NOT NULL
    `
  );

  for (const row of result.rows || []) {
    const updates = {};

    if (row.local_audio_path) {
      const nextAudioPath = await moveStoredMediaIntoDayFolder({
        kind: "audio",
        callId: row.call_id,
        startTime: row.start_time,
        storedPath: row.local_audio_path
      });
      if (nextAudioPath && nextAudioPath !== row.local_audio_path) {
        updates.local_audio_path = nextAudioPath;
      }
    }

    if (row.local_screen_path) {
      const nextScreenPath = await moveStoredMediaIntoDayFolder({
        kind: "screen",
        callId: row.call_id,
        startTime: row.start_time,
        storedPath: row.local_screen_path
      });
      if (nextScreenPath && nextScreenPath !== row.local_screen_path) {
        updates.local_screen_path = nextScreenPath;
      }
    }

    if (Object.keys(updates).length) {
      await updateStoredMedia(row.call_id, updates);
    }
  }
}

async function moveStoredMediaIntoDayFolder({ kind, callId, startTime, storedPath }) {
  if (!storedPath) return storedPath;

  const currentAbsolutePath = absoluteMediaPath(storedPath);
  const currentFileName = path.basename(String(storedPath));
  const nextRelativePath = buildMediaRelativePath({
    kind,
    callId,
    startTime,
    fileName: currentFileName,
    ext: path.extname(currentFileName)
  });

  if (String(storedPath) === nextRelativePath) return storedPath;

  const nextAbsolutePath = absoluteMediaPath(nextRelativePath);
  if (fileExists(nextAbsolutePath)) {
    if (currentAbsolutePath && currentAbsolutePath !== nextAbsolutePath && fileExists(currentAbsolutePath)) {
      await fs.promises.rm(currentAbsolutePath, { force: true });
    }
    return nextRelativePath;
  }

  if (!currentAbsolutePath || !fileExists(currentAbsolutePath)) {
    return storedPath;
  }

  await ensureDir(path.dirname(nextAbsolutePath));
  await fs.promises.rename(currentAbsolutePath, nextAbsolutePath);
  return nextRelativePath;
}

async function updateStoredMedia(callId, values) {
  const keys = Object.keys(values || {});
  if (!keys.length) return;
  const params = [callId];
  const assignments = keys.map((key, index) => {
    params.push(values[key]);
    return `${key} = $${index + 2}`;
  });
  params.push(new Date().toISOString());
  assignments.push(`local_media_updated_at = $${params.length}`);

  await query(
    `
    UPDATE calls
    SET ${assignments.join(", ")}
    WHERE call_id = $1
    `,
    params
  );
}

export async function cachePreparedMedia({ callId, prepared, sessionHeaders = null }) {
  await ensureMediaStorageSchema();
  const current = await getStoredMedia(callId);
  const result = {
    audio: { available: false, cached: false, downloaded: false, purged: false },
    screen: { available: false, cached: false, downloaded: false }
  };

  if (!current) return result;

  if (current.hasLocalAudio) {
    result.audio.available = true;
    result.audio.cached = true;
  }
  if (current.local_audio_purged_at) {
    result.audio.purged = true;
  }
  if (current.hasLocalScreen) {
    result.screen.available = true;
    result.screen.cached = true;
  }

  if (prepared?.audioUrl && !result.audio.available && !result.audio.purged) {
    const ext = guessExtFromUrl(prepared.audioUrl, "mp3");
    const targetPath = absoluteMediaPath(
      buildMediaRelativePath({
        kind: "audio",
        callId,
        startTime: current.start_time,
        ext
      })
    );
    if (!fileExists(targetPath)) {
      await downloadToPath({
        url: prepared.audioUrl,
        targetPath,
        headers: buildDownloadHeaders({ url: prepared.audioUrl, sessionHeaders, kind: "audio" }),
        kind: "audio"
      });
      result.audio.downloaded = true;
    } else {
      result.audio.cached = true;
    }
    result.audio.available = true;
    await updateStoredMedia(callId, {
      local_audio_path: relativeMediaPath(targetPath),
      local_audio_source_url: sanitizeUrlForStorage(prepared.audioUrl),
      local_audio_cached_at: new Date().toISOString(),
      local_audio_purged_at: null
    });
  }

  if (prepared?.screenUrl && !result.screen.available) {
    const ext = guessExtFromUrl(prepared.screenUrl, "mp4");
    const targetPath = absoluteMediaPath(
      buildMediaRelativePath({
        kind: "screen",
        callId,
        startTime: current.start_time,
        ext
      })
    );
    if (!fileExists(targetPath)) {
      await downloadToPath({
        url: prepared.screenUrl,
        targetPath,
        headers: buildDownloadHeaders({ url: prepared.screenUrl, sessionHeaders, kind: "screen" }),
        kind: "screen"
      });
      result.screen.downloaded = true;
    } else {
      result.screen.cached = true;
    }
    result.screen.available = true;
    await updateStoredMedia(callId, {
      local_screen_path: relativeMediaPath(targetPath),
      local_screen_source_url: sanitizeUrlForStorage(prepared.screenUrl),
      local_screen_cached_at: new Date().toISOString()
    });
  }

  return result;
}

export async function saveTranscriptJson(callId, transcriptJson) {
  try {
    if (!transcriptJson) return null;
    
    // Validate JSON
    const jsonData = typeof transcriptJson === "string" ? JSON.parse(transcriptJson) : transcriptJson;
    if (!jsonData || typeof jsonData !== "object") {
      console.error("Invalid transcript JSON:", jsonData);
      return null;
    }

    await ensureMediaStorageSchema();
    const media = await getStoredMedia(callId);
    const audioPath = media?.localAudioAbsolutePath;
    
    if (!audioPath) {
      console.warn(`No audio path found for callId: ${callId}`);
      return null;
    }

    // Replace audio extension with .json
    const jsonPath = audioPath.replace(/\.[^.]+$/, ".json");
    await ensureDir(path.dirname(jsonPath));
    
    // Write JSON file with validation
    await fs.promises.writeFile(jsonPath, JSON.stringify(jsonData, null, 2), "utf-8");
    
    console.log(`Saved transcript JSON: ${jsonPath}`);
    return jsonPath;
  } catch (error) {
    console.error(`Error saving transcript JSON for ${callId}:`, error);
    return null;
  }
}

export async function purgeLocalAudio(callId) {
  await ensureMediaStorageSchema();
  const media = await getStoredMedia(callId);
  const absolutePath = media?.localAudioAbsolutePath;
  if (absolutePath && fileExists(absolutePath)) {
    await fs.promises.rm(absolutePath, { force: true });
  }
  await updateStoredMedia(callId, {
    local_audio_path: null,
    local_audio_purged_at: new Date().toISOString()
  });
}

export function buildMediaFileResponseInfo(filePath) {
  const ext = path.extname(String(filePath || "")).replace(/^\./, "").toLowerCase();
  if (ext === "mp3") return { contentType: "audio/mpeg", ext };
  if (ext === "wav") return { contentType: "audio/wav", ext };
  if (ext === "m4a") return { contentType: "audio/mp4", ext };
  if (ext === "aac") return { contentType: "audio/aac", ext };
  if (ext === "mp4") return { contentType: "video/mp4", ext };
  if (ext === "webm") return { contentType: "video/webm", ext };
  if (ext === "json") return { contentType: "application/json", ext };
  return { contentType: "application/octet-stream", ext: ext || "bin" };
}

export function sendLocalMediaFile(res, filePath, downloadNameBase) {
  const absolutePath = absoluteMediaPath(filePath);
  if (!absolutePath || !fileExists(absolutePath)) return false;
  const info = buildMediaFileResponseInfo(absolutePath);
  res.setHeader("Content-Type", info.contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${downloadNameBase}.${info.ext}"`);
  res.sendFile(absolutePath);
  return true;
}
