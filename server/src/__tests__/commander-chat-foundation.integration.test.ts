import { describe, expect, it, vi } from "vitest";
import { platform } from "node:os";

// ── Mocks must be hoisted before any service import ──────────────────────────

vi.mock("drizzle-orm", () => ({ eq: vi.fn((a:any,b:any)=>({eq:[a,b]})), and: vi.fn((...a:any)=>({and:a})) }));
vi.mock("@armyofagents/db", () => ({ internalAgentConfig: {}, agents: {} }));

const cliCalls: any[] = [];
vi.mock("../services/internal-agent/cli-mode.js", () => ({
  cliModeService: () => ({
    chat: async function* (p: any) {
      cliCalls.push(p);
      yield { type: "text", delta: "Commander reply" };
    },
  }),
}));

const summarizeIfNeeded = vi.fn(async () => {});
vi.mock("../services/internal-agent/conversation.js", () => ({
  conversationService: () => ({
    getOrCreateActive: async () => ({
      id: "conv-int",
      summarizedContext: "SUMMARY OF PRIOR SESSION",
      summarizedUpToMessageId: "msg-anchor",
    }),
    appendMessage: async () => ({ id: "msg-new" }),
    getMessagesSince: async () => ([
      { role: "user", content: "previous question" },
      { role: "assistant", content: "previous answer" },
    ]),
    summarizeIfNeeded,
  }),
}));

vi.mock("../services/internal-agent/commander-context.js", () => ({
  // agent-loop.ts imports assembleAgentPersona (renamed from loadCommanderPersona).
  assembleAgentPersona: async () => "COMMANDER_PERSONA_MARKER",
  loadCommanderPersona: async () => "COMMANDER_PERSONA_MARKER",
}));

vi.mock("../services/internal-agent/commander-skills.js", () => ({
  buildSkillsSection: async () => "",
  buildCompactSkillList: async () =>
    "## Available Skills\nCall `use_skill` with the skill key to load full instructions before applying a skill.\n\n| Skill | When to use |\n|-------|------------|\n| **Brainstorming** (`brainstorming`) | Before building new features |",
}));

vi.mock("../services/company-skills.js", () => ({
  companySkillService: () => ({ listRuntimeSkillEntries: async () => [], listCompactSkillEntries: async () => [] }),
}));

vi.mock("../services/memory.js", () => ({
  memoryService: () => ({
    searchSemantic: async () => [
      { title: "Approved Memory Item", content: "INJECTED_MEMORY_CONTENT", layer: "domain" },
    ],
  }),
}));

// agent-loop now routes Commander memory through commanderMemoryRecallService(db).recall
// (not the old searchSemantic callback). Mock it directly so the injected item flows in.
vi.mock("../services/internal-agent/memory-recall.js", () => ({
  normalizeCommanderMemoryRecallPolicy: () => ({ enabled: true }),
  commanderMemoryRecallService: () => ({
    recall: async () => ({
      status: "ok",
      items: [
        { id: "mem-1", title: "Approved Memory Item", content: "INJECTED_MEMORY_CONTENT", layer: "domain" },
      ],
      query: "refund policy",
      elapsedMs: 1,
    }),
  }),
}));

vi.mock("../agent-instructions.js", () => ({
  agentInstructionsService: () => ({}),
}));

vi.mock("../services/internal-agent/cli-summarizer.js", () => ({
  summarizeViaCli: vi.fn(async () => "COMPACTION_SUMMARY"),
}));

vi.mock("../services/internal-agent/aoa-agents/ensure-commander.js", () => ({
  ensureCommanderAgent: async () => "commander-agent-id",
}));

vi.mock("../services/internal-agent/context-assembly.js", () => ({
  contextAssemblyService: () => ({
    assembleContext: async (_companyId: string, opts: any) => {
      // Exercise the memorySearch callback so injected memory flows into the prompt
      let memoryBlock = "";
      // agent-loop passes the recalled memory as opts.memoryItems; fall back to
      // the legacy memorySearch callback for any other caller.
      const memItems = opts.memoryItems ??
        (opts.memorySearch && opts.relevanceQuery ? await opts.memorySearch(opts.relevanceQuery) : []);
      const relevant = (memItems ?? []).filter((m: any) => m.layer === "identity" || m.layer === "domain");
      if (relevant.length > 0) {
        memoryBlock = "\n\n## Relevant Company Memory\n" +
          relevant.map((m: any) => `${m.title ?? "Memory"}: ${m.content ?? ""}`).join("\n");
      }
      const summary = opts.conversationSummary
        ? `\n\n## Conversation Summary\n${opts.conversationSummary}`
        : "";
      return {
        systemPrompt: (opts.systemInstructions ?? "DEFAULT") + summary + memoryBlock,
        estimatedTokens: 50,
      };
    },
  }),
}));

import { agentLoopService } from "../services/internal-agent/agent-loop.js";

// ── Integration test ─────────────────────────────────────────────────────────
//
// Drives agentLoopService.chat() end-to-end with a mocked CLI and asserts the
// full chain: persona + approved memory item + prior-turn history all appear in
// the assembled prompt, AND the compaction path (summarizeIfNeeded) is invoked.
// This is the integration value the individual unit tests don't prove in a
// single call.
//
// Skipped on Windows because embedded-postgres cannot start on the Windows CI
// runner (Issue #114). AOA_ACCEPTANCE_CLI is NOT required — no real CLI is used.

describe.skipIf(platform() === "win32")("Commander chat foundation (integration)", () => {
  it("single chat() call carries persona + memory + history in assembled prompt AND triggers compaction", async () => {
    const db: any = {
      select: () => ({
        from: () => ({
          where: () => ({
            then: (r: any) =>
              Promise.resolve([{ cliTool: "claude_cli", cheapModel: "claude-haiku-4-5" }]).then(r),
          }),
        }),
      }),
    };

    const chunks: any[] = [];
    for await (const chunk of agentLoopService(db).chat({
      companyId: "c-integration",
      userId: "u-integration",
      userRole: "founder",
      enabledCapabilities: [],
      content: "What is our refund policy?",
    })) {
      chunks.push(chunk);
    }

    // 1. The CLI received exactly one call
    expect(cliCalls).toHaveLength(1);
    const assembled: string = cliCalls[0].content;

    // 2. The assembled prompt contains the Commander persona marker
    expect(assembled).toContain("COMMANDER_PERSONA_MARKER");

    // 3. The assembled prompt contains the injected memory item
    expect(assembled).toContain("INJECTED_MEMORY_CONTENT");

    // 4. The assembled prompt contains both prior-turn history entries
    expect(assembled).toContain("previous question");
    expect(assembled).toContain("previous answer");

    // 5. The reply was streamed to the caller
    expect(chunks.some((c) => c.type === "text" && c.delta === "Commander reply")).toBe(true);

    // 6. The compaction path was reached (summarizeIfNeeded was called)
    expect(summarizeIfNeeded).toHaveBeenCalled();

    // 7. The assembled prompt contains the compact skill list header and use_skill call reference
    expect(assembled).toContain("## Available Skills");
    expect(assembled).toContain("use_skill");
  });
});
