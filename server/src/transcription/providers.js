import { analyzeTranscript as analyzeWithOpenAI, transcribeFile as transcribeWithOpenAI } from "./openai.js";
import { analyzeTranscriptWithOllama } from "./ollama.js";
import { analyzeTranscriptHeuristically } from "./heuristic.js";
import { transcribeFileWithFasterWhisper } from "./stt_faster_whisper.js";

function sentimentProvider() {
  return String(process.env.SENTIMENT_PROVIDER || "").trim().toLowerCase();
}

function transcribeProvider() {
  return String(process.env.TRANSCRIBE_PROVIDER || "").trim().toLowerCase();
}

function canFallbackFromOpenAI(error) {
  const message = String(error?.message || "").toLowerCase();
  const status = error?.status || error?.response?.status || null;
  return (
    message === "openai_not_configured" ||
    status === 429 ||
    message.includes("current quota") ||
    message.includes("billing") ||
    message.includes("rate limit")
  );
}

export async function transcribeFile({ filePath, model }) {
  const provider = transcribeProvider();

  if (provider === "faster_whisper" || provider === "faster-whisper") {
    const response = await transcribeFileWithFasterWhisper({ filePath, model });
    return { provider: "faster_whisper", ...response };
  }

  if (provider === "openai") {
    try {
      const response = await transcribeWithOpenAI({ filePath, model });
      return { provider: "openai", ...response };
    } catch (error) {
      if (!canFallbackFromOpenAI(error)) throw error;
      const response = await transcribeFileWithFasterWhisper({ filePath, model });
      return { provider: "faster_whisper", ...response };
    }
  }

  // Auto: prefer OpenAI if configured, otherwise try local.
  try {
    const response = await transcribeWithOpenAI({ filePath, model });
    return { provider: "openai", ...response };
  } catch (error) {
    if (!canFallbackFromOpenAI(error)) throw error;
  }

  const response = await transcribeFileWithFasterWhisper({ filePath, model });
  return { provider: "faster_whisper", ...response };
}

export async function analyzeTranscript({ transcriptText, speakerSeparation, model }) {
  const provider = sentimentProvider();

  if (provider === "ollama") {
    try {
      const response = await analyzeTranscriptWithOllama({ transcriptText, speakerSeparation, model });
      return { provider: "ollama", ...response };
    } catch (error) {
      const message = String(error?.message || "");
      if (message !== "ollama_unavailable" && message !== "ollama_model_not_found") throw error;
      const response = await analyzeTranscriptHeuristically({ transcriptText, speakerSeparation });
      return { provider: "heuristic", ...response };
    }
  }

  if (provider === "openai" || provider === "") {
    // Auto: use OpenAI if configured, otherwise Ollama.
    try {
      const response = await analyzeWithOpenAI({ transcriptText, speakerSeparation, model });
      return { provider: "openai", ...response };
    } catch (error) {
      if (!canFallbackFromOpenAI(error)) throw error;
    }
    try {
      const response = await analyzeTranscriptWithOllama({ transcriptText, speakerSeparation, model });
      return { provider: "ollama", ...response };
    } catch (error) {
      const message = String(error?.message || "");
      if (message !== "ollama_unavailable" && message !== "ollama_model_not_found") throw error;
    }
    const response = await analyzeTranscriptHeuristically({ transcriptText, speakerSeparation });
    return { provider: "heuristic", ...response };
  }

  if (provider === "heuristic" || provider === "local") {
    const response = await analyzeTranscriptHeuristically({ transcriptText, speakerSeparation });
    return { provider: "heuristic", ...response };
  }

  if (provider === "openai-strict") {
    const response = await analyzeWithOpenAI({ transcriptText, speakerSeparation, model });
    return { provider: "openai", ...response };
  }

  throw new Error("sentiment_provider_not_configured");
}
