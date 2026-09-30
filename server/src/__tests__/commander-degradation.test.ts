import { afterEach, describe, expect, it, vi } from "vitest";
import { setDeploymentMode } from "../config/deployment-mode.js";

// Mock drizzle-orm operators
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ __drizzle: "eq", col, val })),
  and: vi.fn((...conditions) => ({ __drizzle: "and", conditions })),
}));

// Mock database tables
vi.mock("@armyofagents/db", () => ({
  internalAgentConfig: { companyId: "companyId" },
  agents: { id: "id", companyId: "companyId", name: "name", adapterConfig: "adapterConfig" },
}));

// Mock services — all degradation paths enabled
vi.mock("../services/internal-agent/cli-mode.js", () => ({
  cliModeService: () => ({
    chat: async function* () {
      yield { type: "text", delta: "reply" };
    },
  }),
}));

// Mock conversation — track summarizeIfNeeded calls
const summarizeIfNeededMock = vi.fn(async () => {
  throw new Error("sum fail");
});

vi.mock("../services/internal-agent/conversation.js", () => ({
  conversationService: () => ({
    getOrCreateActive: async () => ({
      id: "c",
      summarizedContext: null,
      summarizedUpToMessageId: null,
    }),
    appendMessage: async () => ({ id: "m" }),
    getMessagesSince: async () => [],
    summarizeIfNeeded: summarizeIfNeededMock,
  }),
}));

// Mock commander-context — missing bundle
vi.mock("../services/internal-agent/commander-context.js", () => ({
  loadCommanderPersona: async () => null,
}));

// Mock memory service — no embedding key
vi.mock("../services/memory.js", () => ({
  memoryService: () => ({
    searchSemantic: async () => {
      throw new Error("no key");
    },
  }),
}));

// Mock company-skills — skill loading fail
vi.mock("../services/company-skills.js", () => ({
  companySkillService: () => ({
    listRuntimeSkillEntries: async () => {
      throw new Error("skill fail");
    },
    listCompactSkillEntries: async () => {
      throw new Error("skill fail");
    },
  }),
}));

// Mock ensure-commander — returns a valid id
vi.mock("../services/internal-agent/aoa-agents/ensure-commander.js", () => ({
  ensureCommanderAgent: async () => "agent-123",
}));

// Mock context-assembly
vi.mock("../services/internal-agent/context-assembly.js", () => ({
  contextAssemblyService: () => ({
    assembleContext: async () => ({
      systemPrompt: "system",
    }),
  }),
}));

// Mock agent-instructions
vi.mock("../services/agent-instructions.js", () => ({
  agentInstructionsService: () => ({}),
}));

// Mock commander-skills — removed so real buildSkillsSection runs and
// its try-catch swallows the companySkillService throw
// vi.mock("../services/internal-agent/commander-skills.js", () => ({
//   buildSkillsSection: async () => "",
// }));

// Mock cli-summarizer
vi.mock("../services/internal-agent/cli-summarizer.js", () => ({
  summarizeViaCli: async () => "summary",
}));

// U13.6 — the founder-notification surface on a cloud compaction failure.
// Mocked so these tests assert ROUTING (agent-loop.ts calls this, with what
// args, ONLY on cloud) without exercising the real userRoles lookup /
// createNotification hub-emit chain (out of scope here — this file drives
// agent-loop.ts's degradation behavior with a fully hand-rolled `db` double,
// same style as every other dependency mocked above).
const notifyFounderOfCompactionFailureMock = vi.fn(async () => {});
vi.mock("../services/internal-agent/compaction-failure-notice.js", () => ({
  notifyFounderOfCompactionFailure: (...a: unknown[]) =>
    notifyFounderOfCompactionFailureMock(...a),
}));

import { agentLoopService } from "../services/internal-agent/agent-loop.js";

afterEach(() => {
  setDeploymentMode("local_trusted");
});

describe("commander graceful degradation", () => {
  it("missing bundle + no memory key + skill fail + summarize throw → still replies", async () => {
    setDeploymentMode("local_trusted");
    // Reset the mock before the test
    summarizeIfNeededMock.mockClear();
    notifyFounderOfCompactionFailureMock.mockClear();

    // Mock DB with config and agent rows using a call counter
    let selectCallCount = 0;
    const db: any = {
      select: () => ({
        from: (table: any) => ({
          where: (condition: any) => ({
            then: (callback: (rows: any[]) => any) => {
              // First select (index 0) = config
              // Second select (index 1) = agent row
              const callIndex = selectCallCount++;

              if (callIndex === 0) {
                // Return config row
                return Promise.resolve(
                  callback([{ cliTool: "claude_cli", contextTokenBudget: 4000 }])
                );
              } else if (callIndex === 1) {
                // Return agent row
                return Promise.resolve(
                  callback([
                    {
                      id: "agent-123",
                      companyId: "c1",
                      name: "Commander",
                      adapterConfig: null,
                    },
                  ])
                );
              }
              // Fallback (should not happen)
              return Promise.resolve(callback([]));
            },
          }),
        }),
      }),
    };

    const chunks: any[] = [];
    for await (const c of agentLoopService(db).chat({
      companyId: "c1",
      userId: "u1",
      userRole: "founder",
      enabledCapabilities: [],
      content: "q",
    })) {
      chunks.push(c);
    }

    // Should have received the reply despite all failures
    expect(chunks.some((c) => c.type === "text" && c.delta === "reply")).toBe(true);

    // Should NOT have an error chunk (degradation swallowed all failures)
    expect(chunks.some((c) => c.type === "error")).toBe(false);

    // Verify summarizeIfNeeded was called (proving the post-turn compaction path was reached)
    expect(summarizeIfNeededMock).toHaveBeenCalled();

    // Desktop (local_trusted): a compaction failure is NOT surfaced as a
    // founder notification — unchanged pre-U13.6 behavior.
    expect(notifyFounderOfCompactionFailureMock).not.toHaveBeenCalled();
  });

  // U13.6 (R3 fix): on cloud, a compaction throw previously degraded
  // completely silently — the founder had no way to know history had stopped
  // compacting. Compaction is still best-effort (must never fail the turn),
  // but the cloud path now raises ONE founder notification per failure.
  it("cloud_auth + summarize throw → raises ONE founder notification AND the run still completes", async () => {
    setDeploymentMode("cloud_auth");
    summarizeIfNeededMock.mockClear();
    notifyFounderOfCompactionFailureMock.mockClear();

    let selectCallCount = 0;
    const db: any = {
      select: () => ({
        from: (table: any) => ({
          where: (condition: any) => ({
            then: (callback: (rows: any[]) => any) => {
              const callIndex = selectCallCount++;
              if (callIndex === 0) {
                return Promise.resolve(
                  callback([{ cliTool: "claude_cli", contextTokenBudget: 4000 }])
                );
              } else if (callIndex === 1) {
                return Promise.resolve(
                  callback([
                    {
                      id: "agent-123",
                      companyId: "c1",
                      name: "Commander",
                      adapterConfig: null,
                    },
                  ])
                );
              }
              return Promise.resolve(callback([]));
            },
          }),
        }),
      }),
    };

    const chunks: any[] = [];
    for await (const c of agentLoopService(db).chat({
      companyId: "c1",
      userId: "u1",
      userRole: "founder",
      enabledCapabilities: [],
      content: "q",
    })) {
      chunks.push(c);
    }

    // The Commander run STILL completes — compaction stays best-effort, the
    // notification surface never blocks/fails the turn.
    expect(chunks.some((c) => c.type === "text" && c.delta === "reply")).toBe(true);
    expect(chunks.some((c) => c.type === "error")).toBe(false);
    expect(summarizeIfNeededMock).toHaveBeenCalled();

    // Exactly ONE founder notification raised for this failure, threaded
    // with the company + the underlying error + the conversation id.
    expect(notifyFounderOfCompactionFailureMock).toHaveBeenCalledTimes(1);
    const [calledDb, calledCompanyId, calledErr, calledConversationId] =
      notifyFounderOfCompactionFailureMock.mock.calls[0];
    expect(calledDb).toBe(db);
    expect(calledCompanyId).toBe("c1");
    expect(calledErr).toBeInstanceOf(Error);
    expect((calledErr as Error).message).toBe("sum fail");
    expect(calledConversationId).toBe("c");
  });
});
