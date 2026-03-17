import axios from "axios";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function inferExpiryMs(urlValue) {
  const url = safeUrl(urlValue);
  if (!url) return null;
  const expires = Number(url.searchParams.get("X-Amz-Expires") || "");
  const dateRaw = url.searchParams.get("X-Amz-Date");
  if (!expires || !dateRaw) return null;
  const match = String(dateRaw).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const start = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  );
  if (!Number.isFinite(start)) return null;
  return start + expires * 1000;
}

function extractProgressId(payload) {
  if (!payload) return null;

  // Some endpoints return a bare string progress id.
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    if (!trimmed) return null;
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        const parsed = JSON.parse(trimmed);
        const nested = extractProgressId(parsed);
        if (nested) return nested;
      } catch {
        // ignore
      }
    }
    return trimmed;
  }

  const visited = new Set();

  function coerce(value) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed ? trimmed : null;
    }
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return null;
  }

  function walk(node, depth) {
    if (!node || depth > 5) return null;

    if (typeof node === "string" || typeof node === "number") {
      return coerce(node);
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item, depth + 1);
        if (found) return found;
      }
      return null;
    }

    if (typeof node !== "object") return null;
    if (visited.has(node)) return null;
    visited.add(node);

    const directKeys = [
      "progressId",
      "ProgressId",
      "progressID",
      "ProgressID",
      "progress_id",
      "Progress_id",
      "progressid",
      "Progressid",
      "id",
      "Id",
      "key",
      "Key"
    ];

    for (const key of directKeys) {
      if (Object.prototype.hasOwnProperty.call(node, key)) {
        const found = coerce(node[key]);
        if (found) return found;
      }
    }

    for (const [key, value] of Object.entries(node)) {
      if (/progress.*id/i.test(key)) {
        const found = coerce(value);
        if (found) return found;
      }
    }

    for (const value of Object.values(node)) {
      const found = walk(value, depth + 1);
      if (found) return found;
    }

    return null;
  }

  return walk(payload, 0);
}

function collectUrls(node, found) {
  if (!node) return;
  if (typeof node === "string") {
    const text = node.trim();
    if (!text) return;
    const matches = text.match(/https?:\/\/[^\s"'<>]+/gi);
    if (matches) {
      for (const item of matches) found.add(item);
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectUrls(item, found);
    return;
  }
  if (typeof node === "object") {
    for (const value of Object.values(node)) collectUrls(value, found);
  }
}

function pickByPattern(urls, patterns) {
  for (const url of urls) {
    const lower = String(url).toLowerCase();
    if (patterns.some((pattern) => pattern.test(lower))) return url;
  }
  return null;
}

const mediaCache = new Map();

function cacheKey({ eventNumber, catalog }) {
  return `${catalog}:${eventNumber}`;
}

export function clearPreparedMediaCache() {
  mediaCache.clear();
}

function looksLikeHtml(payload, contentType) {
  const type = String(contentType || "").toLowerCase();
  if (type.includes("text/html")) return true;
  if (typeof payload !== "string") return false;
  const sample = payload.slice(0, 500).toLowerCase();
  return sample.includes("<!doctype html") || sample.includes("<html") || sample.includes("<head") || sample.includes("<body");
}

function wfoSessionExpiredError() {
  const error = new Error("wfo_session_expired");
  error.code = "wfo_session_expired";
  return error;
}

function summarizeAxiosPayload(payload) {
  if (payload == null) return null;
  if (typeof payload === "string") return payload.slice(0, 300);
  if (Array.isArray(payload)) return `array(${payload.length})`;
  if (typeof payload === "object") {
    try {
      return JSON.stringify(payload).slice(0, 300);
    } catch {
      return Object.keys(payload).slice(0, 20).join(",");
    }
  }
  return String(payload).slice(0, 300);
}

function normalizePrepareAxiosError(error, phase) {
  const status = error?.response?.status || null;
  const contentType = error?.response?.headers?.["content-type"] || null;
  const payload = error?.response?.data;

  if (status === 401 || status === 403) {
    return {
      ok: false,
      error: "wfo_session_expired",
      status,
      responseType:
        payload === null ? "null" : Array.isArray(payload) ? "array" : typeof payload,
      responseSnippet: summarizeAxiosPayload(payload)
    };
  }

  if (looksLikeHtml(payload, contentType)) {
    throw wfoSessionExpiredError();
  }

  return {
    ok: false,
    error: `${phase}_http_${status || "failed"}`,
    status,
    responseType:
      payload === null ? "null" : Array.isArray(payload) ? "array" : typeof payload,
    responseSnippet: summarizeAxiosPayload(payload)
  };
}

export async function prepareInteractionRecordingMedia({
  eventNumber,
  databaseCatalog = "ONLINE_DB",
  eventType = "Play",
  session
}) {
  const callId = String(eventNumber || "").trim();
  if (!callId) {
    return { ok: false, error: "missing_event_number" };
  }
  if (!session?.baseUrl || !session?.headers) {
    return { ok: false, error: "wfo_session_not_configured" };
  }

  const key = cacheKey({ eventNumber: callId, catalog: databaseCatalog });
  const cached = mediaCache.get(key);
  if (cached?.expiresAt && cached.expiresAt > Date.now() + 60_000) {
    return { ok: true, cached: true, ...cached };
  }

  const prepareUrl = `${session.baseUrl.replace(/\/$/, "")}/api/InteractionRecordings/PrepareEvent`;
  const baseOrigin = safeUrl(session.baseUrl)?.origin || null;
  const origin = session.headers?.origin || baseOrigin || "https://cloud1656.wfo.five9.com";
  const referer =
    session.headers?.referer ||
    (baseOrigin ? `${baseOrigin}/five9wfo/wfointeractionrecordings/` : "https://cloud1656.wfo.five9.com/five9wfo/wfointeractionrecordings/");
  const body = {
    EventNumber: Number(callId),
    DatabaseCatalog: databaseCatalog,
    EventType: eventType
  };

  let prepareResponse;
  try {
    prepareResponse = await axios.post(prepareUrl, body, {
      headers: {
        ...session.headers,
        origin,
        referer,
        accept: "application/json, text/plain, */*",
        "content-type": "application/json;charset=UTF-8",
        "x-requested-with": "XMLHttpRequest"
      }
    });
  } catch (error) {
    return normalizePrepareAxiosError(error, "prepare_event");
  }

  if (looksLikeHtml(prepareResponse.data, prepareResponse.headers?.["content-type"])) {
    throw wfoSessionExpiredError();
  }

  const progressId = extractProgressId(prepareResponse.data);
  if (!progressId) {
    const data = prepareResponse.data;
    const responseType = data === null ? "null" : Array.isArray(data) ? "array" : typeof data;
    const responseKeys = responseType === "object" ? Object.keys(data).slice(0, 20) : null;
    const responseSnippet = responseType === "string" ? String(data).slice(0, 220) : null;
    return {
      ok: false,
      error: "prepare_event_missing_progress",
      responseType,
      responseKeys,
      responseSnippet
    };
  }

  const progressUrl = `${session.baseUrl.replace(/\/$/, "")}/api/InteractionRecordings/PrepareEvent/Progress/${progressId}/${databaseCatalog}`;

  const foundUrls = new Set();
  let lastPayload = null;

  for (let attempt = 0; attempt < 16; attempt += 1) {
    let progressResponse;
    try {
      progressResponse = await axios.get(progressUrl, {
        headers: {
          ...session.headers,
          origin,
          referer,
          accept: "application/json, text/plain, */*",
          "x-requested-with": "XMLHttpRequest"
        }
      });
    } catch (error) {
      return normalizePrepareAxiosError(error, "prepare_progress");
    }
    if (looksLikeHtml(progressResponse.data, progressResponse.headers?.["content-type"])) {
      throw wfoSessionExpiredError();
    }
    lastPayload = progressResponse.data;
    collectUrls(progressResponse.data, foundUrls);

    const urls = Array.from(foundUrls);
    const audioUrl =
      pickByPattern(urls, [/session\.mp3/, /\.mp3\?/]) ||
      pickByPattern(urls, [/session\.m4a/, /\.m4a\?/]) ||
      pickByPattern(urls, [/\.wav\?/]);
    const screenUrl = pickByPattern(urls, [/session\.mp4/, /\.mp4\?/, /\.webm\?/]);
    const sessionJsonUrl = pickByPattern(urls, [/session\.json/, /\.json\?/]);

    const isDone =
      Boolean(progressResponse.data?.Completed) ||
      Boolean(progressResponse.data?.completed) ||
      progressResponse.data?.Progress === 100 ||
      progressResponse.data?.progress === 100 ||
      Boolean(audioUrl || screenUrl || sessionJsonUrl);

    if (isDone && (audioUrl || screenUrl || sessionJsonUrl)) {
      const expiresAt =
        inferExpiryMs(audioUrl) ||
        inferExpiryMs(screenUrl) ||
        inferExpiryMs(sessionJsonUrl) ||
        Date.now() + 60 * 60 * 1000;

      const value = {
        eventNumber: callId,
        databaseCatalog,
        eventType,
        progressId,
        audioUrl: audioUrl || null,
        screenUrl: screenUrl || null,
        sessionJsonUrl: sessionJsonUrl || null,
        expiresAt
      };
      mediaCache.set(key, value);
      return { ok: true, cached: false, ...value };
    }

    await sleep(350 + attempt * 120);
  }

  const urls = Array.from(foundUrls);
  const audioUrl =
    pickByPattern(urls, [/session\.mp3/, /\.mp3\?/]) ||
    pickByPattern(urls, [/session\.m4a/, /\.m4a\?/]) ||
    pickByPattern(urls, [/\.wav\?/]);
  const screenUrl = pickByPattern(urls, [/session\.mp4/, /\.mp4\?/, /\.webm\?/]);
  const sessionJsonUrl = pickByPattern(urls, [/session\.json/, /\.json\?/]);

  if (audioUrl || screenUrl || sessionJsonUrl) {
    const expiresAt =
      inferExpiryMs(audioUrl) ||
      inferExpiryMs(screenUrl) ||
      inferExpiryMs(sessionJsonUrl) ||
      Date.now() + 30 * 60 * 1000;
    const value = {
      eventNumber: callId,
      databaseCatalog,
      eventType,
      progressId,
      audioUrl: audioUrl || null,
      screenUrl: screenUrl || null,
      sessionJsonUrl: sessionJsonUrl || null,
      expiresAt
    };
    mediaCache.set(key, value);
    return { ok: true, cached: false, ...value };
  }

  return { ok: false, error: "prepare_event_no_media", progressId, lastPayload };
}
