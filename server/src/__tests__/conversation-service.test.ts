import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  desc: vi.fn((a: unknown) => ({ desc: a })),
  asc: vi.fn((a: unknown) => ({ asc: a })),
  sql: Object.assign(
    vi.fn((strings: unknown, ...values: unknown[]) => ({ sql: strings, values })),
    { raw: vi.fn((s: unknown) => s) },
  ),
  count: vi.fn(() => Symbol("count")),
}));

vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) => {
    const cols: Record<string, symbol> = {};
    return new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (prop === "_") return { name };
        if (prop === "$inferSelect" || prop === "$inferInsert") return {};
        if (typeof prop === "string") {
          if (!cols[prop]) cols[prop] = Symbol(prop);
          return cols[prop];
        }
        return undefined;
      },
    });
  };
  return {
    internalAgentConversations: makeTable("internal_agent_conversations"),
    internalAgentMessages: makeTable("internal_agent_messages"),
  };
});

vi.mock("../middleware/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { conversationService } from "../services/internal-agent/conversation.js";

// NOTE: outputRefs persistence-boundary tests (insert-capture mock style) live in
// server/src/services/internal-agent/__tests__/conversation-output-refs.test.ts.

// ── Helpers ────────────────────────────────────────────────────────────────

type MockRow = Record<string, unknown>;

function createSequenceDb(config: {
  selects?: MockRow[][];
  updates?: MockRow[][];
  inserts?: MockRow[][];
} = {}) {
  let selectIdx = 0;
  let updateIdx = 0;
  let insertIdx = 0;
  const selects = config.selects ?? [];
  const updates = config.updates ?? [];
  const inserts = config.inserts ?? [];

  function makeChain(getResult: () => MockRow[]) {
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "where", "set", "values", "returning", "onConflictDoNothing", "innerJoin", "leftJoin", "orderBy", "limit", "offset"]) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    chain.then = (resolve: (v: MockRow[]) => unknown) =>
      Promise.resolve(resolve(getResult()));
    return chain;
  }

  return {
    select: () => makeChain(() => selects[selectIdx++] ?? []),
    update: (table: unknown) => makeChain(() => updates[updateIdx++] ?? []),
    insert: (table: unknown) => makeChain(() => inserts[insertIdx++] ?? []),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("conversationService", () => {
  describe("getOrCreateActive", () => {
    it("returns existing active conversation", async () => {
      const existing = { id: "conv-1", companyId: "co-1", userId: "user-1", status: "active", messageCount: 5 };
      const db = createSequenceDb({ selects: [[existing]] });
      const svc = conversationService(db as any);

      const result = await svc.getOrCreateActive("co-1", "user-1");
      expect(result).toEqual(existing);
    });

    it("creates new conversation when none exists", async () => {
      const created = { id: "conv-new", companyId: "co-1", userId: "user-1", status: "active", messageCount: 0 };
      const db = createSequenceDb({
        selects: [[]],
        inserts: [[created]],
      });
      const svc = conversationService(db as any);

      const result = await svc.getOrCreateActive("co-1", "user-1");
      expect(result.id).toBe("conv-new");
      expect(result.status).toBe("active");
    });
  });

  describe("appendMessage", () => {
    it("inserts message and increments messageCount", async () => {
      const inserted = { id: "msg-1", conversationId: "conv-1", role: "user", content: "Hello" };
      const db = createSequenceDb({
        inserts: [[inserted]],
        updates: [[{ messageCount: 6 }]],
      });
      const svc = conversationService(db as any);

      const result = await svc.appendMessage("conv-1", {
        role: "user",
        content: "Hello",
      });
      expect(result.id).toBe("msg-1");
      expect(result.role).toBe("user");
    });
  });

  describe("getRecentMessages", () => {
    it("returns messages ordered by createdAt asc", async () => {
      const messages = [
        { id: "m2", role: "assistant", content: "Hello!", createdAt: new Date("2026-01-02") },
        { id: "m1", role: "user", content: "Hi", createdAt: new Date("2026-01-01") },
      ];
      const db = createSequenceDb({ selects: [messages] });
      const svc = conversationService(db as any);

      const result = await svc.getRecentMessages("conv-1");
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("m1");
    });
  });

  describe("summarizeIfNeeded", () => {
    it("no-ops when 20 or fewer messages", async () => {
      const db = createSequenceDb({ selects: [[{ count: 20 }]] });
      const svc = conversationService(db as any);

      const summarize = vi.fn(async (_t: string) => "summary");
      await svc.summarizeIfNeeded("conv-1", summarize);

      expect(summarize).not.toHaveBeenCalled();
    });

    it("triggers summarization when more than 20 messages", async () => {
      const oldMessages = Array.from({ length: 25 }, (_, i) => ({
        id: `m-${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}`,
        createdAt: new Date(2026, 0, i + 1),
      }));

      const db = createSequenceDb({
        selects: [
          [{ count: 25 }],
          oldMessages.slice(0, 5),
        ],
        updates: [[{ id: "conv-1", summarizedContext: "Summary..." }]],
      });

      const summarize = vi.fn(async (_t: string) => "Summarized conversation.");

      const svc = conversationService(db as any);
      await svc.summarizeIfNeeded("conv-1", summarize);

      expect(summarize).toHaveBeenCalled();
    });
  });

  describe("reset", () => {
    it("archives old conversation and creates new", async () => {
      const newConv = { id: "conv-new", companyId: "co-1", userId: "user-1", status: "active", messageCount: 0 };
      const db = createSequenceDb({
        updates: [[{ id: "conv-old", status: "archived" }]],
        inserts: [[newConv]],
      });
      const svc = conversationService(db as any);

      const result = await svc.reset("co-1", "user-1");
      expect(result.id).toBe("conv-new");
      expect(result.status).toBe("active");
    });
  });
});
