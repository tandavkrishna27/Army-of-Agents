import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (same pattern as agent-loop.test.ts) ────────────────────────────────

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  and: vi.fn((...args: unknown[]) => args),
  ne: vi.fn((a: unknown, b: unknown) => ({ ne: [a, b] })),
  sql: Object.assign(
    vi.fn((strings: any, ...values: any[]) => ({ sql: strings, values })),
    { raw: vi.fn((input: any) => input) },
  ),
}));

vi.mock("@armyofagents/db", () => ({
  internalAgentConfig: { __table: "internal_agent_config", companyId: Symbol("companyId") },
  agents: { __table: "agents", id: "id", companyId: "companyId", name: "name", adapterConfig: "adapterConfig" },
}));

const appendMessage = vi.fn(async () => ({ id: "msg" }));
const getOrCreateActive = vi.fn();
const getById = vi.fn();
vi.mock("../services/internal-agent/conversation.js", () => ({
  conversationService: vi.fn(() => ({
    getOrCreateActive,
    appendMessage,
    getById,
    getMessagesSince: vi.fn(async () => []),
    summarizeIfNeeded: vi.fn(async () => {}),
  })),
}));

const cliChat = vi.fn();
vi.mock("../services/internal-agent/cli-mode.js", () => ({
  cliModeService: vi.fn(() => ({ chat: cliChat })),
}));

vi.mock("../services/company-skills.js", () => ({
  companySkillService: vi.fn(() => ({ listCompactSkillEntries: vi.fn(async () => []) })),
}));
vi.mock("../services/internal-agent/commander-skills.js", () => ({
  buildCompactSkillList: vi.fn(async () => null),
}));
vi.mock("../services/internal-agent/context-assembly.js", () => ({
  contextAssemblyService: vi.fn(() => ({ assembleContext: vi.fn(async () => ({ systemPrompt: "" })) })),
}));
vi.mock("../services/internal-agent/commander-context.js", () => ({
  loadCommanderPersona: vi.fn(async () => null),
}));
vi.mock("../services/internal-agent/aoa-agents/ensure-commander.js", () => ({
  ensureCommanderAgent: vi.fn(async () => "commander-id"),
}));
vi.mock("../services/internal-agent/cli-summarizer.js", () => ({
  summarizeViaCli: vi.fn(async () => ""),
}));
vi.mock("../services/memory.js", () => ({
  memoryService: vi.fn(() => ({ searchSemantic: vi.fn(async () => []) })),
}));
vi.mock("../services/agent-instructions.js", () => ({
  agentInstructionsService: vi.fn(() => ({})),
}));

import { agentLoopService } from "../services/internal-agent/agent-loop.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const COMPANY_A = "company-aaaa-aaaa-4aaa-8aaa-000000000001";
const COMPANY_B = "company-bbbb-bbbb-4bbb-8bbb-000000000002";
const USER_A    = "user-aaaa-aaaa-4aaa-8aaa-000000000001";
const USER_B    = "user-bbbb-bbbb-4bbb-8bbb-000000000002";

// A mock DB that has a config row for company A (so the chat doesn't hit
// "not configured" before we can test the ownership guard).
function makeDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: vi.fn((fn: (rows: any[]) => any) =>
            fn([{ enabledCapabilities: [] }]),
          ),
        })),
      })),
    })),
  };
}

async function collectChunks(gen: AsyncGenerator<any>) {
  const chunks: any[] = [];
  for await (const c of gen) chunks.push(c);
  return chunks;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("agentLoopService.chat — conversation ownership guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cliChat.mockReturnValue(
      (async function* () { yield { type: "done", summary: { runId: "r", toolsCalled: [], durationMs: 0, costCents: 0, tokenUsage: { inputTokens: 0, outputTokens: 0 } } }; })()
    );
  });

  it("rejects a conversation belonging to a different user (same company)", async () => {
    // getById returns a conversation owned by USER_B, but caller is USER_A
    getById.mockResolvedValue({ id: "conv-b", companyId: COMPANY_A, userId: USER_B });

    const svc = agentLoopService(makeDb() as any);
    const chunks = await collectChunks(svc.chat({
      companyId: COMPANY_A,
      userId: USER_A,
      userRole: "member",
      enabledCapabilities: [],
      content: "hello",
      conversationId: "conv-b",
    }));

    const errChunk = chunks.find((c) => c.type === "error");
    expect(errChunk).toBeDefined();
    expect(errChunk.message).toMatch(/not found/i);
    expect(appendMessage).not.toHaveBeenCalled();
  });

  it("rejects a conversation belonging to a different company", async () => {
    // getById returns a conversation from COMPANY_B
    getById.mockResolvedValue({ id: "conv-b-co", companyId: COMPANY_B, userId: USER_A });

    const svc = agentLoopService(makeDb() as any);
    const chunks = await collectChunks(svc.chat({
      companyId: COMPANY_A,
      userId: USER_A,
      userRole: "member",
      enabledCapabilities: [],
      content: "hello",
      conversationId: "conv-b-co",
    }));

    const errChunk = chunks.find((c) => c.type === "error");
    expect(errChunk).toBeDefined();
    expect(appendMessage).not.toHaveBeenCalled();
  });

  it("rejects when getById returns null (unknown UUID)", async () => {
    getById.mockResolvedValue(null);

    const svc = agentLoopService(makeDb() as any);
    const chunks = await collectChunks(svc.chat({
      companyId: COMPANY_A,
      userId: USER_A,
      userRole: "member",
      enabledCapabilities: [],
      content: "hello",
      conversationId: "conv-unknown",
    }));

    const errChunk = chunks.find((c) => c.type === "error");
    expect(errChunk).toBeDefined();
    expect(appendMessage).not.toHaveBeenCalled();
  });

  it("allows a conversation that belongs to the correct user and company", async () => {
    // getById returns a conversation correctly owned by USER_A in COMPANY_A
    getById.mockResolvedValue({ id: "conv-a", companyId: COMPANY_A, userId: USER_A, summarizedUpToMessageId: null });

    const svc = agentLoopService(makeDb() as any);
    const chunks = await collectChunks(svc.chat({
      companyId: COMPANY_A,
      userId: USER_A,
      userRole: "member",
      enabledCapabilities: [],
      content: "hello",
      conversationId: "conv-a",
    }));

    // No error chunk — the message was processed
    expect(chunks.find((c) => c.type === "error")).toBeUndefined();
    expect(appendMessage).toHaveBeenCalled();
    expect(appendMessage).toHaveBeenCalledWith(
      "conv-a",
      expect.objectContaining({ role: "user", content: "hello" }),
    );
  });
});
