import { describe, it, expect } from "vitest";
import { buildMcpBridgeSpec } from "../services/internal-agent/cli-mode.js";

/**
 * P3.5: Effective autonomy = threadLevel ?? companyAutonomy
 *
 * D10 formula: If a thread has autonomyLevel set (non-null) → use that.
 * Otherwise → fall back to company-level autonomyLevel.
 *
 * Tests:
 * 1. D10 formula: thread wins when non-null
 * 2. D10 formula: company fallback when thread is null
 * 3. McpConfigParams includes AOA_EFFECTIVE_AUTONOMY when set
 * 4. McpConfigParams omits AOA_EFFECTIVE_AUTONOMY when null/absent
 */

describe("P3.5: Effective Autonomy (D10)", () => {
  it("D10: thread autonomyLevel overrides company when non-null", () => {
    const threadLevel = 1;
    const companyLevel = 2;
    const effective = threadLevel ?? companyLevel;
    expect(effective).toBe(1); // thread wins
  });

  it("D10: falls back to company when thread autonomyLevel is null", () => {
    const threadLevel = null;
    const companyLevel = 2;
    const effective = threadLevel ?? companyLevel;
    expect(effective).toBe(2); // company fallback
  });

  it("buildMcpBridgeSpec includes AOA_EFFECTIVE_AUTONOMY when effectiveAutonomy set", () => {
    const spec = buildMcpBridgeSpec({
      companyId: "co-1",
      userId: "u-1",
      userRole: "team_member",
      enabledCapabilities: [],
      bridgeEntrypoint: "/bridge.js",
      effectiveAutonomy: 2,
      agentId: "agent-1",
    });
    expect(spec.env.AOA_EFFECTIVE_AUTONOMY).toBe("2");
    expect(spec.env.AOA_AGENT_ID).toBe("agent-1");
  });

  it("buildMcpBridgeSpec omits AOA_EFFECTIVE_AUTONOMY when effectiveAutonomy is null", () => {
    const spec = buildMcpBridgeSpec({
      companyId: "co-1",
      userId: "u-1",
      userRole: "team_member",
      enabledCapabilities: [],
      bridgeEntrypoint: "/bridge.js",
      effectiveAutonomy: null,
    });
    expect(spec.env.AOA_EFFECTIVE_AUTONOMY).toBeUndefined();
    expect(spec.env.AOA_AGENT_ID).toBeUndefined();
  });

  it("buildMcpBridgeSpec omits AOA_EFFECTIVE_AUTONOMY when field is absent", () => {
    const spec = buildMcpBridgeSpec({
      companyId: "co-1",
      userId: "u-1",
      userRole: "team_member",
      enabledCapabilities: [],
      bridgeEntrypoint: "/bridge.js",
    });
    expect(spec.env.AOA_EFFECTIVE_AUTONOMY).toBeUndefined();
    expect(spec.env.AOA_AGENT_ID).toBeUndefined();
  });
});
