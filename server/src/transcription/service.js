import fs from "fs";
import path from "path";
import { query } from "../db.js";
import { createFive9Client } from "../five9/client.js";
import { getStoredMedia } from "../media/storage.js";
import { getWfoSession } from "../wfo/session.js";
import { resolveWfoPlayerMedia } from "../wfo/player.js";
import { prepareInteractionRecordingMedia } from "../wfo/prepare.js";
import { cleanupFiles, downloadUrlToFile, probeDurationSeconds, splitAudioToMp3Segments, writeStreamToFile } from "./audio.js";
import { mergeDetailedCallAnalysis } from "./analysis-report.js";
import { analyzeTranscript, transcribeFile } from "./providers.js";
import { separateTranscriptSpeakers } from "./speakers.js";

const five9 = createFive9Client();

function pickAudioCandidate(mediaList) {
  const media = Array.isArray(mediaList) ? mediaList : [];
  return media.find((item) => item.kind === "audio") || media[0] || null;
}

function guessExtFromUrl(urlValue) {
  if (!urlValue) return "bin";
  const lower = String(urlValue).toLowerCase();
  if (lower.includes(".mp3")) return "mp3";
  if (lower.includes(".wav")) return "wav";
  if (lower.includes(".m4a")) return "m4a";
  if (lower.includes(".aac")) return "aac";
  if (lower.includes(".mp4")) return "mp4";
  if (lower.includes(".webm")) return "webm";
  if (lower.includes(".m3u8")) return "m3u8";
  return "bin";
}

function sanitizeMediaUrl(urlValue) {
  try {
    const url = new URL(urlValue);
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

async function resolveCall(callId) {
  const result = await query(
    `
    SELECT
      call_id,
      agent_id,
      recording_id,
      recording_url
    FROM calls
    WHERE call_id = $1
    `,
    [callId]
  );
  return result.rows?.[0] || null;
}

async function resolveAudioForCall(call) {
  const localMedia = await getStoredMedia(call?.call_id);
  if (localMedia?.hasLocalAudio && localMedia.localAudioAbsolutePath) {
    return {
      source: "local",
      mediaUrl: null,
      mediaUrlSanitized: localMedia.local_audio_source_url || null,
      localPath: localMedia.localAudioAbsolutePath
    };
  }

  const recordingUrl = call?.recording_url || null;
  if (recordingUrl) {
    if (/\.(mp3|wav|m4a|aac|mp4|webm)(\?|$)/i.test(recordingUrl)) {
      return { source: "wfo", mediaUrl: recordingUrl, mediaUrlSanitized: sanitizeMediaUrl(recordingUrl) };
    }
    const session = getWfoSession();
    if (!session) throw new Error("wfo_session_not_configured");
    const resolved = await resolveWfoPlayerMedia({ recordingUrl, session });
    if (resolved?.error === "wfo_session_not_configured") throw new Error("wfo_session_not_configured");
    const candidate = pickAudioCandidate(resolved.media);
    if (!candidate?.url) throw new Error("audio_not_found");
    if (candidate.kind === "hls") throw new Error("audio_not_found");
    return { source: "wfo", mediaUrl: candidate.url, mediaUrlSanitized: sanitizeMediaUrl(candidate.url) };
  }

  const session = getWfoSession();
  if (session) {
    const prepared = await prepareInteractionRecordingMedia({
      eventNumber: call?.call_id,
      databaseCatalog: "ONLINE_DB",
      eventType: "Play",
      session
    });
    if (prepared.ok && prepared.audioUrl) {
      return {
        source: "wfo",
        mediaUrl: prepared.audioUrl,
        mediaUrlSanitized: sanitizeMediaUrl(prepared.audioUrl)
      };
    }
  }

  if (call?.agent_id && call?.recording_id) {
    return { source: "str", agentId: call.agent_id, recordingId: call.recording_id, mediaUrlSanitized: null };
  }

  throw new Error("audio_not_found");
}

async function transcribeWithSegmentation({ inputPath }) {
  const maxBytes = Number(process.env.TRANSCRIBE_MAX_BYTES || 24 * 1024 * 1024);
  const stat = fs.statSync(inputPath);
  if (stat.size <= maxBytes) {
    const { model, response } = await transcribeFile({ filePath: inputPath });
    const text = response?.text || "";
    return { model, text, json: response };
  }

  const duration = await probeDurationSeconds(inputPath);
  const segmentSeconds = Number(process.env.TRANSCRIBE_SEGMENT_SECONDS || 600);
  if (!duration) {
    const { model, response } = await transcribeFile({ filePath: inputPath });
    const text = response?.text || "";
    return { model, text, json: response };
  }

  const { dir, files } = await splitAudioToMp3Segments({ inputPath, segmentSeconds });
  const parts = [];
  const segmentJson = [];
  try {
    for (const file of files) {
      const fileStat = fs.statSync(file);
      if (fileStat.size > maxBytes) {
        const { model, response } = await transcribeFile({ filePath: file });
        parts.push(response?.text || "");
        segmentJson.push({ file: path.basename(file), model, response });
        continue;
      }
      const { model, response } = await transcribeFile({ filePath: file });
      parts.push(response?.text || "");
      segmentJson.push({ file: path.basename(file), model, response });
    }
  } finally {
    cleanupFiles([dir]);
  }

  return {
    model: process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1",
    text: parts.filter(Boolean).join("\n").trim(),
    json: { segmented: true, segmentSeconds, segments: segmentJson }
  };
}

export async function transcribeAndAnalyzeCall({ callId }) {
  const call = await resolveCall(callId);
  if (!call) throw new Error("call_not_found");

  const resolved = await resolveAudioForCall(call);

  const tempPaths = [];
  try {
    let inputPath = null;

    if (resolved.source === "local") {
      inputPath = resolved.localPath;
    } else if (resolved.source === "str") {
      const response = await five9.stream(`/agents/${resolved.agentId}/recordings/${resolved.recordingId}`, {
        context: "str"
      });
      const ext = "mp3";
      const written = await writeStreamToFile({ stream: response.data, fileExt: ext });
      inputPath = written.filePath;
      tempPaths.push(inputPath);
    } else {
      const ext = guessExtFromUrl(resolved.mediaUrl);
      const downloaded = await downloadUrlToFile({ url: resolved.mediaUrl, fileExt: ext });
      inputPath = downloaded.filePath;
      tempPaths.push(inputPath);
      if (!resolved.mediaUrlSanitized) resolved.mediaUrlSanitized = downloaded.urlSanitized;
    }

    const transcript = await transcribeWithSegmentation({ inputPath });
    const transcriptText = transcript.text || "";
    const speakerSeparation = separateTranscriptSpeakers({
      transcriptText,
      transcriptJson: transcript.json || null
    });
    const transcriptJson = transcript.json
      ? {
          ...transcript.json,
          speaker_separation: speakerSeparation
        }
      : {
          text: transcriptText,
          speaker_separation: speakerSeparation
        };
    const sentiment = transcriptText
      ? await analyzeTranscript({ transcriptText, speakerSeparation })
      : { provider: "heuristic", model: process.env.OPENAI_ANALYSIS_MODEL || "gpt-4o-mini", response: {} };
    const detailedAnalysis = mergeDetailedCallAnalysis({
      transcriptText,
      speakerSeparation,
      providerResponse: sentiment.response || {}
    });
    const sentimentLabel = detailedAnalysis.sentiment_label || null;
    const sentimentScore =
      typeof detailedAnalysis.sentiment_score === "number" ? detailedAnalysis.sentiment_score : null;
    const language = detailedAnalysis.language || null;

    return {
      callId: call.call_id,
      source: resolved.source,
      mediaUrlSanitized: resolved.mediaUrlSanitized,
      transcriptText,
      transcriptJson,
      sentimentLabel,
      sentimentScore,
      sentimentJson: detailedAnalysis || null,
      language,
      provider: `${transcript.provider || "unknown"}:${sentiment.provider || "unknown"}`,
      model: transcript.model
    };
  } catch (error) {
    if (String(error?.message || "") === "wfo_session_expired") throw error;
    throw error;
  } finally {
    cleanupFiles(tempPaths);
  }
}
