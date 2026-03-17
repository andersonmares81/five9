import axios from "axios";
import { query } from "../db.js";
import { separateTranscriptSpeakers } from "../transcription/speakers.js";
import { getDayBackupCursor, setDayBackupCursor } from "./state.js";

function formatDateTimeForMySql(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (part) => String(part).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(
    date.getUTCHours()
  )}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function normalizeRow(row) {
  const rawJson = row.raw_json ?? row.metadata ?? null;
  const enrichedTranscriptJson =
    row.transcript_text || row.transcript_json
      ? {
          ...(row.transcript_json ?? {}),
          speaker_separation:
            row.transcript_json?.speaker_separation ||
            separateTranscriptSpeakers({
              transcriptText: row.transcript_text ?? "",
              transcriptJson: row.transcript_json ?? null
            })
        }
      : null;
  return {
    call_id: row.call_id,
    agent_id: row.agent_id,
    agent_name: row.agent_name ?? null,
    agent_first_name: row.agent_first_name,
    agent_last_name: row.agent_last_name,
    campaign_id: row.campaign_id ?? null,
    campaign_name: row.campaign_name ?? null,
    call_session_id: row.call_session_id ?? null,
    extension: row.extension ?? null,
    event_dir: row.event_dir,
    event_code: row.event_code ?? null,
    direction: row.direction ?? null,
    status: row.status ?? null,
    recording_id: row.recording_id ?? null,
    recording_url: row.recording_url ?? null,
    start_time: formatDateTimeForMySql(row.start_time),
    end_time: formatDateTimeForMySql(row.end_time),
    duration_sec: row.duration_sec ?? null,
    ani: row.ani ?? null,
    dnis: row.dnis ?? null,
    result_code: row.result_code ?? null,
    screen_capture_type: row.screen_capture_type ?? null,
    local_media: {
      audio_path: row.local_audio_path ?? null,
      audio_source_url: row.local_audio_source_url ?? null,
      audio_cached_at: row.local_audio_cached_at ? row.local_audio_cached_at.toISOString() : null,
      audio_purged_at: row.local_audio_purged_at ? row.local_audio_purged_at.toISOString() : null,
      screen_path: row.local_screen_path ?? null,
      screen_source_url: row.local_screen_source_url ?? null,
      screen_cached_at: row.local_screen_cached_at ? row.local_screen_cached_at.toISOString() : null
    },
    analysis: row.transcript_text || row.sentiment_json
      ? {
          transcript_text: row.transcript_text ?? null,
          transcript_json: enrichedTranscriptJson,
          sentiment_label: row.sentiment_label ?? null,
          sentiment_score: row.sentiment_score ?? null,
          sentiment_json: row.sentiment_json ?? null,
          language: row.language ?? null,
          provider: row.provider ?? null,
          model: row.model ?? null,
          updated_at: row.analysis_updated_at ? row.analysis_updated_at.toISOString() : null
        }
      : null,
    raw_json: rawJson
  };
}

const CHANGE_TS_SQL =
  "GREATEST(calls.updated_at, COALESCE(calls.local_media_updated_at, 'epoch'::timestamptz), COALESCE(ca.updated_at, 'epoch'::timestamptz))";

function dayIsoRange(date) {
  if (!date || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(String(date))) return null;
  const tzOffset = process.env.BACKUP_TZ_OFFSET || "-05:00";
  const from = new Date(`${date}T00:00:00.000${tzOffset}`);
  const to = new Date(`${date}T23:59:59.999${tzOffset}`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  return { from: from.toISOString(), to: to.toISOString() };
}

export async function pushBackupRange({ from, to, endpoint, pageSize = 500, report = null }) {
  if (!endpoint) {
    throw new Error("BACKUP_ENDPOINT not configured");
  }
  if (!from || !to) {
    throw new Error("Backup range requires from/to");
  }

  const totalResult = await query(
    `
    SELECT COUNT(*)::int AS total
    FROM calls
    WHERE start_time >= $1 AND start_time <= $2
    `,
    [from, to]
  );
  const totalRows = Number(totalResult.rows?.[0]?.total || 0);

  let offset = 0;
  let total = 0;
  let batches = 0;

  if (typeof report === "function") {
    report({
      from,
      to,
      total: totalRows,
      done: 0,
      pushed: 0,
      batches: 0
    });
  }

  while (true) {
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
        calls.event_dir,
        calls.event_code,
        calls.direction,
        calls.status,
        calls.recording_id,
        calls.recording_url,
        calls.start_time,
        calls.end_time,
        calls.duration_sec,
        calls.ani,
        calls.dnis,
        calls.result_code,
        calls.screen_capture_type,
        calls.local_audio_path,
        calls.local_audio_source_url,
        calls.local_audio_cached_at,
        calls.local_audio_purged_at,
        calls.local_screen_path,
        calls.local_screen_source_url,
        calls.local_screen_cached_at,
        calls.metadata AS raw_json,
        ca.transcript_text,
        ca.transcript_json,
        ca.sentiment_label,
        ca.sentiment_score,
        ca.sentiment_json,
        ca.language,
        ca.provider,
        ca.model,
        ca.updated_at AS analysis_updated_at
      FROM calls
      LEFT JOIN call_analysis ca ON ca.call_id = calls.call_id
      WHERE calls.start_time >= $1 AND calls.start_time <= $2
      ORDER BY calls.start_time ASC NULLS LAST
      LIMIT $3 OFFSET $4
      `,
      [from, to, pageSize, offset]
    );

    const rows = result.rows || [];
    if (rows.length === 0) break;

    const payload = { calls: rows.map(normalizeRow) };
    const response = await axios.post(endpoint, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 30000
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Backup endpoint error: ${response.status}`);
    }

    total += rows.length;
    offset += rows.length;
    batches += 1;

    if (typeof report === "function") {
      report({
        from,
        to,
        total: totalRows,
        done: offset,
        pushed: total,
        batches,
        lastBatch: rows.length,
        lastResponseInserted: Number(response.data?.inserted || rows.length)
      });
    }

    if (rows.length < pageSize) break;
  }

  return total;
}

export async function pushBackupDayChanges({ date, endpoint, pageSize = 500, report = null }) {
  if (!endpoint) {
    throw new Error("BACKUP_ENDPOINT not configured");
  }
  const range = dayIsoRange(date);
  if (!range) {
    throw new Error("invalid_date");
  }

  const cursor = getDayBackupCursor(date);
  const sinceChangedAt = cursor.changedAt || "1970-01-01T00:00:00.000Z";
  const sinceCallId = cursor.callId || "";

  const totalResult = await query(
    `
    SELECT COUNT(*)::int AS total
    FROM calls
    LEFT JOIN call_analysis ca ON ca.call_id = calls.call_id
    WHERE calls.start_time >= $1 AND calls.start_time <= $2
      AND (${CHANGE_TS_SQL}, calls.call_id) > ($3::timestamptz, $4::text)
    `,
    [range.from, range.to, sinceChangedAt, sinceCallId]
  );
  const totalRows = Number(totalResult.rows?.[0]?.total || 0);

  let pushed = 0;
  let batches = 0;
  let lastChangedAt = sinceChangedAt;
  let lastCallId = sinceCallId;

  if (typeof report === "function") {
    report({
      date,
      from: range.from,
      to: range.to,
      total: totalRows,
      done: 0,
      pushed: 0,
      batches: 0,
      sinceChangedAt,
      sinceCallId
    });
  }

  while (true) {
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
        calls.event_dir,
        calls.event_code,
        calls.direction,
        calls.status,
        calls.recording_id,
        calls.recording_url,
        calls.start_time,
        calls.end_time,
        calls.duration_sec,
        calls.ani,
        calls.dnis,
        calls.result_code,
        calls.screen_capture_type,
        calls.local_audio_path,
        calls.local_audio_source_url,
        calls.local_audio_cached_at,
        calls.local_audio_purged_at,
        calls.local_screen_path,
        calls.local_screen_source_url,
        calls.local_screen_cached_at,
        calls.metadata AS raw_json,
        ca.transcript_text,
        ca.transcript_json,
        ca.sentiment_label,
        ca.sentiment_score,
        ca.sentiment_json,
        ca.language,
        ca.provider,
        ca.model,
        ca.updated_at AS analysis_updated_at,
        ${CHANGE_TS_SQL} AS changed_at
      FROM calls
      LEFT JOIN call_analysis ca ON ca.call_id = calls.call_id
      WHERE calls.start_time >= $1 AND calls.start_time <= $2
        AND (${CHANGE_TS_SQL}, calls.call_id) > ($3::timestamptz, $4::text)
      ORDER BY changed_at ASC, calls.call_id ASC
      LIMIT $5
      `,
      [range.from, range.to, lastChangedAt, lastCallId, pageSize]
    );

    const rows = result.rows || [];
    if (rows.length === 0) break;

    const payload = { calls: rows.map(normalizeRow) };
    const response = await axios.post(endpoint, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 30000
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Backup endpoint error: ${response.status}`);
    }

    pushed += rows.length;
    batches += 1;

    const last = rows[rows.length - 1];
    lastChangedAt = last?.changed_at ? new Date(last.changed_at).toISOString() : lastChangedAt;
    lastCallId = last?.call_id ? String(last.call_id) : lastCallId;

    // Persist the cursor after each successful batch so resumes are safe.
    setDayBackupCursor(date, { changedAt: lastChangedAt, callId: lastCallId });

    if (typeof report === "function") {
      report({
        date,
        from: range.from,
        to: range.to,
        total: totalRows,
        done: pushed,
        pushed,
        batches,
        lastBatch: rows.length,
        lastResponseInserted: Number(response.data?.inserted || rows.length),
        cursorChangedAt: lastChangedAt,
        cursorCallId: lastCallId
      });
    }

    if (rows.length < pageSize) break;
  }

  // Ensure cursor is stored even when nothing changed (no-op run).
  if (pushed === 0 && cursor.changedAt && cursor.callId) {
    setDayBackupCursor(date, { changedAt: cursor.changedAt, callId: cursor.callId });
  }

  return {
    pushed,
    date,
    from: range.from,
    to: range.to,
    sinceChangedAt,
    sinceCallId,
    cursorChangedAt: lastChangedAt,
    cursorCallId: lastCallId
  };
}
