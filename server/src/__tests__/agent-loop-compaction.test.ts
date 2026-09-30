import { describe, expect, it, vi } from "vitest";
vi.mock("drizzle-orm", () => ({ eq: vi.fn(), and: vi.fn() }));
vi.mock("@armyofagents/db", () => ({ internalAgentConfig:{}, agents:{} }));
vi.mock("../services/internal-agent/cli-mode.js", () => ({ cliModeService: () => ({ chat: async function*(){ yield {type:"text",delta:"reply"}; } }) }));
const summarizeIfNeeded = vi.fn(async ()=>{});
vi.mock("../services/internal-agent/conversation.js", () => ({
  conversationService: () => ({
    getOrCreateActive: async () => ({ id:"conv1", summarizedContext:null, summarizedUpToMessageId:null }),
    appendMessage: async () => ({ id:"m1" }),
    getMessagesSince: async () => [],
    summarizeIfNeeded,
  }),
}));
vi.mock("../services/internal-agent/commander-context.js", () => ({ loadCommanderPersona: async () => "P" }));
vi.mock("../services/internal-agent/commander-skills.js", () => ({ buildSkillsSection: async () => "", buildCompactSkillList: async () => "" }));
vi.mock("../services/company-skills.js", () => ({ companySkillService: () => ({ listRuntimeSkillEntries: async () => [], listCompactSkillEntries: async () => [] }) }));
vi.mock("../services/memory.js", () => ({ memoryService: () => ({ searchSemantic: async () => [] }) }));
vi.mock("../agent-instructions.js", () => ({ agentInstructionsService: () => ({}) }));
vi.mock("../services/internal-agent/cli-summarizer.js", () => ({ summarizeViaCli: vi.fn(async ()=> "S") }));
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

describe("agent-loop compaction", () => {
  it("calls summarizeIfNeeded after a clean turn and never throws when it fails", async () => {
    summarizeIfNeeded.mockRejectedValueOnce(new Error("boom"));
    const db:any = { select: () => ({ from: () => ({ where: () => ({ then:(r:any)=>Promise.resolve([{ cliTool:"claude_cli", cheapModel:"claude-haiku-4-5" }]).then(r) }) }) }) };
    const gen = agentLoopService(db).chat({ companyId:"c1", userId:"u1", userRole:"founder", enabledCapabilities:[], content:"q" });
    const chunks:any[]=[]; for await (const c of gen) chunks.push(c);
    expect(summarizeIfNeeded).toHaveBeenCalled();
    expect(chunks.some(c=>c.type==="text")).toBe(true); // reply still delivered despite summarize throw
  });
});
