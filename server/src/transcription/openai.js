import fs from "fs";
import OpenAI from "openai";

function requireApiKey() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("openai_not_configured");
  }
  return apiKey;
}

function client() {
  return new OpenAI({ apiKey: requireApiKey() });
}

export async function transcribeFile({ filePath, model }) {
  const openai = client();
  const resolvedModel = model || process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1";
  const response = await openai.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: resolvedModel,
    response_format: "verbose_json"
  });
  return { model: resolvedModel, response };
}

export async function analyzeTranscript({ transcriptText, speakerSeparation, model }) {
  const openai = client();
  const resolvedModel = model || process.env.OPENAI_ANALYSIS_MODEL || "gpt-4o-mini";
  const payload = JSON.stringify(
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
  const completion = await openai.chat.completions.create({
    model: resolvedModel,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You analyze healthcare/call-center transcripts. Return ONLY valid JSON with this shape: " +
          "{ language, sentiment_label, sentiment_score, summary, key_phrases, speaker_sentiment: { patient: { sentiment_label, sentiment_score, summary, emotional_state }, agent: { sentiment_label, sentiment_score, summary, communication_tone } }, quality_metrics: { overall_quality_score, overall_quality_label, empathy_score, professionalism_score, clarity_score, resolution_score, patient_experience_score }, report: { patient: { summary, main_concerns, likely_needs, satisfaction_outlook }, agent: { summary, strengths, coaching_opportunities, quality_score }, overall: { summary, call_quality_label, call_quality_score, resolution_status, recommendations, risk_flags } } }. Use concise, evidence-based statements."
      },
      { role: "user", content: payload }
    ]
  });

  const content = completion.choices?.[0]?.message?.content || "{}";
  let parsed = {};
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = {};
  }

  return { model: resolvedModel, response: parsed };
}
