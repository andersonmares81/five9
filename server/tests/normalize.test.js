import { describe, it, expect } from "vitest";
import { normalizeCall } from "../src/five9/sync.js";

describe("normalizeCall", () => {
  it("maps core fields", () => {
    const raw = {
      callId: 123,
      agentId: "a1",
      agentName: "Agent One",
      campaignId: "c1",
      campaignName: "Campaign",
      extension: "1001",
      ANI: "8602982151",
      DNIS: "8607897478",
      EVENT_CODE: "Inbound",
      EVENT_DIR: "Call",
      callStartTime: "2026-03-10T10:00:00Z",
      callEndTime: "2026-03-10T10:05:00Z",
      callDuration: 300,
      direction: "inbound",
      status: "answered"
    };

    const call = normalizeCall(raw);
    expect(call.callId).toBe("123");
    expect(call.agentId).toBe("a1");
    expect(call.durationSec).toBe(300);
    expect(call.status).toBe("answered");
    expect(call.extension).toBe("1001");
    expect(call.ani).toBe("8602982151");
    expect(call.dnis).toBe("8607897478");
  });
});
