import { describe, it, expect, vi, beforeEach } from "vitest";

const seedCrewAgentMock = vi.fn();

vi.mock("../services/internal-agent/aoa-agents/seed-crew-agent.js", () => ({
  seedCrewAgent: (...args: unknown[]) => seedCrewAgentMock(...args),
}));

import {
  ensureSteward,
  STEWARD_TOOL_ALLOWLIST,
} from "../services/internal-agent/aoa-agents/ensure-steward.js";

describe("ensureSteward", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedCrewAgentMock.mockResolvedValue("steward-1");
  });

  it("seeds a dedicated sweep-driven Steward crew agent", async () => {
    const db = {} as any;

    await expect(ensureSteward(db, "company-1")).resolves.toBe("steward-1");

    expect(seedCrewAgentMock).toHaveBeenCalledWith(
      db,
      "company-1",
      expect.objectContaining({
        name: "Steward",
        role: "general",
        toolAllowlist: STEWARD_TOOL_ALLOWLIST,
        triggers: [{ kind: "sweep", config: { role: "steward" } }],
        instructionBundleRole: "steward",
      }),
    );
    expect(STEWARD_TOOL_ALLOWLIST).not.toContain("post_entry");
  });
});
