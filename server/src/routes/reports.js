import express from "express";
import { query } from "../db.js";
import { authMiddleware } from "../auth.js";
import { storedMediaPathExists } from "../media/storage.js";

const router = express.Router();

function normalizeDateInput(value, isEnd) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return isEnd ? `${value}T23:59:59.999Z` : `${value}T00:00:00.000Z`;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function normalizeDateOnly(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function safeTimezone(value) {
  const fallback = "America/Bogota";
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  if (!/^[A-Za-z_\\/]+$/.test(raw)) return fallback;
  return raw;
}

function buildFilters({ from, to, agentId, campaignId }) {
  const conditions = [];
  const params = [];
  const fromValue = normalizeDateInput(from, false);
  const toValue = normalizeDateInput(to, true);

  if (fromValue) {
    params.push(fromValue);
    conditions.push(`start_time >= $${params.length}`);
  }
  if (toValue) {
    params.push(toValue);
    conditions.push(`start_time <= $${params.length}`);
  }
  if (agentId) {
    params.push(agentId);
    conditions.push(`agent_id = $${params.length}`);
  }
  if (campaignId) {
    params.push(campaignId);
    conditions.push(`campaign_id = $${params.length}`);
  }
  return { where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "", params };
}

router.get("/summary", authMiddleware, async (req, res) => {
  try {
    const { from, to, agentId, campaignId } = req.query;
    const { where, params } = buildFilters({ from, to, agentId, campaignId });

    const result = await query(
      `
      SELECT
        COUNT(*)::int AS total_calls,
        COALESCE(AVG(duration_sec), 0)::int AS avg_duration_sec,
        COUNT(*) FILTER (WHERE status ILIKE '%answered%')::int AS answered_calls,
        COUNT(*) FILTER (WHERE status ILIKE '%missed%')::int AS missed_calls
      FROM calls
      ${where}
      `,
      params
    );

    return res.json(result.rows[0] || {
      total_calls: 0,
      avg_duration_sec: 0,
      answered_calls: 0,
      missed_calls: 0
    });
  } catch (error) {
    console.error("reports_summary_failed", error.message);
    return res.status(500).json({ error: "reports_summary_failed" });
  }
});

router.get("/calls", authMiddleware, async (req, res) => {
  try {
    const { from, to, agentId, campaignId, limit = "50", offset = "0" } = req.query;
    const { where, params } = buildFilters({ from, to, agentId, campaignId });
    params.push(Number(limit));
    params.push(Number(offset));

    const result = await query(
      `
      SELECT
        calls.call_id,
        calls.agent_id,
        calls.agent_name,
        calls.agent_first_name,
        calls.agent_last_name,
        calls.campaign_id,
        calls.campaign_name,
        calls.call_session_id,
        calls.extension,
        calls.ani,
        calls.dnis,
        calls.result_code,
        calls.screen_capture_type,
        calls.event_code,
        calls.event_dir,
        calls.start_time,
        calls.end_time,
        calls.duration_sec,
        calls.direction,
        calls.status,
        calls.local_audio_path,
        calls.local_audio_cached_at,
        calls.local_audio_purged_at,
        (calls.local_audio_path IS NOT NULL AND calls.local_audio_purged_at IS NULL) AS has_local_audio,
        calls.local_screen_path,
        calls.local_screen_cached_at,
        (calls.local_screen_path IS NOT NULL) AS has_local_screen,
        COALESCE(calls.recording_id, cr.recording_id) AS recording_id,
        COALESCE(calls.recording_url, NULL) AS recording_url,
        EXISTS (
          SELECT 1
          FROM call_analysis ca
          WHERE ca.call_id = calls.call_id
        ) AS analysis_ready,
        CASE
          WHEN COALESCE(calls.recording_id, cr.recording_id) IS NOT NULL
            AND COALESCE(cr.agent_id, calls.agent_id) IS NOT NULL
          THEN '/api/recordings/' || COALESCE(cr.agent_id, calls.agent_id) || '/' || COALESCE(calls.recording_id, cr.recording_id)
          ELSE NULL
        END AS recording_link
      FROM calls
      LEFT JOIN call_recordings cr
        ON (cr.call_session_id = calls.call_id OR cr.recording_id = calls.recording_id)
      ${where}
      ORDER BY
        CASE
          WHEN EXISTS (
            SELECT 1
            FROM call_analysis ca
            WHERE ca.call_id = calls.call_id
          ) THEN 3
          WHEN (calls.local_audio_path IS NOT NULL AND calls.local_audio_purged_at IS NULL)
            AND calls.local_screen_path IS NOT NULL THEN 2
          WHEN (calls.local_audio_path IS NOT NULL AND calls.local_audio_purged_at IS NULL)
            OR calls.local_screen_path IS NOT NULL THEN 1
          ELSE 0
        END DESC,
        start_time DESC NULLS LAST
      LIMIT $${params.length - 1}
      OFFSET $${params.length}
      `,
      params
    );

    const calls = (result.rows || []).map((row) => {
      const hasLocalAudio = storedMediaPathExists(row.local_audio_path) && !row.local_audio_purged_at;
      const hasLocalScreen = storedMediaPathExists(row.local_screen_path);
      return {
        ...row,
        has_local_audio: hasLocalAudio,
        has_local_screen: hasLocalScreen
      };
    });

    return res.json({ calls });
  } catch (error) {
    console.error("reports_calls_failed", error.message);
    return res.status(500).json({ error: "reports_calls_failed" });
  }
});

router.get("/metrics", authMiddleware, async (req, res) => {
  try {
    const { from, to, agentId, campaignId } = req.query;
    const { where, params } = buildFilters({ from, to, agentId, campaignId });

    const result = await query(
      `
      SELECT
        COUNT(*)::int AS total_calls,
        MIN(start_time) AS first_call_start_time,
        MAX(start_time) AS last_call_start_time
      FROM calls
      ${where}
      `,
      params
    );

    return res.json(result.rows[0] || {
      total_calls: 0,
      first_call_start_time: null,
      last_call_start_time: null
    });
  } catch (error) {
    console.error("reports_metrics_failed", error.message);
    return res.status(500).json({ error: "reports_metrics_failed" });
  }
});

router.get("/agents-daily", authMiddleware, async (req, res) => {
  try {
    const tz = safeTimezone(process.env.REPORTS_TIMEZONE || process.env.BACKUP_TIMEZONE);
    const fromDate = normalizeDateOnly(req.query.from);
    const toDate = normalizeDateOnly(req.query.to);

    if (!fromDate || !toDate) {
      return res.status(400).json({ error: "invalid_date_range" });
    }

    const result = await query(
      `
      SELECT
        agent_id,
        COALESCE(
          NULLIF(TRIM(agent_name), ''),
          NULLIF(TRIM(CONCAT_WS(' ', agent_first_name, agent_last_name)), ''),
          agent_id
        ) AS agent_label,
        ((start_time AT TIME ZONE '${tz}')::date)::text AS day,
        COUNT(*)::int AS total_calls
      FROM calls
      WHERE start_time IS NOT NULL
        AND agent_id IS NOT NULL
        AND (start_time AT TIME ZONE '${tz}')::date >= $1
        AND (start_time AT TIME ZONE '${tz}')::date <= $2
      GROUP BY 1,2,3
      ORDER BY agent_label ASC, day ASC
      `,
      [fromDate, toDate]
    );

    return res.json({ from: fromDate, to: toDate, timezone: tz, rows: result.rows || [] });
  } catch (error) {
    console.error("reports_agents_daily_failed", error.message);
    return res.status(500).json({ error: "reports_agents_daily_failed" });
  }
});

router.get("/campaigns-daily", authMiddleware, async (req, res) => {
  try {
    const tz = safeTimezone(process.env.REPORTS_TIMEZONE || process.env.BACKUP_TIMEZONE);
    const fromDate = normalizeDateOnly(req.query.from);
    const toDate = normalizeDateOnly(req.query.to);

    if (!fromDate || !toDate) {
      return res.status(400).json({ error: "invalid_date_range" });
    }

    const result = await query(
      `
      SELECT
        campaign_id,
        COALESCE(NULLIF(TRIM(campaign_name), ''), campaign_id) AS campaign_label,
        ((start_time AT TIME ZONE '${tz}')::date)::text AS day,
        COUNT(*)::int AS total_calls
      FROM calls
      WHERE start_time IS NOT NULL
        AND campaign_id IS NOT NULL
        AND (start_time AT TIME ZONE '${tz}')::date >= $1
        AND (start_time AT TIME ZONE '${tz}')::date <= $2
      GROUP BY 1,2,3
      ORDER BY campaign_label ASC, day ASC
      `,
      [fromDate, toDate]
    );

    return res.json({ from: fromDate, to: toDate, timezone: tz, rows: result.rows || [] });
  } catch (error) {
    console.error("reports_campaigns_daily_failed", error.message);
    return res.status(500).json({ error: "reports_campaigns_daily_failed" });
  }
});

export default router;
