// server/src/__tests__/broker-ask-human-work-question.unit.test.ts
//
// DAT-007 — acceptance §7.7 characterization (Windows-safe, DB-free).
//
// The DAT-007 transport rides the EXISTING MCP JSON-RPC broker
// (broker-registry.ts `brokerRegistry === createToolRegistry()`), and over that
// broker a `tools/call ask_human` resolves through the internal `askHumanTool`
// (mcp/server.ts:723-726 documents ask_human/ask_founder resolving through the
// internal registry). This proves the acceptance invariant for that transport:
//
//   * a remote crew ('aoa') AND org agent run BOTH have ask_human authority and
//     the tool delegates to `askHumanForActiveRun` — the DURABLE `work_questions`
//     aggregate (+ hub mirror + continuation), NOT `agent_runtime_decisions`;
//   * a non-agent / run-less caller is refused (FORBIDDEN) before any binding.
//
// This is the correct DAT-007 posture on the ask_human item: the broker path is
// already right, so this file LOCKS the invariant rather than re-plumbing it.
// (The row-level `work_questions` write is proven against real Postgres in
// broker-internal-registry.integration.test.ts, which skips on Windows.) It
// deliberately does NOT touch job-approval-bridge.ts — that file's
// task_run→agent_runtime_decisions / crew_run→"none" mapping is the JOB-011
// worker CONTROL-CHANNEL parity contract (Decision #121, frozen by
// job-source-governance-matrix.test.ts), a different transport than the broker.
import { describe, expect, it, vi } from "vitest";

const askHumanMocks = vi.hoisted(() => ({
  askHumanForActiveRun: vi.fn(async () => ({ answered: false, questionId: "wq-1", parked: true })),
}));

vi.mock("../mcp/tools/ask-founder-tool.js", () => ({
  askHumanForActiveRun: askHumanMocks.askHumanForActiveRun,
}));

import { askHumanTool, askFounderCompatibilityTool } from "../services/internal-agent/tools/ask-human-tool.js";
import type { ToolContext } from "../services/internal-agent/types.js";

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    companyId: "co-1",
    userId: "agent-1",
    userRole: "founder",
    enabledCapabilities: [],
    db: { __marker: "fake-db" },
    services: {} as ToolContext["services"],
    ...overrides,
  } as unknown as ToolContext;
}

const QUESTION = { question: "Which pricing tier?", context: "blocking checkout" };

describe("DAT-007 §7.7 — broker ask_human binds the durable work_questions aggregate", () => {
  it("crew ('aoa') run has ask_human authority and delegates to askHumanForActiveRun (work_questions), NOT agent_runtime_decisions", async () => {
    askHumanMocks.askHumanForActiveRun.mockClear();
    const result = await askHumanTool.execute(
      QUESTION,
      ctx({ actorType: "agent", agentKind: "aoa", agentId: "agent-1", runId: "run-1" }),
    );

    expect(result.success).toBe(true);
    expect(askHumanMocks.askHumanForActiveRun).toHaveBeenCalledTimes(1);
    const [binding] = askHumanMocks.askHumanForActiveRun.mock.calls[0]!;
    // aoa → internal_agent run kind (askHumanForActiveRun resolves the durable
    // work_questions row via internal_agent_runs for crew).
    expect(binding).toMatchObject({
      companyId: "co-1",
      agentId: "agent-1",
      runId: "run-1",
      originatingRunKind: "internal_agent",
    });
  });

  it("org run has ask_human authority and delegates to the SAME durable aggregate (heartbeat run kind)", async () => {
    askHumanMocks.askHumanForActiveRun.mockClear();
    const result = await askHumanTool.execute(
      QUESTION,
      ctx({ actorType: "agent", agentKind: "org", agentId: "agent-1", runId: "run-1" }),
    );

    expect(result.success).toBe(true);
    expect(askHumanMocks.askHumanForActiveRun).toHaveBeenCalledTimes(1);
    const [binding] = askHumanMocks.askHumanForActiveRun.mock.calls[0]!;
    expect(binding).toMatchObject({ originatingRunKind: "heartbeat" });
  });

  it("the ask_founder alias shares the identical durable binding for crew runs", async () => {
    askHumanMocks.askHumanForActiveRun.mockClear();
    const result = await askFounderCompatibilityTool.execute(
      QUESTION,
      ctx({ actorType: "agent", agentKind: "aoa", agentId: "agent-1", runId: "run-1" }),
    );

    expect(result.success).toBe(true);
    expect(askHumanMocks.askHumanForActiveRun).toHaveBeenCalledTimes(1);
  });

  it("refuses a non-agent caller (no ask_human authority) before any binding", async () => {
    askHumanMocks.askHumanForActiveRun.mockClear();
    const result = await askHumanTool.execute(QUESTION, ctx({ actorType: "commander" }));

    expect(result.success).toBe(false);
    expect(result.error).toBe("FORBIDDEN");
    expect(askHumanMocks.askHumanForActiveRun).not.toHaveBeenCalled();
  });

  it("refuses an agent kind that never runs over the broker (e.g. missing runId)", async () => {
    askHumanMocks.askHumanForActiveRun.mockClear();
    const result = await askHumanTool.execute(
      QUESTION,
      ctx({ actorType: "agent", agentKind: "aoa", agentId: "agent-1", runId: undefined }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("FORBIDDEN");
    expect(askHumanMocks.askHumanForActiveRun).not.toHaveBeenCalled();
  });
});
