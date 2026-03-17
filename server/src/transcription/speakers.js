function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function speakerFlip(speaker) {
  return speaker === "agent" ? "patient" : "agent";
}

function inferOpeningSpeaker(segments) {
  const first = normalizeText(segments?.[0]?.text);
  const second = normalizeText(segments?.[1]?.text);
  const agentPatterns = [
    /\bthank you for calling\b/i,
    /\bthis is\b/i,
    /\bgeorgia urology\b/i,
    /\bhow can i help\b/i,
    /\bcalling from\b/i,
    /\bmy name is\b/i
  ];
  const patientGreetingPatterns = [
    /^(hello|hi|hey|good morning|good afternoon|good evening)[.!?]*$/i,
    /^(hello|hi)[,!.?]?\s+(yes|yeah|uh-huh|speaking)\b/i
  ];

  if (agentPatterns.some((pattern) => pattern.test(first))) return "agent";
  if (patientGreetingPatterns.some((pattern) => pattern.test(first)) && agentPatterns.some((pattern) => pattern.test(second))) {
    return "patient";
  }
  if (segments?.[0]?.start === 0 || segments?.[0]?.start === null || segments?.[0]?.start === undefined) {
    return "agent";
  }
  return "patient";
}

function flattenSegments(transcriptJson) {
  if (!transcriptJson) return [];

  if (Array.isArray(transcriptJson.segments)) {
    return transcriptJson.segments
      .map((segment, index) => ({
        id: segment?.id ?? index,
        start: typeof segment?.start === "number" ? segment.start : null,
        end: typeof segment?.end === "number" ? segment.end : null,
        text: normalizeText(segment?.text)
      }))
      .filter((segment) => segment.text);
  }

  if (transcriptJson.segmented && Array.isArray(transcriptJson.segments)) {
    const segmentSeconds = Number(transcriptJson.segmentSeconds || 0);
    const flattened = [];
    transcriptJson.segments.forEach((chunk, chunkIndex) => {
      const offset = segmentSeconds > 0 ? chunkIndex * segmentSeconds : 0;
      const nestedSegments = Array.isArray(chunk?.response?.segments) ? chunk.response.segments : [];
      nestedSegments.forEach((segment, segmentIndex) => {
        flattened.push({
          id: `${chunkIndex}-${segment?.id ?? segmentIndex}`,
          start: typeof segment?.start === "number" ? segment.start + offset : offset,
          end: typeof segment?.end === "number" ? segment.end + offset : null,
          text: normalizeText(segment?.text)
        });
      });
    });
    return flattened.filter((segment) => segment.text);
  }

  return [];
}

export function separateTranscriptSpeakers({ transcriptText, transcriptJson }) {
  const combinedText = normalizeText(transcriptText);
  const flattenedSegments = flattenSegments(transcriptJson);

  if (!flattenedSegments.length) {
    return {
      strategy: "heuristic_segments_v1",
      confidence: "low",
      turns: combinedText
        ? [
            {
              id: 0,
              speaker: "agent",
              start: null,
              end: null,
              text: combinedText
            }
          ]
        : [],
      agent_text: combinedText || null,
      patient_text: null
    };
  }

  let activeSpeaker = inferOpeningSpeaker(flattenedSegments);
  const turns = [];

  flattenedSegments.forEach((segment, index) => {
    const prev = flattenedSegments[index - 1];
    const gap = prev && typeof segment.start === "number" && typeof prev.end === "number" ? segment.start - prev.end : 0;
    const text = segment.text;
    const wordCount = text.split(/\s+/).filter(Boolean).length;

    if (index > 0) {
      const textLooksLikeAgent = /\b(this is|thank you for calling|calling from|office)\b/i.test(text);
      const textLooksLikePatient = /\b(i need|i'm calling|my appointment|i was told|can you)\b/i.test(text);
      const looksLikeBackchannel = /^(hi|hello|yes|yeah|okay|ok|all right|thank you|thanks|one second)[.!?]*$/i.test(text);

      if (textLooksLikeAgent) {
        activeSpeaker = "agent";
      } else if (textLooksLikePatient) {
        activeSpeaker = "patient";
      } else if (looksLikeBackchannel || wordCount <= 4) {
        activeSpeaker = speakerFlip(activeSpeaker);
      } else if (gap >= 1.2) {
        activeSpeaker = speakerFlip(activeSpeaker);
      }
    }

    turns.push({
      id: segment.id ?? index,
      speaker: activeSpeaker,
      start: segment.start,
      end: segment.end,
      text
    });
  });

  const agentText = turns
    .filter((turn) => turn.speaker === "agent")
    .map((turn) => turn.text)
    .join(" ")
    .trim();
  const patientText = turns
    .filter((turn) => turn.speaker === "patient")
    .map((turn) => turn.text)
    .join(" ")
    .trim();

  return {
    strategy: "heuristic_segments_v1",
    confidence: "low",
    turns,
    agent_text: agentText || null,
    patient_text: patientText || null
  };
}
