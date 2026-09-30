// server/src/services/internal-agent/__tests__/ask-human-crew-actor.test.ts
//
// T8 Defect A — crew agents must run with actorType 'agent'. ask_human's
// identity gate (ask-human-tool.ts) fails unless actorType==='agent' AND
// agentKind is 'org'|'aoa' AND agentId AND runId are set. Crew already sets
// agentKind/agentId/runId; only actorType was wrong (defaulted to 'board' in
// the bridge). This proves the gate distinguishes the two, so setting
// actorType:'agent' in the crew runner is exactly what unblocks ask_human.
import { describe, it, expect, vi } from "vitest";

const { askHumanForActiveRunMock } = vi.hoisted(() => ({
  askHumanForActiveRunMock: vi.fn(),
}));

vi.mock("../../../mcp/tools/ask-founder-tool.js", () => ({
  askHumanForActiveRun: askHumanForActiveRunMock,
}));

import { askHumanTool } from "../tools/ask-human-tool.js";

function crewCtx(overrides: Record<string, unknown> = {}) {
  return {
    companyId: "co-1",
    userId: "aoa-subagent",
    userRole: "founder",
    enabledCapabilities: [],
    actorType: "agent",
    agentKind: "aoa",
    agentId: "a-1",
    runId: "run-1",
    db: {} as any,
    services: {} as any,
    ...overrides,
  } as any;
}

describe("ask_human crew actor identity (Defect A)", () => {
  it("permits a crew actor (actorType 'agent' + agentKind 'aoa') — does NOT return the actor-identity error", async () => {
    askHumanForActiveRunMock.mockResolvedValueOnce({ answered: false });

    const res = await askHumanTool.execute({ question: "Which API?" }, crewCtx());

    // The identity gate is passed → the tool reaches askHumanForActiveRun.
    expect(askHumanForActiveRunMock).toHaveBeenCalledOnce();
    expect(res.success).toBe(true);
    expect(res.error).not.toBe("FORBIDDEN");
  });

  it("rejects the SAME crew shape when actorType is 'board' (the pre-fix bridge default)", async () => {
    askHumanForActiveRunMock.mockClear();

    // Identical crew context except actorType — this is precisely the broken
    // state before the fix (bridge defaults AOA_ACTOR_TYPE to 'board').
    const res = await askHumanTool.execute(
      { question: "Which API?" },
      crewCtx({ actorType: "board" }),
    );

    expect(res.success).toBe(false);
    expect(res.error).toBe("FORBIDDEN");
    expect(res.summary).toContain("active organization-agent task run");
    // The gate blocked before any downstream call.
    expect(askHumanForActiveRunMock).not.toHaveBeenCalled();
  });
});
