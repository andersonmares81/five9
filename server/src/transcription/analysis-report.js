function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(toNumber(value) * factor) / factor;
}

function firstSentences(text, maxSentences = 2) {
  const parts = String(text || "")
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.slice(0, maxSentences).join(" ").trim() || String(text || "").slice(0, 260).trim();
}

function countTerms(text, terms) {
  const padded = ` ${normalize(text)} `;
  return terms.reduce((count, term) => count + (padded.includes(` ${term} `) ? 1 : 0), 0);
}

function detectLanguage(text) {
  const sample = normalize(text);
  if (!sample) return "unknown";
  const spanishSignals = [" gracias ", " problema ", " llamada ", " cliente ", " por favor ", " cita ", " necesito "];
  const padded = ` ${sample} `;
  const spanishHits = spanishSignals.reduce((count, token) => count + (padded.includes(token) ? 1 : 0), 0);
  return spanishHits >= 2 ? "es" : "en";
}

function sentimentFromText(text) {
  const positiveTerms = [
    "good",
    "great",
    "excellent",
    "helpful",
    "resolved",
    "happy",
    "thanks",
    "thank you",
    "perfect",
    "amazing",
    "satisfied",
    "glad",
    "bien",
    "excelente",
    "gracias",
    "resuelto",
    "feliz"
  ];
  const negativeTerms = [
    "bad",
    "terrible",
    "angry",
    "upset",
    "issue",
    "problem",
    "cancel",
    "frustrated",
    "disappointed",
    "complaint",
    "waiting",
    "pain",
    "swollen",
    "mal",
    "problema",
    "frustrado",
    "queja"
  ];

  const positiveHits = countTerms(text, positiveTerms);
  const negativeHits = countTerms(text, negativeTerms);
  const totalSignals = positiveHits + negativeHits;

  let sentimentLabel = "neutral";
  let sentimentScore = 0;

  if (totalSignals > 0) {
    sentimentScore = clamp((positiveHits - negativeHits) / totalSignals, -1, 1);
    if (positiveHits > 0 && negativeHits > 0) {
      sentimentLabel = "mixed";
    } else if (sentimentScore > 0.2) {
      sentimentLabel = "positive";
    } else if (sentimentScore < -0.2) {
      sentimentLabel = "negative";
    }
  }

  return {
    sentiment_label: sentimentLabel,
    sentiment_score: round(sentimentScore, 3),
    summary: firstSentences(text, 2)
  };
}

function extractKeyPhrases(text, limit = 8) {
  const stopWords = new Set([
    "the",
    "and",
    "for",
    "that",
    "with",
    "this",
    "from",
    "have",
    "your",
    "about",
    "would",
    "there",
    "please",
    "thanks",
    "because",
    "para",
    "como",
    "esta",
    "este",
    "desde",
    "gracias",
    "favor",
    "llamada",
    "agent",
    "customer",
    "patient"
  ]);

  const counts = new Map();
  for (const token of normalize(text).split(" ")) {
    if (!token || token.length < 4 || stopWords.has(token)) continue;
    counts.set(token, (counts.get(token) || 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([term]) => term);
}

function scoreLabel(score) {
  if (score >= 8.5) return "excellent";
  if (score >= 7) return "good";
  if (score >= 5.5) return "fair";
  return "poor";
}

function listIf(...items) {
  return items.filter(Boolean);
}

function buildQualityMetrics({ transcriptText, agentText, patientText, turns }) {
  const empathyHits = countTerms(agentText, [
    "sorry",
    "understand",
    "i know",
    "let me",
    "i can help",
    "happy to help",
    "i can",
    "i will",
    "of course"
  ]);
  const professionalismHits = countTerms(agentText, [
    "thank you",
    "please",
    "good morning",
    "good afternoon",
    "how can i help",
    "let me",
    "may i",
    "can i"
  ]);
  const resolutionHits = countTerms(transcriptText, [
    "scheduled",
    "booked",
    "transfer",
    "sent",
    "submitted",
    "appointment",
    "follow up",
    "follow-up",
    "message",
    "provider"
  ]);
  const unresolvedHits = countTerms(transcriptText, [
    "don't know",
    "do not know",
    "can't",
    "cannot",
    "wait",
    "problem",
    "issue",
    "denied",
    "hospital"
  ]);
  const clarityHits = countTerms(agentText, [
    "so",
    "what i can do",
    "let me",
    "i'm going to",
    "the next step",
    "we can"
  ]);
  const patientConcernHits = countTerms(patientText, [
    "pain",
    "problem",
    "swollen",
    "worry",
    "concern",
    "frustrated",
    "upset",
    "need",
    "appointment"
  ]);

  const turnCount = Array.isArray(turns) ? turns.length : 0;
  const empathyScore = clamp(4 + empathyHits * 1.2, 0, 10);
  const professionalismScore = clamp(4.5 + professionalismHits * 1.1, 0, 10);
  const clarityScore = clamp(4 + clarityHits * 1.15 + Math.min(turnCount, 12) * 0.12, 0, 10);
  const resolutionScore = clamp(5 + resolutionHits * 0.9 - unresolvedHits * 0.8, 0, 10);
  const patientExperienceScore = clamp(6 - patientConcernHits * 0.35 + empathyHits * 0.4, 0, 10);
  const overallQualityScore = round(
    (empathyScore + professionalismScore + clarityScore + resolutionScore + patientExperienceScore) / 5,
    2
  );

  return {
    overall_quality_score: overallQualityScore,
    overall_quality_label: scoreLabel(overallQualityScore),
    empathy_score: round(empathyScore, 2),
    professionalism_score: round(professionalismScore, 2),
    clarity_score: round(clarityScore, 2),
    resolution_score: round(resolutionScore, 2),
    patient_experience_score: round(patientExperienceScore, 2)
  };
}

function buildDetailedReport({ transcriptText, agentText, patientText, speakerSeparation }) {
  const patientSentiment = sentimentFromText(patientText);
  const agentSentiment = sentimentFromText(agentText);
  const overallSentiment = sentimentFromText(transcriptText);
  const qualityMetrics = buildQualityMetrics({
    transcriptText,
    agentText,
    patientText,
    turns: speakerSeparation?.turns || []
  });

  const patientConcerns = listIf(
    /pain|swollen|bleeding|fever|hospital/i.test(patientText) && "Health concern mentioned",
    /appointment|schedule|office|provider/i.test(patientText) && "Appointment/provider help requested",
    /frustrated|upset|confused|worry/i.test(patientText) && "Emotional friction detected"
  );

  const agentStrengths = listIf(
    qualityMetrics.empathy_score >= 7 && "Shows empathy and reassurance",
    qualityMetrics.professionalism_score >= 7 && "Maintains professional tone",
    qualityMetrics.clarity_score >= 7 && "Provides clear next steps"
  );

  const coachingOpportunities = listIf(
    qualityMetrics.empathy_score < 6 && "Increase empathy and acknowledgement of patient concerns",
    qualityMetrics.clarity_score < 6 && "Clarify next steps and expected outcomes",
    qualityMetrics.resolution_score < 6 && "Drive the call toward a more explicit resolution"
  );

  const generalRecommendations = listIf(
    qualityMetrics.resolution_score < 6 && "Close calls with a clear action plan or confirmed next step",
    patientSentiment.sentiment_score < -0.2 && "Address patient frustration earlier and confirm understanding",
    agentSentiment.sentiment_score < -0.2 && "Coach agent on maintaining calm and supportive language"
  );

  return {
    language: detectLanguage(transcriptText),
    sentiment_label: overallSentiment.sentiment_label,
    sentiment_score: overallSentiment.sentiment_score,
    summary: overallSentiment.summary,
    key_phrases: extractKeyPhrases(transcriptText, 8),
    speaker_sentiment: {
      patient: {
        ...patientSentiment,
        emotional_state:
          patientSentiment.sentiment_label === "negative"
            ? "distressed"
            : patientSentiment.sentiment_label === "mixed"
              ? "uncertain"
              : "stable"
      },
      agent: {
        ...agentSentiment,
        communication_tone:
          agentSentiment.sentiment_label === "negative"
            ? "strained"
            : agentSentiment.sentiment_label === "mixed"
              ? "variable"
              : "professional"
      }
    },
    quality_metrics: qualityMetrics,
    report: {
      patient: {
        summary: patientSentiment.summary,
        main_concerns: patientConcerns,
        likely_needs: listIf(
          /appointment|schedule|office|provider/i.test(patientText) && "Scheduling or provider coordination",
          /pain|swollen|fever|hospital/i.test(patientText) && "Clinical follow-up or triage guidance",
          patientConcerns.length === 0 && "General assistance"
        ),
        satisfaction_outlook:
          qualityMetrics.patient_experience_score >= 7
            ? "Likely satisfied if follow-up happens as promised"
            : "At risk unless the next step is completed quickly"
      },
      agent: {
        summary:
          agentStrengths.length || coachingOpportunities.length
            ? `Strengths: ${agentStrengths.join(", ") || "none identified"}. Coaching: ${
                coachingOpportunities.join(", ") || "none identified"
              }.`
            : firstSentences(agentText, 2),
        strengths: agentStrengths,
        coaching_opportunities: coachingOpportunities,
        quality_score: qualityMetrics.overall_quality_score
      },
      overall: {
        summary: overallSentiment.summary,
        call_quality_label: qualityMetrics.overall_quality_label,
        call_quality_score: qualityMetrics.overall_quality_score,
        resolution_status: qualityMetrics.resolution_score >= 7 ? "resolved_or_progressed" : "needs_follow_up",
        recommendations: generalRecommendations,
        risk_flags: patientConcerns
      }
    }
  };
}

function deepMerge(base, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) return base;
  const output = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === "object" && !Array.isArray(value) && base[key] && typeof base[key] === "object" && !Array.isArray(base[key])) {
      output[key] = deepMerge(base[key], value);
    } else if (value !== undefined && value !== null && value !== "") {
      output[key] = value;
    }
  }
  return output;
}

export function buildHeuristicCallAnalysis({ transcriptText, speakerSeparation }) {
  const agentText = speakerSeparation?.agent_text || "";
  const patientText = speakerSeparation?.patient_text || "";
  return buildDetailedReport({ transcriptText, agentText, patientText, speakerSeparation });
}

export function mergeDetailedCallAnalysis({ transcriptText, speakerSeparation, providerResponse }) {
  const base = buildHeuristicCallAnalysis({ transcriptText, speakerSeparation });
  const response = providerResponse && typeof providerResponse === "object" ? { ...providerResponse } : {};

  if (!response.speaker_sentiment) {
    const patient = response.patient || response.patient_sentiment || null;
    const agent = response.agent || response.agent_sentiment || null;
    if (patient || agent) {
      response.speaker_sentiment = {};
      if (patient) response.speaker_sentiment.patient = patient;
      if (agent) response.speaker_sentiment.agent = agent;
    }
  }

  if (!response.report) {
    response.report = {};
    if (response.patient_report) response.report.patient = response.patient_report;
    if (response.agent_report) response.report.agent = response.agent_report;
    if (response.overall_report) response.report.overall = response.overall_report;
  }

  const merged = deepMerge(base, response);

  const overallLabel = merged.sentiment_label || merged.report?.overall?.sentiment_label || base.sentiment_label;
  const overallScore = merged.sentiment_score ?? merged.report?.overall?.sentiment_score ?? base.sentiment_score;

  return {
    ...merged,
    sentiment_label: overallLabel,
    sentiment_score: round(overallScore, 3),
    language: merged.language || base.language || "unknown",
    key_phrases: Array.isArray(merged.key_phrases) ? merged.key_phrases.slice(0, 8) : base.key_phrases
  };
}
