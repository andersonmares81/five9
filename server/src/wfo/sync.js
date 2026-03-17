import { fetchInteractionRecordings, fetchInteractionRecordingsByUrl } from "./client.js";
import { withClient } from "../db.js";

function toIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function pick(record, keys) {
  for (const key of keys) {
    if (record?.[key] !== undefined && record?.[key] !== null) return record[key];
  }
  return null;
}

function parseDuration(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.round(value) : null;
  }
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) {
    return Math.round(Number(text));
  }
  const parts = text.split(":").map((part) => Number(part));
  if (parts.some((part) => Number.isNaN(part))) return null;
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return null;
}

function normalizeDirection(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.includes("\\") || text.includes("/")) return null;
  const upper = text.toUpperCase();
  if (upper === "O" || upper === "OUTBOUND") return "Outbound";
  if (upper === "I" || upper === "INBOUND") return "Inbound";
  return text;
}

function normalizeWfo(record) {
  const callId = String(pick(record, ["EVENT_NUM", "event_num", "EventNum", "EVENTNUM", "ID", "id"]) || "").trim();
  const agentName = pick(record, ["AGENT_NAME", "agent_name", "AgentName"]);
  const agentFirst = pick(record, ["AGENT_FNAME", "agent_fname", "AgentFName"]);
  const agentLast = pick(record, ["AGENT_LNAME", "agent_lname", "AgentLName"]);
  const campaignName = pick(record, ["CAMPAIGN_NAME", "campaign_name", "CampaignName"]);
  const startTime = toIso(pick(record, ["START_TIME", "start_time", "StartTime", "DATE_TIME", "DateTime"]));
  const endTime = toIso(pick(record, ["END_TIME", "end_time", "EndTime"]));
  const durationRaw = pick(record, [
    "CALL_DURATION",
    "EVENT_DURATION",
    "DURATION",
    "duration",
    "Duration",
    "CALL_TIME",
    "call_time"
  ]);
  let durationSec = parseDuration(durationRaw);
  if (durationSec === null && startTime && endTime) {
    const diff = new Date(endTime).getTime() - new Date(startTime).getTime();
    if (!Number.isNaN(diff) && diff >= 0) {
      durationSec = Math.round(diff / 1000);
    }
  }
  const eventDir = normalizeDirection(
    pick(record, [
      "CALL_DIRECTION",
      "call_direction",
      "EVENT_DIRECTION",
      "EventDirection",
      "DIRECTION",
      "direction",
      "EVENT_DIR",
      "event_dir",
      "EventDir"
    ])
  );

  return {
    callId,
    agentId: pick(record, ["AGENT_ID", "agent_id", "AgentId"]),
    agentName: agentName || [agentFirst, agentLast].filter(Boolean).join(" ") || null,
    agentFirstName: agentFirst,
    agentLastName: agentLast,
    campaignId: pick(record, ["CAMPAIGN_ID", "campaign_id", "CampaignId"]),
    campaignName,
    callSessionId: pick(record, ["CALL_ID", "call_id", "CallId", "SESSION_ID", "session_id"]),
    extension: pick(record, ["EXT", "extension", "Extension"]),
    ani: pick(record, ["CALL_ANI", "ANI", "ani"]),
    dnis: pick(record, ["CALL_DNIS", "DNIS", "dnis"]),
    resultCode: pick(record, ["RESULT_CODE", "result_code", "EVENT_CODE", "event_code"]),
    screenCaptureType: pick(record, ["SCAP_TYPE", "scap_type", "SCREEN_CAPTURE_TYPE", "screen_capture_type"]),
    eventCode: pick(record, ["EVENT_CODE", "event_code", "EventCode"]),
    eventDir,
    startTime,
    endTime,
    durationSec,
    direction: eventDir,
    status: pick(record, ["STATUS", "status", "Status"]),
    recordingUrl: pick(record, ["MEDIA_URL", "MediaUrl", "media_url", "RECORDING_URL", "RecordingUrl"]),
    metadata: record
  };
}

export async function syncWfoInteractionRecordings({ pageNumber = 1, nextPageUrl = null, clientOptions = {} } = {}) {
  const response = nextPageUrl
    ? await fetchInteractionRecordingsByUrl(nextPageUrl, clientOptions)
    : await fetchInteractionRecordings({ pageNumber, ...clientOptions });
  const records = response?.Data || response?.data || response?.Records || response?.records || [];

  let inserted = 0;
  let skipped = 0;

  await withClient(async (client) => {
    for (const raw of records) {
      const call = normalizeWfo(raw);
      if (!call.callId) {
        skipped += 1;
        continue;
      }

      await client.query(
        `
        INSERT INTO calls (
          call_id, agent_id, agent_name, campaign_id, campaign_name,
          agent_first_name, agent_last_name,
          call_session_id, extension, ani, dnis, result_code, screen_capture_type,
          event_code, event_dir,
          recording_url,
          start_time, end_time, duration_sec, direction, status, metadata
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
        ON CONFLICT (call_id) DO UPDATE SET
          agent_id = EXCLUDED.agent_id,
          agent_name = EXCLUDED.agent_name,
          agent_first_name = EXCLUDED.agent_first_name,
          agent_last_name = EXCLUDED.agent_last_name,
          campaign_id = EXCLUDED.campaign_id,
          campaign_name = EXCLUDED.campaign_name,
          call_session_id = EXCLUDED.call_session_id,
          extension = EXCLUDED.extension,
          ani = EXCLUDED.ani,
          dnis = EXCLUDED.dnis,
          result_code = EXCLUDED.result_code,
          screen_capture_type = EXCLUDED.screen_capture_type,
          event_code = EXCLUDED.event_code,
          event_dir = EXCLUDED.event_dir,
          recording_url = COALESCE(EXCLUDED.recording_url, calls.recording_url),
          start_time = EXCLUDED.start_time,
          end_time = EXCLUDED.end_time,
          duration_sec = EXCLUDED.duration_sec,
          direction = EXCLUDED.direction,
          status = EXCLUDED.status,
          metadata = EXCLUDED.metadata,
          updated_at = now()
        `,
        [
          call.callId,
          call.agentId,
          call.agentName,
          call.campaignId,
          call.campaignName,
          call.agentFirstName,
          call.agentLastName,
          call.callSessionId,
          call.extension,
          call.ani,
          call.dnis,
          call.resultCode,
          call.screenCaptureType,
          call.eventCode,
          call.eventDir,
          call.recordingUrl,
          call.startTime,
          call.endTime,
          call.durationSec,
          call.direction,
          call.status,
          call.metadata
        ]
      );
      inserted += 1;
    }
  });

  return {
    inserted,
    skipped,
    count: records.length,
    pageNumber: response?.PageNumber || pageNumber,
    pageSize: response?.PageSize,
    totalPages: response?.TotalPages,
    totalRecords: response?.TotalRecords,
    nextPage: response?.NextPage || response?.nextPage || null
  };
}

export async function syncWfoInteractionRecordingsRange({
  from,
  to,
  order = "desc",
  maxPages = 50,
  startPage = 1,
  clientOptions = {}
} = {}) {
  let totalInserted = 0;
  let totalSkipped = 0;
  let lastResult = null;

  for (let pageNumber = startPage; pageNumber < startPage + maxPages; pageNumber += 1) {
    const result = await syncWfoInteractionRecordings({
      pageNumber,
      clientOptions: {
        ...clientOptions,
        payload: clientOptions.payload,
        pageSize: clientOptions.pageSize
      }
    });
    totalInserted += result.inserted;
    totalSkipped += result.skipped;
    lastResult = result;
    if (result.count === 0) break;
    if (result.pageSize && result.count < result.pageSize) break;
  }

  return {
    from,
    to,
    order,
    maxPages,
    inserted: totalInserted,
    skipped: totalSkipped,
    lastPage: lastResult?.pageNumber || null,
    totalRecords: lastResult?.totalRecords || null
  };
}
