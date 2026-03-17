import { describe, expect, it } from "vitest";
import { separateTranscriptSpeakers } from "../src/transcription/speakers.js";

describe("separateTranscriptSpeakers", () => {
  it("builds speaker-separated turns from transcript segments", () => {
    const result = separateTranscriptSpeakers({
      transcriptText:
        "Thank you for calling Georgia Urology. Hi, I'm calling about my appointment. Let me transfer you to the office.",
      transcriptJson: {
        text:
          "Thank you for calling Georgia Urology. Hi, I'm calling about my appointment. Let me transfer you to the office.",
        segments: [
          { id: 0, start: 0, end: 2, text: "Thank you for calling Georgia Urology." },
          { id: 1, start: 2.1, end: 4.5, text: "Hi, I'm calling about my appointment." },
          { id: 2, start: 4.6, end: 7, text: "Let me transfer you to the office." }
        ]
      }
    });

    expect(result.turns).toHaveLength(3);
    expect(result.turns[0].speaker).toBe("agent");
    expect(result.turns[1].speaker).toBe("patient");
    expect(result.agent_text).toContain("Georgia Urology");
    expect(result.patient_text).toContain("my appointment");
  });
});
