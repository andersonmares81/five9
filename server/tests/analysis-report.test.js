import { describe, expect, it } from "vitest";
import { buildHeuristicCallAnalysis, mergeDetailedCallAnalysis } from "../src/transcription/analysis-report.js";

describe("analysis-report", () => {
  it("builds a detailed heuristic analysis with speaker sentiment and quality metrics", () => {
    const result = buildHeuristicCallAnalysis({
      transcriptText:
        "Thank you for calling Georgia Urology. I can help with that today. I am in pain and worried about my appointment. Let me send a message to the provider and get you scheduled.",
      speakerSeparation: {
        agent_text:
          "Thank you for calling Georgia Urology. I can help with that today. Let me send a message to the provider and get you scheduled.",
        patient_text: "I am in pain and worried about my appointment.",
        turns: [
          { speaker: "agent", text: "Thank you for calling Georgia Urology." },
          { speaker: "agent", text: "I can help with that today." },
          { speaker: "patient", text: "I am in pain and worried about my appointment." },
          { speaker: "agent", text: "Let me send a message to the provider and get you scheduled." }
        ]
      }
    });

    expect(result.speaker_sentiment.patient).toBeTruthy();
    expect(result.speaker_sentiment.agent).toBeTruthy();
    expect(result.quality_metrics.overall_quality_score).toBeGreaterThan(0);
    expect(result.report.patient).toBeTruthy();
    expect(result.report.agent).toBeTruthy();
    expect(result.report.overall).toBeTruthy();
  });

  it("merges provider output over heuristic defaults without losing required sections", () => {
    const result = mergeDetailedCallAnalysis({
      transcriptText: "Hello. Thank you for calling. I need help with my refill.",
      speakerSeparation: {
        agent_text: "Hello. Thank you for calling.",
        patient_text: "I need help with my refill.",
        turns: []
      },
      providerResponse: {
        sentiment_label: "mixed",
        report: {
          overall: {
            summary: "Custom overall summary."
          }
        },
        speaker_sentiment: {
          patient: {
            sentiment_label: "negative"
          }
        }
      }
    });

    expect(result.sentiment_label).toBe("mixed");
    expect(result.report.overall.summary).toBe("Custom overall summary.");
    expect(result.speaker_sentiment.patient.sentiment_label).toBe("negative");
    expect(result.speaker_sentiment.agent).toBeTruthy();
  });
});
