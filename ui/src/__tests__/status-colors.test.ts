import { describe, it, expect } from "vitest";
import { agentStatusDotHex, agentStatusDotHexDefault } from "@/lib/status-colors";

describe("agentStatusDotHex", () => {
  it("returns the canonical hex for each known status", () => {
    expect(agentStatusDotHex.running).toBe("#22d3ee"); // cyan-400
    expect(agentStatusDotHex.active).toBe("#4ade80");  // green-400
    expect(agentStatusDotHex.paused).toBe("#facc15");  // yellow-400
    expect(agentStatusDotHex.idle).toBe("#facc15");
    expect(agentStatusDotHex.error).toBe("#f87171");   // red-400
    expect(agentStatusDotHex.terminated).toBe("#a3a3a3");
  });

  it("exposes a default for unknown statuses", () => {
    expect(agentStatusDotHexDefault).toBe("#a3a3a3");
  });
});
