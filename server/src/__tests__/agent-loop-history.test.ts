import { describe, expect, it, vi } from "vitest";
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a: any, b: any) => ({ eq: [a, b] })),
  and: vi.fn((...a: any) => ({ and: a })),
  or: vi.fn((...a: any) => ({ or: a })),
}));
vi.mock("@armyofagents/db", () => ({
  internalAgentConfig: {},
  agents: {},
  // Required by services/embeddings.ts (imported transitively via memory.ts)
  memoryItems: {},
  discussions: {},
  discussionExtractedItems: {},
  embeddingQueue: {},
}));
const cliCalls:any[]=[];
vi.mock("../services/internal-agent/cli-mode.js", () => ({ cliModeService: () => ({ chat: async function*(p:any){ cliCalls.push(p); yield {type:"text",delta:"ok"}; } }) }));
vi.mock("../services/internal-agent/conversation.js", () => ({
  conversationService: () => ({
    getOrCreateActive: async () => ({ id: "conv1", summarizedContext: "PRIOR SUMMARY", summarizedUpToMessageId: "m1" }),
    appendMessage: async () => ({ id: "mX" }),
    getMessagesSince: async () => ([{ role: "user", content: "older Q" }, { role: "assistant", content: "older A" }]),
  }),
}));
vi.mock("../services/internal-agent/commander-context.js", () => ({ assembleAgentPersona: async () => "PERSONA", loadCommanderPersona: async () => "PERSONA" }));
vi.mock("../services/internal-agent/commander-skills.js", () => ({ buildSkillsSection: async () => "", buildCompactSkillList: async () => "" }));
vi.mock("../services/company-skills.js", () => ({ companySkillService: () => ({ listRuntimeSkillEntries: async () => [], listCompactSkillEntries: async () => [] }) }));
vi.mock("../services/internal-agent/aoa-agents/ensure-commander.js", () => ({
  ensureCommanderAgent: async () => "cmd1",
}));
vi.mock("../services/internal-agent/context-assembly.js", () => ({
  contextAssemblyService: () => ({
    assembleContext: async (_companyId: string, opts: any) => ({
      systemPrompt: [
        opts.systemInstructions ?? "DEFAULT",
        opts.conversationSummary ? `## Conversation Summary\n${opts.conversationSummary}` : "",
      ].filter(Boolean).join("\n\n"),
      estimatedTokens: 10,
    }),
  }),
}));
import { agentLoopService } from "../services/internal-agent/agent-loop.js";

describe("agent-loop history", () => {
  it("includes the rolling summary and prior turns in the assembled prompt", async () => {
    const db:any = { select: () => ({ from: () => ({ where: () => ({ then: (r:any)=>Promise.resolve([{ cliTool:"claude_cli" }]).then(r) }) }) }) };
    const gen = agentLoopService(db).chat({ companyId:"c1", userId:"u1", userRole:"founder", enabledCapabilities:[], content:"new Q" });
    for await (const _ of gen) {}
    const sent = cliCalls[0].content as string;
    expect(sent).toContain("PRIOR SUMMARY");
    expect(sent).toContain("older Q");
    expect(sent).toContain("older A");
    expect(sent).toContain("new Q");
  });
});
