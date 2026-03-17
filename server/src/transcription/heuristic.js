import { buildHeuristicCallAnalysis } from "./analysis-report.js";

export async function analyzeTranscriptHeuristically({ transcriptText, speakerSeparation }) {
  return {
    model: "heuristic-v1",
    response: buildHeuristicCallAnalysis({
      transcriptText: String(transcriptText || "").trim(),
      speakerSeparation: speakerSeparation || null
    })
  };
}
