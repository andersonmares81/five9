import { createFive9Client } from "./client.js";
import { query, withClient } from "../db.js";

const five9 = createFive9Client();

function toIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function normalizeCall(raw) {
  const callId = String(raw.callId || raw.id || raw.interactionId || "").trim();
  return {
    callId,
    callSessionId: raw.callSessionId || raw.sessionId || raw.SessionID || null,
    agentId: raw.agentId || raw.agent?.id || null,
    agentName: raw.agentName || raw.agent?.name || null,
    campaignId: raw.campaignId || raw.campaign?.id || null,
    campaignName: raw.campaignName || raw.campaign?.name || null,
    extension: raw.extension || raw.ext || raw.EXT || null,
    ani: raw.ani || raw.ANI || null,
    dnis: raw.dnis || raw.DNIS || null,
    eventCode: raw.eventCode || raw.event_code || raw.EVENT_CODE || null,
    eventDir: raw.eventDir || raw.event_dir || raw.EVENT_DIR || null,
    recordingId: raw.recordingId || raw.recording_id || raw.RECORDING_ID || null,
    recordingUrl: raw.recordingUrl || raw.recording_url || raw.mediaUrl || raw.MediaUrl || null,
    startTime: toIso(raw.startTime || raw.callStartTime || raw.startedAt),
    endTime: toIso(raw.endTime || raw.callEndTime || raw.endedAt),
    durationSec: raw.durationSec || raw.duration || raw.callDuration || null,
    direction: raw.direction || raw.callDirection || null,
    status: raw.status || raw.state || null,
    metadata: raw
  };
}

function normalizeRecording(raw, agentId) {
  return {
    recordingId: raw.id || raw.recordingId || raw.recording_id || null,
    callSessionId: raw.callSessionId || raw.sessionId || raw.callId || raw.call_id || null,
    campaignId: raw.campaignId || raw.campaign_id || null,
    created: toIso(raw.created || raw.createdAt || raw.startTime),
    lengthMs: raw.length || raw.lengthMs || raw.durationMs || null,
    name: raw.name || null,
    number: raw.number || raw.phone || null,
    agentId,
    metadata: raw
  };
}

export async function syncCalls({ from, to, agentId, campaignId } = {}) {
  const path = process.env.FIVE9_CALLS_PATH;
  if (!path) {
    return { inserted: 0, skipped: 0, message: "FIVE9_CALLS_PATH not configured" };
  }

  const params = {};
  if (from) params.from = from;
  if (to) params.to = to;
  if (agentId) params.agentId = agentId;
  if (campaignId) params.campaignId = campaignId;

  const response = await five9.request(path, { params });
  const calls = Array.isArray(response?.calls)
    ? response.calls
    : Array.isArray(response)
      ? response
      : [];

  let inserted = 0;
  let skipped = 0;

  await withClient(async (client) => {
    for (const raw of calls) {
      const call = normalizeCall(raw);
      if (!call.callId) {
        skipped += 1;
        continue;
      }
      const result = await client.query(
        `
        INSERT INTO calls (
          call_id, agent_id, agent_name, campaign_id, campaign_name,
          call_session_id, extension, ani, dnis, event_code, event_dir,
          recording_id, recording_url,
          start_time, end_time, duration_sec, direction, status, metadata
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
        ON CONFLICT (call_id) DO UPDATE SET
          agent_id = EXCLUDED.agent_id,
          agent_name = EXCLUDED.agent_name,
          campaign_id = EXCLUDED.campaign_id,
          campaign_name = EXCLUDED.campaign_name,
          call_session_id = EXCLUDED.call_session_id,
          extension = EXCLUDED.extension,
          ani = EXCLUDED.ani,
          dnis = EXCLUDED.dnis,
          event_code = EXCLUDED.event_code,
          event_dir = EXCLUDED.event_dir,
          recording_id = COALESCE(EXCLUDED.recording_id, calls.recording_id),
          recording_url = COALESCE(EXCLUDED.recording_url, calls.recording_url),
          start_time = EXCLUDED.start_time,
          end_time = EXCLUDED.end_time,
          duration_sec = EXCLUDED.duration_sec,
          direction = EXCLUDED.direction,
          status = EXCLUDED.status,
          metadata = EXCLUDED.metadata,
          updated_at = now()
        RETURNING call_id
        `,
        [
          call.callId,
          call.agentId,
          call.agentName,
          call.campaignId,
          call.campaignName,
          call.callSessionId,
          call.extension,
          call.ani,
          call.dnis,
          call.eventCode,
          call.eventDir,
          call.recordingId,
          call.recordingUrl,
          call.startTime,
          call.endTime,
          call.durationSec,
          call.direction,
          call.status,
          call.metadata
        ]
      );
      if (result.rowCount > 0) inserted += 1;
    }
  });

  return { inserted, skipped };
}

function parseRecordingOptions() {
  if (process.env.FIVE9_RECORDING_VIEW_OPTIONS_JSON) {
    try {
      return JSON.parse(process.env.FIVE9_RECORDING_VIEW_OPTIONS_JSON);
    } catch (error) {
      throw new Error("Invalid FIVE9_RECORDING_VIEW_OPTIONS_JSON");
    }
  }
  return { limit: 100 };
}

export async function syncRecordings() {
  const supervisorId = process.env.FIVE9_SUPERVISOR_ID;
  const agentIds = (process.env.FIVE9_AGENT_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (!supervisorId || agentIds.length === 0) {
    return { inserted: 0, skipped: 0, message: "FIVE9_SUPERVISOR_ID or FIVE9_AGENT_IDS not configured" };
  }

  const options = parseRecordingOptions();
  let inserted = 0;
  let skipped = 0;

  for (const agentId of agentIds) {
    const view = await five9.request(
      `/supervisors/${supervisorId}/agents/${agentId}/recording_views`,
      { method: "POST", data: options, context: "sup" }
    );

    const records = Array.isArray(view?.records) ? view.records : [];
    await withClient(async (client) => {
      for (const raw of records) {
        const recording = normalizeRecording(raw, agentId);
        if (!recording.recordingId) {
          skipped += 1;
          continue;
        }
        await client.query(
          `
          INSERT INTO call_recordings (
            recording_id, agent_id, call_session_id, campaign_id,
            created, length_ms, name, number, metadata
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT (recording_id) DO UPDATE SET
            agent_id = EXCLUDED.agent_id,
            call_session_id = EXCLUDED.call_session_id,
            campaign_id = EXCLUDED.campaign_id,
            created = EXCLUDED.created,
            length_ms = EXCLUDED.length_ms,
            name = EXCLUDED.name,
            number = EXCLUDED.number,
            metadata = EXCLUDED.metadata,
            updated_at = now()
          `,
          [
            recording.recordingId,
            recording.agentId,
            recording.callSessionId,
            recording.campaignId,
            recording.created,
            recording.lengthMs,
            recording.name,
            recording.number,
            recording.metadata
          ]
        );
        inserted += 1;
      }
    });

    if (view?.id) {
      await five9.request(
        `/supervisors/${supervisorId}/agents/${agentId}/recording_views/${view.id}`,
        { method: "DELETE", context: "sup" }
      );
    }
  }

  await linkRecordingsToCalls();
  return { inserted, skipped };
}

async function linkRecordingsToCalls() {
  await query(
    `
    UPDATE calls
    SET recording_id = cr.recording_id
    FROM call_recordings cr
    WHERE (calls.call_id = cr.call_session_id OR calls.call_id = cr.recording_id)
      AND calls.recording_id IS NULL
    `
  );
}

export async function getRealtimeAgents() {
  const path = process.env.FIVE9_REALTIME_PATH;
  if (!path) {
    return { agents: [], message: "FIVE9_REALTIME_PATH not configured" };
  }
  const response = await five9.request(path);
  return { agents: response?.agents || response || [] };
}

export async function refreshAggregates({ from, to } = {}) {
  const conditions = [];
  const params = [];
  if (from) {
    params.push(from);
    conditions.push(`start_time >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    conditions.push(`start_time <= $${params.length}`);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const sql = `
    INSERT INTO call_aggregates (day, total_calls, avg_duration_sec, answered_calls, missed_calls)
    SELECT
      date_trunc('day', start_time)::date AS day,
      COUNT(*) AS total_calls,
      COALESCE(AVG(duration_sec), 0)::int AS avg_duration_sec,
      COUNT(*) FILTER (WHERE status ILIKE '%answered%') AS answered_calls,
      COUNT(*) FILTER (WHERE status ILIKE '%missed%') AS missed_calls
    FROM calls
    ${whereClause}
    GROUP BY 1
    ON CONFLICT (day) DO UPDATE SET
      total_calls = EXCLUDED.total_calls,
      avg_duration_sec = EXCLUDED.avg_duration_sec,
      answered_calls = EXCLUDED.answered_calls,
      missed_calls = EXCLUDED.missed_calls,
      updated_at = now()
  `;

  await query(sql, params);
}
