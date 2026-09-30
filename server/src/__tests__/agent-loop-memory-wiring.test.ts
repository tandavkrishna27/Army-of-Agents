import { describe, expect, it, vi } from "vitest";

vi.mock("drizzle-orm", () => ({ eq: vi.fn(), and: vi.fn() }));
vi.mock("@armyofagents/db", () => ({ internalAgentConfig: {}, agents: {} }));

const cliCalls: any[] = [];
vi.mock("../services/internal-agent/cli-mode.js", () => ({
  cliModeService: () => ({
    chat: async function* (p: any) {
      cliCalls.push(p);
      yield { type: "text", delta: "x" };
    },
  }),
}));

vi.mock("../services/internal-agent/conversation.js", () => ({
  conversationService: () => ({
    getOrCreateActive: async () => ({
      id: "c",
      summarizedContext: null,
      summarizedUpToMessageId: null,
    }),
    appendMessage: async () => ({ id: "m" }),
    getMessagesSince: async () => [],
    summarizeIfNeeded: async () => {},
  }),
}));

vi.mock("../services/internal-agent/commander-context.js", () => ({
  assembleAgentPersona: async () => "P",
  loadCommanderPersona: async () => "P",
}));

vi.mock("../services/internal-agent/commander-skills.js", () => ({ buildSkillsSection: async () => "", buildCompactSkillList: async () => "" }));
vi.mock("../services/company-skills.js", () => ({ companySkillService: () => ({ listRuntimeSkillEntries: async () => [], listCompactSkillEntries: async () => [] }) }));
vi.mock("../services/internal-agent/cli-summarizer.js", () => ({ summarizeViaCli: vi.fn(async () => "S") }));

vi.mock("../services/internal-agent/aoa-agents/ensure-commander.js", () => ({
  ensureCommanderAgent: async () => "cmd-id",
}));

vi.mock("../agent-instructions.js", () => ({
  agentInstructionsService: () => ({}),
}));

const recall = vi.fn(async () => ({
  status: "ok",
  query: "refund question",
  elapsedMs: 2,
  items: [{ id: "m1", title: "Refund policy", content: "30 day window", layer: "identity" }],
}));

vi.mock("../services/internal-agent/memory-recall.js", () => ({
  commanderMemoryRecallService: () => ({ recall }),
  normalizeCommanderMemoryRecallPolicy: () => ({
    enabled: true,
    strictness: "balanced",
    timeoutMs: 3000,
    circuitBreakerMaxTimeouts: 3,
    circuitBreakerCooldownMs: 60000,
    maxItems: 8,
    layers: {
      identity: true,
      domain: true,
      active_context: "scoped",
      working: false,
    },
  }),
}));

vi.mock("../services/internal-agent/context-assembly.js", () => ({
  contextAssemblyService: () => ({
    assembleContext: async (_cid: string, opts: any) => {
      let prompt = "ASSEMBLED";
      if (opts.memoryItems?.length) {
        const memory = opts.memoryItems.map((m: any) => `${m.title ?? "Memory"}: ${m.content ?? ""}`).join("\n");
        prompt = `ASSEMBLED\n\n## Relevant Company Memory\n${memory}`;
      }
      return { systemPrompt: prompt, estimatedTokens: 100 };
    },
  }),
}));

import { agentLoopService } from "../services/internal-agent/agent-loop.js";

describe("agent-loop memory wiring", () => {
  it("passes the user's message as the relevance query and injects results", async () => {
    const db: any = {
      select: () => ({
        from: () => ({
          where: () => ({
            then: (r: any) =>
              Promise.resolve([{ cliTool: "claude_cli" }]).then(r),
          }),
        }),
      }),
    };

    for await (const _ of agentLoopService(db).chat({
      companyId: "c1",
      userId: "u1",
      userRole: "founder",
      enabledCapabilities: [],
      content: "refund question",
    })) {
    }

    expect(recall).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "c1",
      userId: "u1",
      userRole: "founder",
      latestUserMessage: "refund question",
    }));
    expect(cliCalls[0].content).toContain("Refund policy");
  });
});
