import axios from "axios";

function host() {
  return (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/$/, "");
}

function model() {
  return process.env.OLLAMA_SENTIMENT_MODEL || "llama3.1:8b";
}

export async function analyzeTranscriptWithOllama({ transcriptText, speakerSeparation }) {
  const baseUrl = host();
  const resolvedModel = model();
  const payloadInput = JSON.stringify(
    {
      transcript: String(transcriptText || "").slice(0, 120000),
      speakers: speakerSeparation
        ? {
            agent_text: speakerSeparation.agent_text || "",
            patient_text: speakerSeparation.patient_text || "",
            turns: Array.isArray(speakerSeparation.turns) ? speakerSeparation.turns.slice(0, 120) : []
          }
        : null
    },
    null,
    2
  );

  const payload = {
    model: resolvedModel,
    stream: false,
    format: "json",
    options: {
      temperature: 0.1
    },
    messages: [
      {
        role: "system",
        content:
          "You analyze healthcare/call-center transcripts. Return ONLY valid JSON with this shape: " +
          "{ language, sentiment_label, sentiment_score, summary, key_phrases, speaker_sentiment: { patient: { sentiment_label, sentiment_score, summary, emotional_state }, agent: { sentiment_label, sentiment_score, summary, communication_tone } }, quality_metrics: { overall_quality_score, overall_quality_label, empathy_score, professionalism_score, clarity_score, resolution_score, patient_experience_score }, report: { patient: { summary, main_concerns, likely_needs, satisfaction_outlook }, agent: { summary, strengths, coaching_opportunities, quality_score }, overall: { summary, call_quality_label, call_quality_score, resolution_status, recommendations, risk_flags } } }. Use concise, evidence-based statements."
      },
      { role: "user", content: payloadInput }
    ]
  };

  try {
    const response = await axios.post(`${baseUrl}/api/chat`, payload, {
      timeout: Number(process.env.OLLAMA_TIMEOUT_MS || 120000)
    });

    const content = response.data?.message?.content || "{}";
    let parsed = {};
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = {};
    }

    return { model: resolvedModel, response: parsed };
  } catch (error) {
    const status = error?.response?.status;
    if (status === 404) throw new Error("ollama_model_not_found");
    throw new Error("ollama_unavailable");
  }
}
