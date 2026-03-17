import express from "express";
import { authMiddleware } from "../auth.js";
import { query } from "../db.js";
import { purgeLocalAudio, saveTranscriptJson } from "../media/storage.js";
import { transcribeAndAnalyzeCall } from "../transcription/service.js";
import { separateTranscriptSpeakers } from "../transcription/speakers.js";
import { clearWfoSession } from "../wfo/session.js";
import { createJob, getJob } from "../jobs.js";

const router = express.Router();

let schemaReady = false;
let schemaPromise = null;

function enrichAnalysisRow(row) {
  if (!row) return row;
  if (!row.transcript_text && !row.transcript_json) return row;
  return {
    ...row,
    transcript_json: {
      ...(row.transcript_json || {}),
      speaker_separation:
        row.transcript_json?.speaker_separation ||
        separateTranscriptSpeakers({
          transcriptText: row.transcript_text || "",
          transcriptJson: row.transcript_json || null
        })
    }
  };
}

function isWfoUnauthorized(error) {
  const status = error?.response?.status;
  if (status !== 401 && status !== 403) {
    const code = String(error?.code || "");
    const message = String(error?.message || "");
    if (code === "wfo_session_expired" || message === "wfo_session_expired") return true;
    return false;
  }
  const url = String(error?.config?.url || "");
  return url.includes("wfo.five9.com") || url.includes(".wfo.five9.com") || url.includes("/five9wfo/");
}

export async function ensureSchema() {
  if (schemaReady) return;
  if (schemaPromise) return schemaPromise;

  schemaPromise = (async () => {
    await query(`SELECT pg_advisory_lock(73420341);`);
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS call_analysis (
          id SERIAL PRIMARY KEY,
          call_id TEXT NOT NULL UNIQUE REFERENCES calls(call_id) ON DELETE CASCADE,
          source TEXT,
          media_url_sanitized TEXT,
          transcript_text TEXT,
          transcript_json JSONB,
          sentiment_label TEXT,
          sentiment_score REAL,
          sentiment_json JSONB,
          language TEXT,
          provider TEXT,
          model TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      await query(`CREATE INDEX IF NOT EXISTS call_analysis_updated_at_idx ON call_analysis (updated_at DESC);`);
    } finally {
      await query(`SELECT pg_advisory_unlock(73420341);`);
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

function dayRangeIso({ date }) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return null;
  const tzOffset = process.env.BACKUP_TZ_OFFSET || "-05:00";
  const from = new Date(`${date}T00:00:00.000${tzOffset}`);
  const to = new Date(`${date}T23:59:59.999${tzOffset}`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  return { from: from.toISOString(), to: to.toISOString() };
}

function toRangeBoundary(value, isEnd) {
  if (!value) return null;
  const stringValue = String(value).trim();
  if (!stringValue) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(stringValue)) {
    const tzOffset = process.env.BACKUP_TZ_OFFSET || "-05:00";
    const time = isEnd ? "23:59:59.999" : "00:00:00.000";
    const date = new Date(`${stringValue}T${time}${tzOffset}`);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(stringValue);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function rangeIso({ from, to }) {
  const resolvedFrom = toRangeBoundary(from, false);
  const resolvedTo = toRangeBoundary(to, true);
  if (!resolvedFrom || !resolvedTo) return null;
  return { from: resolvedFrom, to: resolvedTo };
}

function pushRecent(list, entry, max = 8) {
  list.unshift(entry);
  if (list.length > max) list.length = max;
}

async function rebuildStoredAnalysis(callId) {
  await ensureSchema();
  const result = await query(
    `
    SELECT
      call_id,
      source,
      media_url_sanitized,
      transcript_text,
      transcript_json,
      sentiment_label,
      sentiment_score,
      sentiment_json,
      language,
      provider,
      model,
      created_at,
      updated_at
    FROM call_analysis
    WHERE call_id = $1
    `,
    [callId]
  );
  const row = result.rows?.[0] || null;
  if (!row) return null;

  const enriched = enrichAnalysisRow(row);
  await query(
    `
    UPDATE call_analysis
    SET transcript_json = $2,
        updated_at = now()
    WHERE call_id = $1
    `,
    [callId, enriched.transcript_json || null]
  );

  return enriched;
}

export async function transcribeRangeJob({ date = null, from = null, to = null, maxCalls, offset, force, report }) {
  await ensureSchema();
  const range = date ? dayRangeIso({ date }) : rangeIso({ from, to });
  if (!range) throw new Error("invalid_date");

  const limit = maxCalls ? Math.max(1, Number(maxCalls)) : null;
  let resumeOffset = offset ? Math.max(0, Number(offset)) : 0;
  const analysisJoin = force
    ? "JOIN call_analysis ca ON ca.call_id = calls.call_id"
    : "LEFT JOIN call_analysis ca ON ca.call_id = calls.call_id";
  const analysisWhere = force ? "" : "AND ca.call_id IS NULL";

  const totalResult = await query(
    `
    SELECT COUNT(*)::int AS total
    FROM calls
    ${analysisJoin}
    WHERE calls.start_time >= $1 AND calls.start_time <= $2
    ${analysisWhere}
    `,
    [range.from, range.to]
  );
  const totalAll = Number(totalResult.rows?.[0]?.total || 0);
  if (resumeOffset > totalAll) resumeOffset = totalAll;
  if (!force) resumeOffset = 0;

  const params = [range.from, range.to];
  let paramIndex = 3;
  let sql = `
    SELECT calls.call_id
    FROM calls
    ${analysisJoin}
    WHERE calls.start_time >= $1 AND calls.start_time <= $2
    ${analysisWhere}
    ORDER BY calls.start_time ASC
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

  let done = resumeOffset;
  let reused = 0;
  let succeeded = 0;
  let noAudio = 0;
  let failed = 0;
  const errors = [];
  const errorCounts = {};
  let lastError = null;
  let aborted = false;
  let currentCallId = null;
  const recentTranscribed = [];

  function bumpError(errorCode) {
    const key = String(errorCode || "transcribe_failed");
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
      resumeOffset: aborted ? (force ? done : 0) : null,
      reused,
      succeeded,
      noAudio,
      failed,
      errorCounts,
      lastError,
      currentCallId,
      recentTranscribed
    });
  };
  update();

  for (const callId of callIds) {
    currentCallId = callId;
    try {
      if (force) {
        const existing = await query(`SELECT call_id FROM call_analysis WHERE call_id = $1`, [callId]);
        if (existing.rows?.[0]) {
          const rebuilt = await rebuildStoredAnalysis(callId);
          if (rebuilt) {
            succeeded += 1;
            pushRecent(recentTranscribed, { callId, status: "refreshed" });
            continue;
          }
        }
      }

      const analysis = await transcribeAndAnalyzeCall({ callId });
      await query(
        `
        INSERT INTO call_analysis (
          call_id, source, media_url_sanitized,
          transcript_text, transcript_json,
          sentiment_label, sentiment_score, sentiment_json,
          language, provider, model, updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
        ON CONFLICT (call_id) DO UPDATE SET
          source = EXCLUDED.source,
          media_url_sanitized = EXCLUDED.media_url_sanitized,
          transcript_text = EXCLUDED.transcript_text,
          transcript_json = EXCLUDED.transcript_json,
          sentiment_label = EXCLUDED.sentiment_label,
          sentiment_score = EXCLUDED.sentiment_score,
          sentiment_json = EXCLUDED.sentiment_json,
          language = EXCLUDED.language,
          provider = EXCLUDED.provider,
          model = EXCLUDED.model,
          updated_at = now()
        `,
        [
          analysis.callId,
          analysis.source,
          analysis.mediaUrlSanitized,
          analysis.transcriptText,
          analysis.transcriptJson,
          analysis.sentimentLabel,
          analysis.sentimentScore,
          analysis.sentimentJson,
          analysis.language,
          analysis.provider,
          analysis.model
        ]
      );

      // Save transcript JSON before purging audio
      if (analysis.transcriptJson) {
        await saveTranscriptJson(callId, analysis.transcriptJson);
      }

      if (String(process.env.DELETE_AUDIO_AFTER_TRANSCRIBE || "true").toLowerCase() !== "false") {
        await purgeLocalAudio(callId);
      }
      succeeded += 1;
      pushRecent(recentTranscribed, { callId, status: "ok" });
    } catch (error) {
      const message = String(error?.message || "");
      if (isWfoUnauthorized(error)) {
        failed += 1;
        clearWfoSession();
        aborted = true;
        const err = new Error("wfo_session_expired");
        err.code = "wfo_session_expired";
        throw err;
      }
      if (message === "audio_not_found") {
        noAudio += 1;
        pushRecent(recentTranscribed, { callId, status: "no_audio" });
        continue;
      }
      if (
        message === "openai_not_configured" ||
        message === "python_not_found" ||
        message === "faster_whisper_not_installed" ||
        message === "sentiment_provider_not_configured" ||
        message === "ollama_unavailable" ||
        message === "ollama_model_not_found"
      ) {
        bumpError(message);
        lastError = { callId, error: message };
        throw new Error(message);
      }
      failed += 1;
      const errorCode = String(error?.message || "transcribe_failed");
      bumpError(errorCode);
      lastError = { callId, error: errorCode };
      if (errors.length < 20) errors.push({ callId, error: errorCode });
      pushRecent(recentTranscribed, { callId, status: "failed", error: errorCode });
    } finally {
      currentCallId = null;
      done += 1;
      if (aborted || done % 3 === 0 || done === total) update();
    }
  }

  update();
  return { date, from: range.from, to: range.to, total, done, startedOffset: resumeOffset, reused, succeeded, noAudio, failed, errors };
}

async function transcribeDayJob(args) {
  return transcribeRangeJob(args);
}

router.get("/calls/:callId", authMiddleware, async (req, res) => {
  try {
    await ensureSchema();
    const { callId } = req.params;
    const result = await query(
      `
      SELECT
        call_id,
        source,
        media_url_sanitized,
        transcript_text,
        transcript_json,
        sentiment_label,
        sentiment_score,
        sentiment_json,
        language,
        provider,
        model,
        created_at,
        updated_at
      FROM call_analysis
      WHERE call_id = $1
      `,
      [callId]
    );
    if (!result.rows?.[0]) return res.status(404).json({ error: "analysis_not_found" });
    return res.json(enrichAnalysisRow(result.rows[0]));
  } catch (error) {
    console.error("analysis_get_failed", error.message);
    return res.status(500).json({ error: "analysis_get_failed" });
  }
});

router.get("/jobs/:jobId", authMiddleware, (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "job_not_found" });
  return res.json(job);
});

router.post("/transcribe-day", authMiddleware, async (req, res) => {
  try {
    const { date, maxCalls, force, offset } = req.body || {};
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return res.status(400).json({ error: "invalid_date" });
    const offsetValue = offset == null ? 0 : Math.max(0, Number(offset));
    if (!Number.isFinite(offsetValue)) return res.status(400).json({ error: "invalid_offset" });

    const job = createJob({
      type: "analysis_transcribe_day",
      payload: { date: String(date), maxCalls: maxCalls ?? null, offset: offsetValue, force: Boolean(force) },
      run: ({ report }) =>
        transcribeDayJob({ date: String(date), maxCalls, offset: offsetValue, force: Boolean(force), report })
    });

    return res.json({ ok: true, jobId: job.id, job });
  } catch (error) {
    console.error("analysis_transcribe_day_failed", error.message);
    if (isWfoUnauthorized(error)) {
      clearWfoSession();
      return res.status(401).json({ error: "wfo_session_expired" });
    }
    return res.status(500).json({ error: "analysis_transcribe_day_failed" });
  }
});

router.post("/transcribe-range", authMiddleware, async (req, res) => {
  try {
    const { from, to, maxCalls, force, offset } = req.body || {};
    const resolvedRange = rangeIso({ from, to });
    if (!resolvedRange) return res.status(400).json({ error: "invalid_date_range" });
    const offsetValue = offset == null ? 0 : Math.max(0, Number(offset));
    if (!Number.isFinite(offsetValue)) return res.status(400).json({ error: "invalid_offset" });

    const job = createJob({
      type: "analysis_transcribe_range",
      payload: { from: String(from), to: String(to), maxCalls: maxCalls ?? null, offset: offsetValue, force: Boolean(force) },
      run: ({ report }) =>
        transcribeRangeJob({
          from: String(from),
          to: String(to),
          maxCalls,
          offset: offsetValue,
          force: Boolean(force),
          report
        })
    });

    return res.json({ ok: true, jobId: job.id, job });
  } catch (error) {
    console.error("analysis_transcribe_range_failed", error.message);
    if (isWfoUnauthorized(error)) {
      clearWfoSession();
      return res.status(401).json({ error: "wfo_session_expired" });
    }
    return res.status(500).json({ error: "analysis_transcribe_range_failed" });
  }
});

router.post("/transcribe", authMiddleware, async (req, res) => {
  try {
    await ensureSchema();
    const { callId, force } = req.body || {};
    const resolvedCallId = String(callId || "").trim();
    if (!resolvedCallId) return res.status(400).json({ error: "missing_call_id" });

    const existing = await query(
      `SELECT call_id, updated_at FROM call_analysis WHERE call_id = $1`,
      [resolvedCallId]
    );
    if (existing.rows?.[0]) {
      if (force) {
        const rebuilt = await rebuildStoredAnalysis(resolvedCallId);
        return res.json({ reused: false, refreshed: true, analysis: rebuilt });
      }
      const record = await query(
        `
        SELECT
          call_id,
          source,
          media_url_sanitized,
          transcript_text,
          transcript_json,
          sentiment_label,
          sentiment_score,
          sentiment_json,
          language,
          provider,
          model,
          created_at,
          updated_at
        FROM call_analysis
        WHERE call_id = $1
        `,
        [resolvedCallId]
      );
      return res.json({ reused: true, analysis: enrichAnalysisRow(record.rows?.[0]) });
    }

    const analysis = await transcribeAndAnalyzeCall({ callId: resolvedCallId });

    await query(
      `
      INSERT INTO call_analysis (
        call_id, source, media_url_sanitized,
        transcript_text, transcript_json,
        sentiment_label, sentiment_score, sentiment_json,
        language, provider, model, updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
      ON CONFLICT (call_id) DO UPDATE SET
        source = EXCLUDED.source,
        media_url_sanitized = EXCLUDED.media_url_sanitized,
        transcript_text = EXCLUDED.transcript_text,
        transcript_json = EXCLUDED.transcript_json,
        sentiment_label = EXCLUDED.sentiment_label,
        sentiment_score = EXCLUDED.sentiment_score,
        sentiment_json = EXCLUDED.sentiment_json,
        language = EXCLUDED.language,
        provider = EXCLUDED.provider,
        model = EXCLUDED.model,
        updated_at = now()
      `,
      [
        analysis.callId,
        analysis.source,
        analysis.mediaUrlSanitized,
        analysis.transcriptText,
        analysis.transcriptJson,
        analysis.sentimentLabel,
        analysis.sentimentScore,
        analysis.sentimentJson,
        analysis.language,
        analysis.provider,
        analysis.model
      ]
    );

    if (String(process.env.DELETE_AUDIO_AFTER_TRANSCRIBE || "true").toLowerCase() !== "false") {
      await purgeLocalAudio(resolvedCallId);
    }

    const stored = await query(
      `
      SELECT
        call_id,
        source,
        media_url_sanitized,
        transcript_text,
        transcript_json,
        sentiment_label,
        sentiment_score,
        sentiment_json,
        language,
        provider,
        model,
        created_at,
        updated_at
      FROM call_analysis
      WHERE call_id = $1
      `,
      [resolvedCallId]
    );

    return res.json({ reused: false, analysis: enrichAnalysisRow(stored.rows?.[0]) });
  } catch (error) {
    console.error("analysis_transcribe_failed", error.message);
    if (isWfoUnauthorized(error)) {
      clearWfoSession();
      return res.status(401).json({ error: "wfo_session_expired" });
    }
    const message = String(error.message || "");
    if (message === "openai_not_configured") return res.status(400).json({ error: "openai_not_configured" });
    if (message === "ollama_unavailable") return res.status(400).json({ error: "ollama_unavailable" });
    if (message === "ollama_model_not_found") return res.status(400).json({ error: "ollama_model_not_found" });
    if (message === "sentiment_provider_not_configured") return res.status(400).json({ error: "sentiment_provider_not_configured" });
    if (message === "call_not_found") return res.status(404).json({ error: "call_not_found" });
    if (message === "wfo_session_not_configured") return res.status(400).json({ error: "wfo_session_not_configured" });
    if (message === "audio_not_found") return res.status(404).json({ error: "audio_not_found" });
    return res.status(500).json({ error: "analysis_transcribe_failed" });
  }
});

export default router;
