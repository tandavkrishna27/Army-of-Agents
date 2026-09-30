import { describe, expect, it, vi } from "vitest";

vi.mock("drizzle-orm", () => ({ eq: vi.fn((a:any,b:any)=>({eq:[a,b]})), and: vi.fn((...a:any[])=>({and:a})) }));
vi.mock("@armyofagents/db", () => ({ internalAgentConfig: {}, agents: {} }));

const cliCalls: any[] = [];
vi.mock("../services/internal-agent/cli-mode.js", () => ({
  cliModeService: () => ({ chat: async function* (p: any) { cliCalls.push(p); yield { type: "text", delta: "hi" }; } }),
}));
vi.mock("../services/internal-agent/conversation.js", () => ({
  conversationService: () => ({
    getOrCreateActive: async () => ({ id: "conv1", summarizedContext: null, summarizedUpToMessageId: null }),
    appendMessage: async () => ({ id: "m1" }),
    getMessagesSince: async () => [],
  }),
}));
vi.mock("../services/internal-agent/commander-context.js", () => ({
  assembleAgentPersona: async () => "ROLE: Commander persona",
  loadCommanderPersona: async () => "ROLE: Commander persona",
}));
vi.mock("../services/internal-agent/commander-skills.js", () => ({ buildSkillsSection: async () => "", buildCompactSkillList: async () => "" }));
vi.mock("../services/company-skills.js", () => ({ companySkillService: () => ({ listRuntimeSkillEntries: async () => [], listCompactSkillEntries: async () => [] }) }));
vi.mock("../services/memory.js", () => ({ memoryService: () => ({ searchSemantic: async () => [] }) }));
vi.mock("../agent-instructions.js", () => ({ agentInstructionsService: () => ({}) }));
vi.mock("../services/internal-agent/cli-summarizer.js", () => ({ summarizeViaCli: vi.fn(async () => "S") }));
vi.mock("../services/internal-agent/aoa-agents/ensure-commander.js", () => ({
  ensureCommanderAgent: async () => "cmd1",
}));
vi.mock("../services/internal-agent/context-assembly.js", () => ({
  contextAssemblyService: () => ({
    assembleContext: async (_companyId: string, opts: any) => ({
      systemPrompt: opts.systemInstructions ?? "DEFAULT",
      estimatedTokens: 10,
    }),
  }),
}));

import { agentLoopService } from "../services/internal-agent/agent-loop.js";

describe("agent-loop assembled prompt", () => {
  it("substitutes params.content with the assembled prompt (persona + user message)", async () => {
    const db: any = { select: () => ({ from: () => ({ where: () => ({ then: (r:any)=>Promise.resolve([{ cliTool: "claude_cli" }]).then(r) }) }) }) };
    const gen = agentLoopService(db).chat({ companyId: "c1", userId: "u1", userRole: "founder", enabledCapabilities: [], content: "hello there" });
    for await (const _ of gen) { /* drain */ }
    expect(cliCalls).toHaveLength(1);
    expect(cliCalls[0].content).toContain("ROLE: Commander persona");
    expect(cliCalls[0].content).toContain("hello there");
  });
});
