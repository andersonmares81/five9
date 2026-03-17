import express from "express";
import { authMiddleware } from "../auth.js";
import { pushBackupRange } from "../backup/push.js";
import { fetchInteractionRecordings } from "../wfo/client.js";
import {
  buildRangePayloadFromSession,
  clearWfoSession,
  getWfoSession,
  setWfoSessionFromCurl,
  setWfoSessionFromHar
} from "../wfo/session.js";
import { resolveWfoPlayerMedia, streamWfoMedia } from "../wfo/player.js";
import { prepareInteractionRecordingMedia } from "../wfo/prepare.js";
import { syncWfoInteractionRecordingsRange } from "../wfo/sync.js";
import { query } from "../db.js";
import { createJob, getJob } from "../jobs.js";
import {
  cachePreparedMedia,
  ensureMediaStorageSchema,
  getStoredMedia,
  sendLocalMediaFile
} from "../media/storage.js";

const router = express.Router();

function isUnauthorized(error) {
  const status = error?.response?.status;
  if (status === 401 || status === 403) return true;
  const code = String(error?.code || "");
  const message = String(error?.message || "");
  return code === "wfo_session_expired" || message === "wfo_session_expired";
}

function toRangeBoundary(value, isEnd) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const tzOffset = process.env.BACKUP_TZ_OFFSET || "-05:00";
    const suffix = isEnd ? `T23:59:59.999${tzOffset}` : `T00:00:00.000${tzOffset}`;
    const date = new Date(`${value}${suffix}`);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function selectMedia(mediaList, prefer) {
  const media = Array.isArray(mediaList) ? mediaList : [];
  if (!media.length) return null;
  const desired =
    prefer === "audio"
      ? "audio"
      : prefer === "video" || prefer === "screen"
        ? "video"
        : prefer === "hls"
          ? "hls"
          : null;
  if (!desired) return media[0];
  return media.find((item) => item.kind === desired) || media[0];
}

function sanitizePresignedUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

function guessExtFromUrl(value) {
  const lower = String(value || "").toLowerCase();
  if (lower.includes(".mp3")) return "mp3";
  if (lower.includes(".wav")) return "wav";
  if (lower.includes(".m4a")) return "m4a";
  if (lower.includes(".aac")) return "aac";
  if (lower.includes(".mp4")) return "mp4";
  if (lower.includes(".webm")) return "webm";
  if (lower.includes(".m3u8")) return "m3u8";
  if (lower.includes(".json")) return "json";
  return "bin";
}

function backupErrorCode(error) {
  const message = String(error?.message || "");
  if (message.includes("ECONNREFUSED")) return "backup_endpoint_unreachable";
  if (message.includes("timeout")) return "backup_endpoint_timeout";
  if (message.includes("Backup endpoint error:")) return "backup_endpoint_http_error";
  return "backup_push_failed";
}

export async function safePushBackupRange({ from, to }) {
  try {
    const pushed = await pushBackupRange({
      from,
      to,
      endpoint: process.env.BACKUP_ENDPOINT,
      pageSize: Number(process.env.BACKUP_PAGE_SIZE || 500)
    });
    return {
      ok: true,
      pushed,
      from,
      to,
      endpointConfigured: true
    };
  } catch (error) {
    return {
      ok: false,
      pushed: 0,
      from,
      to,
      endpointConfigured: true,
      error: backupErrorCode(error),
      message: String(error?.message || "backup_push_failed")
    };
  }
}

export function dayRangeIso({ date }) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return null;
  const tzOffset = process.env.BACKUP_TZ_OFFSET || "-05:00";
  const from = new Date(`${date}T00:00:00.000${tzOffset}`);
  const to = new Date(`${date}T23:59:59.999${tzOffset}`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  return { from: from.toISOString(), to: to.toISOString() };
}

export function explicitRangeIso({ from, to }) {
  const rangeFrom = toRangeBoundary(from, false);
  const rangeTo = toRangeBoundary(to, true);
  if (!rangeFrom || !rangeTo) return null;
  return { from: rangeFrom, to: rangeTo };
}

function pushRecent(list, entry, max = 8) {
  list.unshift(entry);
  if (list.length > max) list.length = max;
}

export async function prefetchMediaJob({
  date = null,
  from = null,
  to = null,
  maxCalls,
  catalog,
  offset,
  session,
  onlyMissing = true,
  report
}) {
  await ensureMediaStorageSchema();
  const range = date ? dayRangeIso({ date }) : explicitRangeIso({ from, to });
  if (!range) throw new Error("invalid_date");

  const limit = maxCalls ? Math.max(1, Number(maxCalls)) : null;
  let resumeOffset = offset ? Math.max(0, Number(offset)) : 0;
  const databaseCatalog = String(catalog || "ONLINE_DB");

  const shouldFilterMissing = String(onlyMissing).toLowerCase() !== "false";
  const missingWhere = `
    (
      (local_audio_path IS NULL AND local_audio_purged_at IS NULL)
      OR local_screen_path IS NULL
    )
  `;

  const totalResult = await query(
    `
    SELECT COUNT(*)::int AS total
    FROM calls
    WHERE start_time >= $1 AND start_time <= $2
      ${shouldFilterMissing ? `AND ${missingWhere}` : ""}
    `,
    [range.from, range.to]
  );
  const totalAll = Number(totalResult.rows?.[0]?.total || 0);
  if (resumeOffset > totalAll) resumeOffset = totalAll;
  if (shouldFilterMissing) resumeOffset = 0;

  const params = [range.from, range.to];
  let paramIndex = 3;
  let sql = `
    SELECT call_id
    FROM calls
    WHERE start_time >= $1 AND start_time <= $2
    ${shouldFilterMissing ? `AND ${missingWhere}` : ""}
    ORDER BY start_time ASC
  `;
  if (limit != null) {
    sql += ` LIMIT $${paramIndex}`;
    params.push(limit);
    paramIndex += 1;
  }
  if (resumeOffset) {
    sql += ` OFFSET $${paramIndex}`;
    params.push(resumeOffset);
    paramIndex += 1;
  }

  const callsResult = await query(sql, params);

  const callIds = (callsResult.rows || []).map((row) => row.call_id).filter(Boolean);
  const total = limit != null ? Math.min(totalAll, resumeOffset + callIds.length) : totalAll;

  const concurrency = Math.min(6, Math.max(1, Number(process.env.WFO_PREFETCH_CONCURRENCY || 3)));
  let done = resumeOffset;
  let cached = 0;
  let okAny = 0;
  let okAudio = 0;
  let okScreen = 0;
  let noMedia = 0;
  let failed = 0;

  const errors = [];
  const errorCounts = {};
  const activeCalls = new Set();
  const recentDownloads = [];
  const queue = [...callIds];
  let aborted = false;
  let abortError = null;

  function bumpError(errorCode) {
    const key = String(errorCode || "prefetch_failed");
    errorCounts[key] = (errorCounts[key] || 0) + 1;
  }

  const update = () => {
    report({
      date,
      from: range.from,
      to: range.to,
      total,
      done,
      startedOffset: resumeOffset,
      cached,
      okAny,
      okAudio,
      okScreen,
      noMedia,
      failed,
      errorCounts,
      activeCalls: Array.from(activeCalls),
      recentDownloads,
      lastError: errors[errors.length - 1] || null,
      resumeOffset: abortError === "wfo_session_expired" ? (shouldFilterMissing ? 0 : done) : null
    });
  };

  update();

  async function worker() {
    while (queue.length && !aborted) {
      const callId = queue.shift();
      activeCalls.add(callId);
      try {
        const prepared = await prepareInteractionRecordingMedia({
          eventNumber: callId,
          databaseCatalog,
          eventType: "Play",
          session
        });
        if (!prepared?.ok) {
          const code = prepared?.error || "prepare_event_no_media";
          if (code === "prepare_event_no_media") {
            noMedia += 1;
            pushRecent(recentDownloads, { callId, status: "no_media", audio: false, screen: false });
          } else if (code === "wfo_session_expired") {
            aborted = true;
            abortError = "wfo_session_expired";
            clearWfoSession();
            queue.length = 0;
          } else {
            failed += 1;
            bumpError(code);
            if (errors.length < 20) errors.push({ callId, error: code });
            pushRecent(recentDownloads, { callId, status: "failed", audio: false, screen: false, error: code });
          }
        } else {
          const stored = await cachePreparedMedia({
            callId,
            prepared,
            sessionHeaders: session?.headers
          });
          if (prepared?.cached || stored.audio.cached || stored.screen.cached) cached += 1;
          if (stored.audio.available || stored.screen.available) okAny += 1;
          if (stored.audio.available) okAudio += 1;
          if (stored.screen.available) okScreen += 1;
          pushRecent(recentDownloads, {
            callId,
            status: prepared?.cached || stored.audio.cached || stored.screen.cached ? "cached" : "ok",
            audio: Boolean(stored.audio.available),
            screen: Boolean(stored.screen.available)
          });
        }
      } catch (error) {
        if (isUnauthorized(error)) {
          aborted = true;
          abortError = "wfo_session_expired";
          clearWfoSession();
          queue.length = 0;
          continue;
        }
        failed += 1;
        bumpError(error?.message || "prefetch_failed");
        if (errors.length < 20) {
          errors.push({ callId, error: String(error?.message || "prefetch_failed") });
        }
        pushRecent(recentDownloads, {
          callId,
          status: "failed",
          audio: false,
          screen: false,
          error: String(error?.message || "prefetch_failed")
        });
      } finally {
        activeCalls.delete(callId);
        done += 1;
        if (done % 10 === 0 || done === total || aborted) update();
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, queue.length || 1) }, () => worker());
  await Promise.all(workers);
  update();

  if (abortError === "wfo_session_expired") {
    const err = new Error("wfo_session_expired");
    err.code = "wfo_session_expired";
    throw err;
  }

  return {
    date,
    from: range.from,
    to: range.to,
    databaseCatalog,
    total,
    done,
    startedOffset: resumeOffset,
    cached,
    okAny,
    okAudio,
    okScreen,
    noMedia,
    failed,
    errors
  };
}

async function prefetchDayMediaJob(args) {
  return prefetchMediaJob(args);
}

function isAllowedWfoReportUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    if (!(host === "wfo.five9.com" || host.endsWith(".wfo.five9.com"))) return false;
    if (!url.pathname.startsWith("/five9wfo/")) return false;
    if (!(url.pathname.endsWith("/index.html") || url.pathname.endsWith("/wfoplayer/") || url.pathname.includes("/wfoplayer"))) {
      return false;
    }
    if (!url.searchParams.get("ul")) return false;
    return true;
  } catch {
    return false;
  }
}

router.get("/calls/:callId/media", authMiddleware, async (req, res) => {
  try {
    const callId = String(req.params.callId || "").trim();
    if (!callId) return res.status(400).json({ error: "missing_call_id" });

    const localMedia = await getStoredMedia(callId);
    if (localMedia?.hasLocalAudio || localMedia?.hasLocalScreen) {
      return res.json({
        ok: true,
        eventNumber: callId,
        databaseCatalog: String(req.query.catalog || "ONLINE_DB"),
        source: "local",
        audioAvailable: Boolean(localMedia?.hasLocalAudio),
        screenAvailable: Boolean(localMedia?.hasLocalScreen),
        audioPurged: Boolean(localMedia?.local_audio_purged_at),
        audioPath: localMedia?.local_audio_path || null,
        screenPath: localMedia?.local_screen_path || null,
        audioUrl: localMedia?.local_audio_source_url || null,
        screenUrl: localMedia?.local_screen_source_url || null
      });
    }

    const session = getWfoSession();
    if (!session) {
      return res.status(400).json({ error: "wfo_session_not_configured" });
    }

    const prepared = await prepareInteractionRecordingMedia({
      eventNumber: callId,
      databaseCatalog: String(req.query.catalog || "ONLINE_DB"),
      eventType: String(req.query.eventType || "Play"),
      session
    });
    if (!prepared.ok) {
      const debug =
        prepared?.error === "prepare_event_missing_progress"
          ? {
              responseType: prepared.responseType || null,
              responseKeys: prepared.responseKeys || null,
              responseSnippet: prepared.responseSnippet || null
            }
          : null;
      return res
        .status(404)
        .json({ error: prepared.error || "wfo_media_not_found", ...(debug ? { debug } : {}) });
    }

    await cachePreparedMedia({ callId, prepared, sessionHeaders: session?.headers });
    const refreshedMedia = await getStoredMedia(callId);
    return res.json({
      ok: true,
      eventNumber: prepared.eventNumber,
      databaseCatalog: prepared.databaseCatalog,
      expiresAt: prepared.expiresAt,
      source: refreshedMedia?.hasLocalAudio || refreshedMedia?.hasLocalScreen ? "local" : "remote",
      audioAvailable: Boolean(refreshedMedia?.hasLocalAudio),
      screenAvailable: Boolean(refreshedMedia?.hasLocalScreen),
      audioPurged: Boolean(refreshedMedia?.local_audio_purged_at),
      audioPath: refreshedMedia?.local_audio_path || null,
      screenPath: refreshedMedia?.local_screen_path || null,
      audioUrl: sanitizePresignedUrl(prepared.audioUrl),
      screenUrl: sanitizePresignedUrl(prepared.screenUrl),
      sessionJsonUrl: sanitizePresignedUrl(prepared.sessionJsonUrl)
    });
  } catch (error) {
    if (isUnauthorized(error)) {
      clearWfoSession();
      return res.status(401).json({ error: "wfo_session_expired" });
    }
    console.error("wfo_call_media_failed", error.message);
    return res.status(500).json({ error: "wfo_call_media_failed" });
  }
});

router.get("/calls/:callId/audio", authMiddleware, async (req, res) => {
  try {
    const callId = String(req.params.callId || "").trim();
    if (!callId) return res.status(400).json({ error: "missing_call_id" });

    const localMedia = await getStoredMedia(callId);
    if (localMedia?.hasLocalAudio) {
      const sent = sendLocalMediaFile(res, localMedia.local_audio_path, `wfo-audio-${callId}`);
      if (sent) return;
    }
    if (localMedia?.local_audio_purged_at) {
      return res.status(404).json({ error: "local_audio_purged" });
    }

    const session = getWfoSession();
    if (!session) {
      return res.status(400).json({ error: "wfo_session_not_configured" });
    }

    const prepared = await prepareInteractionRecordingMedia({
      eventNumber: callId,
      databaseCatalog: String(req.query.catalog || "ONLINE_DB"),
      eventType: String(req.query.eventType || "Play"),
      session
    });
    if (!prepared.ok || !prepared.audioUrl) {
      const debug =
        prepared?.error === "prepare_event_missing_progress"
          ? {
              responseType: prepared.responseType || null,
              responseKeys: prepared.responseKeys || null,
              responseSnippet: prepared.responseSnippet || null
            }
          : null;
      return res
        .status(404)
        .json({ error: prepared.error || "wfo_audio_not_found", ...(debug ? { debug } : {}) });
    }

    await cachePreparedMedia({ callId, prepared, sessionHeaders: session?.headers });
    const refreshedMedia = await getStoredMedia(callId);
    if (refreshedMedia?.hasLocalAudio) {
      const sent = sendLocalMediaFile(res, refreshedMedia.local_audio_path, `wfo-audio-${callId}`);
      if (sent) return;
    }

    const streamed = await streamWfoMedia({ url: prepared.audioUrl, session, res });
    if (!streamed.ok) {
      return res.status(streamed.status || 502).json({ error: streamed.error || "wfo_audio_stream_failed" });
    }
    return;
  } catch (error) {
    if (isUnauthorized(error)) {
      clearWfoSession();
      return res.status(401).json({ error: "wfo_session_expired" });
    }
    console.error("wfo_call_audio_failed", error.message);
    return res.status(500).json({ error: "wfo_call_audio_failed" });
  }
});

router.get("/calls/:callId/screen", authMiddleware, async (req, res) => {
  try {
    const callId = String(req.params.callId || "").trim();
    if (!callId) return res.status(400).json({ error: "missing_call_id" });

    const localMedia = await getStoredMedia(callId);
    if (localMedia?.hasLocalScreen) {
      const sent = sendLocalMediaFile(res, localMedia.local_screen_path, `wfo-screen-${callId}`);
      if (sent) return;
    }

    const session = getWfoSession();
    if (!session) {
      return res.status(400).json({ error: "wfo_session_not_configured" });
    }

    const prepared = await prepareInteractionRecordingMedia({
      eventNumber: callId,
      databaseCatalog: String(req.query.catalog || "ONLINE_DB"),
      eventType: String(req.query.eventType || "Play"),
      session
    });
    if (!prepared.ok || !prepared.screenUrl) {
      const debug =
        prepared?.error === "prepare_event_missing_progress"
          ? {
              responseType: prepared.responseType || null,
              responseKeys: prepared.responseKeys || null,
              responseSnippet: prepared.responseSnippet || null
            }
          : null;
      return res
        .status(404)
        .json({ error: prepared.error || "wfo_screen_not_found", ...(debug ? { debug } : {}) });
    }

    await cachePreparedMedia({ callId, prepared, sessionHeaders: session?.headers });
    const refreshedMedia = await getStoredMedia(callId);
    if (refreshedMedia?.hasLocalScreen) {
      const sent = sendLocalMediaFile(res, refreshedMedia.local_screen_path, `wfo-screen-${callId}`);
      if (sent) return;
    }

    const streamed = await streamWfoMedia({ url: prepared.screenUrl, session, res });
    if (!streamed.ok) {
      return res.status(streamed.status || 502).json({ error: streamed.error || "wfo_screen_stream_failed" });
    }
    return;
  } catch (error) {
    if (isUnauthorized(error)) {
      clearWfoSession();
      return res.status(401).json({ error: "wfo_session_expired" });
    }
    console.error("wfo_call_screen_failed", error.message);
    return res.status(500).json({ error: "wfo_call_screen_failed" });
  }
});

router.get("/calls/:callId/session-json", authMiddleware, async (req, res) => {
  try {
    const session = getWfoSession();
    if (!session) {
      return res.status(400).json({ error: "wfo_session_not_configured" });
    }

    const callId = String(req.params.callId || "").trim();
    if (!callId) return res.status(400).json({ error: "missing_call_id" });

    const prepared = await prepareInteractionRecordingMedia({
      eventNumber: callId,
      databaseCatalog: String(req.query.catalog || "ONLINE_DB"),
      eventType: String(req.query.eventType || "Play"),
      session
    });

    if (!prepared.ok || !prepared.sessionJsonUrl) {
      return res.status(404).json({ error: prepared.error || "wfo_session_json_not_found" });
    }

    res.setHeader("Content-Disposition", `attachment; filename="wfo-session-${callId}.json"`);

    const streamed = await streamWfoMedia({ url: prepared.sessionJsonUrl, session, res });
    if (!streamed.ok) {
      return res.status(streamed.status || 502).json({ error: streamed.error || "wfo_session_json_stream_failed" });
    }
    return;
  } catch (error) {
    if (isUnauthorized(error)) {
      clearWfoSession();
      return res.status(401).json({ error: "wfo_session_expired" });
    }
    console.error("wfo_call_session_json_failed", error.message);
    return res.status(500).json({ error: "wfo_call_session_json_failed" });
  }
});

router.get("/jobs/:jobId", authMiddleware, (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "job_not_found" });
  return res.json(job);
});

router.post("/prefetch-day", authMiddleware, async (req, res) => {
  try {
    const session = getWfoSession();
    if (!session) {
      return res.status(400).json({ error: "wfo_session_not_configured" });
    }
    const { date, maxCalls, catalog, offset, onlyMissing } = req.body || {};
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return res.status(400).json({ error: "invalid_date" });
    const offsetValue = offset == null ? 0 : Math.max(0, Number(offset));
    if (!Number.isFinite(offsetValue)) return res.status(400).json({ error: "invalid_offset" });

    const job = createJob({
      type: "wfo_prefetch_day",
      payload: {
        date: String(date),
        maxCalls: maxCalls ?? null,
        catalog: catalog ?? "ONLINE_DB",
        offset: offsetValue,
        onlyMissing: onlyMissing !== false
      },
      run: ({ report }) =>
        prefetchDayMediaJob({
          date: String(date),
          maxCalls,
          catalog,
          offset: offsetValue,
          onlyMissing: onlyMissing !== false,
          session,
          report
        })
    });

    return res.json({ ok: true, jobId: job.id, job });
  } catch (error) {
    if (isUnauthorized(error)) {
      clearWfoSession();
      return res.status(401).json({ error: "wfo_session_expired" });
    }
    console.error("wfo_prefetch_day_failed", error.message);
    return res.status(500).json({ error: "wfo_prefetch_day_failed" });
  }
});

router.post("/prefetch-range", authMiddleware, async (req, res) => {
  try {
    const session = getWfoSession();
    if (!session) {
      return res.status(400).json({ error: "wfo_session_not_configured" });
    }
    const { from, to, maxCalls, catalog, offset, onlyMissing } = req.body || {};
    const resolvedRange = explicitRangeIso({ from, to });
    if (!resolvedRange) return res.status(400).json({ error: "invalid_date_range" });
    const offsetValue = offset == null ? 0 : Math.max(0, Number(offset));
    if (!Number.isFinite(offsetValue)) return res.status(400).json({ error: "invalid_offset" });

    const job = createJob({
      type: "wfo_prefetch_range",
      payload: {
        from: String(from),
        to: String(to),
        maxCalls: maxCalls ?? null,
        catalog: catalog ?? "ONLINE_DB",
        offset: offsetValue,
        onlyMissing: onlyMissing !== false
      },
      run: ({ report }) =>
        prefetchMediaJob({
          from: String(from),
          to: String(to),
          maxCalls,
          catalog,
          offset: offsetValue,
          onlyMissing: onlyMissing !== false,
          session,
          report
        })
    });

    return res.json({ ok: true, jobId: job.id, job });
  } catch (error) {
    if (isUnauthorized(error)) {
      clearWfoSession();
      return res.status(401).json({ error: "wfo_session_expired" });
    }
    console.error("wfo_prefetch_range_failed", error.message);
    return res.status(500).json({ error: "wfo_prefetch_range_failed" });
  }
});

router.get("/interaction-recordings", authMiddleware, async (req, res) => {
  try {
    const pageNumber = Number(req.query.pageNumber || 1);
    const session = getWfoSession();
    const data = await fetchInteractionRecordings({
      pageNumber,
      ...(session
        ? {
            baseUrl: session.baseUrl,
            method: session.method,
            headers: session.headers,
            payload: session.payload,
            pageSize: session.pageSize
          }
        : {})
    });
    return res.json(data);
  } catch (error) {
    if (isUnauthorized(error)) {
      clearWfoSession();
      return res.status(401).json({ error: "wfo_session_expired" });
    }
    console.error("wfo_interaction_recordings_failed", error.message);
    return res.status(500).json({ error: "wfo_interaction_recordings_failed" });
  }
});

router.get("/session", authMiddleware, (_req, res) => {
  const session = getWfoSession();
  return res.json({
    configured: Boolean(session),
    pageSize: session?.pageSize || null,
    pageNumber: session?.pageNumber || null,
    hasCookie: Boolean(session?.headers?.cookie),
    hasToken: Boolean(session?.token)
  });
});

router.get("/validate", authMiddleware, async (_req, res) => {
  try {
    const session = getWfoSession();
    if (!session) {
      return res.status(400).json({ error: "wfo_session_not_configured" });
    }
    const data = await fetchInteractionRecordings({
      pageNumber: 1,
      baseUrl: session.baseUrl,
      method: session.method,
      headers: session.headers,
      payload: session.payload,
      pageSize: session.pageSize
    });
    const count = Array.isArray(data?.Data) ? data.Data.length : Array.isArray(data?.data) ? data.data.length : null;
    return res.json({ ok: true, pageSize: session.pageSize, sampleCount: count });
  } catch (error) {
    if (isUnauthorized(error)) {
      clearWfoSession();
      return res.status(401).json({ error: "wfo_session_expired" });
    }
    console.error("wfo_validate_failed", error.message);
    return res.status(500).json({ error: "wfo_validate_failed" });
  }
});

router.post("/attach-report", authMiddleware, async (req, res) => {
  try {
    const callId = String(req.body?.callId || "").trim();
    const reportUrl = String(req.body?.reportUrl || "").trim();
    const force = Boolean(req.body?.force);

    if (!callId) return res.status(400).json({ error: "missing_call_id" });
    if (!reportUrl) return res.status(400).json({ error: "missing_report_url" });
    if (!isAllowedWfoReportUrl(reportUrl)) return res.status(400).json({ error: "invalid_report_url" });

    const result = await query(
      `
      UPDATE calls
      SET recording_url = CASE
        WHEN $3 = true THEN $2
        ELSE COALESCE(recording_url, $2)
      END,
      updated_at = now()
      WHERE call_id = $1
      RETURNING call_id, recording_url
      `,
      [callId, reportUrl, force]
    );

    if (!result.rows?.[0]) return res.status(404).json({ error: "call_not_found" });
    return res.json({ ok: true, call: result.rows[0] });
  } catch (error) {
    console.error("wfo_attach_report_failed", error.message);
    return res.status(500).json({ error: "wfo_attach_report_failed" });
  }
});

router.get("/audio/resolve", authMiddleware, async (req, res) => {
  try {
    const session = getWfoSession();
    if (!session) {
      return res.status(400).json({ error: "wfo_session_not_configured" });
    }

    const recordingUrl = req.query.url ? String(req.query.url) : null;
    const ul = req.query.ul ? String(req.query.ul) : null;
    const result = await resolveWfoPlayerMedia({ recordingUrl, ul, session });
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }
    return res.json(result);
  } catch (error) {
    if (isUnauthorized(error)) {
      clearWfoSession();
      return res.status(401).json({ error: "wfo_session_expired" });
    }
    console.error("wfo_audio_resolve_failed", error.message);
    return res.status(500).json({ error: "wfo_audio_resolve_failed" });
  }
});

router.get("/audio", authMiddleware, async (req, res) => {
  try {
    const session = getWfoSession();
    if (!session) {
      return res.status(400).json({ error: "wfo_session_not_configured" });
    }

    const recordingUrl = req.query.url ? String(req.query.url) : null;
    const ul = req.query.ul ? String(req.query.ul) : null;
    const mediaUrl = req.query.mediaUrl ? String(req.query.mediaUrl) : null;
    const prefer = req.query.prefer ? String(req.query.prefer) : "audio";

    if (mediaUrl) {
      const streamed = await streamWfoMedia({ url: mediaUrl, session, res });
      if (!streamed.ok) {
        return res.status(streamed.status || 502).json({ error: streamed.error || "wfo_audio_stream_failed" });
      }
      return;
    }

    if (recordingUrl && /\.(mp3|wav|m4a|aac|mp4|webm|m3u8)(\?|$)/i.test(recordingUrl)) {
      const streamed = await streamWfoMedia({ url: recordingUrl, session, res });
      if (!streamed.ok) {
        return res.status(streamed.status || 502).json({ error: streamed.error || "wfo_audio_stream_failed" });
      }
      return;
    }

    const resolved = await resolveWfoPlayerMedia({ recordingUrl, ul, session });
    if (resolved.error) {
      return res.status(400).json({ error: resolved.error });
    }

    const best = selectMedia(resolved.media, prefer);
    if (!best?.url) {
      return res.status(404).json({ error: "wfo_audio_not_found" });
    }

    const filenameBase = `wfo-media-${new Date().toISOString().slice(0, 10)}`;
    const ext = best.extension || "bin";
    res.setHeader("Content-Disposition", `attachment; filename="${filenameBase}.${ext}"`);

    const streamed = await streamWfoMedia({ url: best.url, session, res });
    if (!streamed.ok) {
      return res.status(streamed.status || 502).json({ error: streamed.error || "wfo_audio_stream_failed" });
    }
    return;
  } catch (error) {
    if (isUnauthorized(error)) {
      clearWfoSession();
      return res.status(401).json({ error: "wfo_session_expired" });
    }
    console.error("wfo_audio_failed", error.message);
    return res.status(500).json({ error: "wfo_audio_failed" });
  }
});

router.get("/screen", authMiddleware, async (req, res) => {
  try {
    const session = getWfoSession();
    if (!session) {
      return res.status(400).json({ error: "wfo_session_not_configured" });
    }

    const recordingUrl = req.query.url ? String(req.query.url) : null;
    const ul = req.query.ul ? String(req.query.ul) : null;

    if (recordingUrl && /\.(mp4|webm|m3u8)(\?|$)/i.test(recordingUrl)) {
      const streamed = await streamWfoMedia({ url: recordingUrl, session, res });
      if (!streamed.ok) {
        return res.status(streamed.status || 502).json({ error: streamed.error || "wfo_screen_stream_failed" });
      }
      return;
    }

    const resolved = await resolveWfoPlayerMedia({ recordingUrl, ul, session });
    if (resolved.error) {
      return res.status(400).json({ error: resolved.error });
    }

    const best = selectMedia(resolved.media, "video");
    if (!best?.url) {
      return res.status(404).json({ error: "wfo_screen_not_found" });
    }

    const filenameBase = `wfo-screen-${new Date().toISOString().slice(0, 10)}`;
    const ext = best.extension || "mp4";
    res.setHeader("Content-Disposition", `attachment; filename="${filenameBase}.${ext}"`);

    const streamed = await streamWfoMedia({ url: best.url, session, res });
    if (!streamed.ok) {
      return res.status(streamed.status || 502).json({ error: streamed.error || "wfo_screen_stream_failed" });
    }
    return;
  } catch (error) {
    if (isUnauthorized(error)) {
      clearWfoSession();
      return res.status(401).json({ error: "wfo_session_expired" });
    }
    console.error("wfo_screen_failed", error.message);
    return res.status(500).json({ error: "wfo_screen_failed" });
  }
});

router.post("/session", authMiddleware, (req, res) => {
  const rawText = String(req.body?.rawText || "").trim();
  if (!rawText) {
    return res.status(400).json({ error: "missing_raw_text" });
  }
  try {
    const session = setWfoSessionFromCurl(rawText);
    return res.json({
      configured: true,
      pageSize: session.pageSize,
      pageNumber: session.pageNumber,
      hasCookie: Boolean(session.headers.cookie),
      hasToken: Boolean(session.token)
    });
  } catch (error) {
    return res.status(400).json({ error: error.message || "invalid_curl" });
  }
});

router.post("/session-har", authMiddleware, (req, res) => {
  try {
    const { url, headers, payload } = req.body || {};
    const session = setWfoSessionFromHar({ url, headers, payload });
    return res.json({
      configured: true,
      pageSize: session.pageSize,
      pageNumber: session.pageNumber,
      hasCookie: Boolean(session.headers.cookie),
      hasToken: Boolean(session.token)
    });
  } catch (error) {
    return res.status(400).json({ error: error.message || "invalid_har" });
  }
});

router.delete("/session", authMiddleware, (_req, res) => {
  clearWfoSession();
  return res.json({ configured: false });
});

router.post("/sync-range", authMiddleware, async (req, res) => {
  try {
    const session = getWfoSession();
    if (!session) {
      return res.status(400).json({ error: "wfo_session_not_configured" });
    }
    const { from, to, order = "desc", maxPages = 50, startPage, uploadBackup } = req.body || {};
    const payload = buildRangePayloadFromSession({ from, to, order });
    const result = await syncWfoInteractionRecordingsRange({
      from,
      to,
      order,
      maxPages: Number(maxPages),
      startPage: Number(startPage || 1),
      clientOptions: {
        baseUrl: session.baseUrl,
        method: session.method,
        headers: session.headers,
        payload,
        pageSize: session.pageSize
      }
    });

    let backup = null;
    const shouldUploadBackup = uploadBackup !== false && Boolean(process.env.BACKUP_ENDPOINT);

    if (shouldUploadBackup) {
      const backupFrom = toRangeBoundary(from, false);
      const backupTo = toRangeBoundary(to, true);
      if (!backupFrom || !backupTo) {
        return res.status(400).json({ error: "invalid_date_range" });
      }
      backup = await safePushBackupRange({ from: backupFrom, to: backupTo });
    }

    return res.json({
      ...result,
      backup
    });
  } catch (error) {
    if (isUnauthorized(error)) {
      clearWfoSession();
      return res.status(401).json({ error: "wfo_session_expired" });
    }
    console.error("wfo_sync_range_failed", error.message);
    return res.status(500).json({ error: "wfo_sync_range_failed", detail: String(error?.message || "wfo_sync_range_failed") });
  }
});

router.post("/sync-day-split", authMiddleware, async (req, res) => {
  try {
    const session = getWfoSession();
    if (!session) {
      return res.status(400).json({ error: "wfo_session_not_configured" });
    }

    const { date, order = "asc", maxPages = 50, uploadBackup } = req.body || {};
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
      return res.status(400).json({ error: "invalid_date" });
    }

    const tzOffset = process.env.BACKUP_TZ_OFFSET || "-05:00";
    const halfRanges = [
      {
        label: "am",
        from: `${date}T00:00:00.000${tzOffset}`,
        to: `${date}T11:59:59.999${tzOffset}`
      },
      {
        label: "pm",
        from: `${date}T12:00:00.000${tzOffset}`,
        to: `${date}T23:59:59.999${tzOffset}`
      }
    ];

    const results = [];
    let inserted = 0;
    let skipped = 0;
    let backupPushed = 0;

    for (const range of halfRanges) {
      const rangePayload = buildRangePayloadFromSession({ from: range.from, to: range.to, order });
      const rangeResult = await syncWfoInteractionRecordingsRange({
        from: range.from,
        to: range.to,
        order,
        maxPages: Number(maxPages),
        startPage: 1,
        clientOptions: {
          baseUrl: session.baseUrl,
          method: session.method,
          headers: session.headers,
          payload: rangePayload,
          pageSize: session.pageSize
        }
      });

      inserted += rangeResult.inserted || 0;
      skipped += rangeResult.skipped || 0;

      let backup = null;
      const shouldUploadBackup = uploadBackup !== false && Boolean(process.env.BACKUP_ENDPOINT);
      if (shouldUploadBackup) {
        const backupFrom = toRangeBoundary(range.from, false);
        const backupTo = toRangeBoundary(range.to, true);
        if (!backupFrom || !backupTo) {
          return res.status(400).json({ error: "invalid_date_range" });
        }
        backup = await safePushBackupRange({ from: backupFrom, to: backupTo });
        backupPushed += Number(backup?.pushed || 0);
      }

      results.push({
        label: range.label,
        ...rangeResult,
        backup
      });
    }

    return res.json({
      date,
      inserted,
      skipped,
      backupPushed,
      results
    });
  } catch (error) {
    if (isUnauthorized(error)) {
      clearWfoSession();
      return res.status(401).json({ error: "wfo_session_expired" });
    }
    console.error("wfo_sync_day_split_failed", error.message);
    return res.status(500).json({ error: "wfo_sync_day_split_failed", detail: String(error?.message || "wfo_sync_day_split_failed") });
  }
});

export default router;
