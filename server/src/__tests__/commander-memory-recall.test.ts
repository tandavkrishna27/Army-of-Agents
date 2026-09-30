import { beforeEach, describe, expect, it, vi } from "vitest";
import { MEMORY_RETRIEVAL_TRIGGERS } from "@armyofagents/shared";

const recallMocks = vi.hoisted(() => ({
  searchMultiPath: vi.fn(),
  recordMemoryRetrievals: vi.fn(async () => undefined),
  updateValues: vi.fn(),
}));

vi.mock("../services/memory.js", () => ({
  memoryService: () => ({
    searchMultiPath: recallMocks.searchMultiPath,
  }),
}));

vi.mock("../services/memory-retrieval-audit.js", () => ({
  recordMemoryRetrievals: recallMocks.recordMemoryRetrievals,
}));

vi.mock("@armyofagents/db", () => ({
  memoryItems: {
    id: Symbol("memoryItems.id"),
    companyId: Symbol("memoryItems.companyId"),
    accessedAt: Symbol("memoryItems.accessedAt"),
  },
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => ({ op: "and", args })),
  eq: vi.fn((left: unknown, right: unknown) => ({ op: "eq", left, right })),
  inArray: vi.fn(() => "inArray"),
}));

import {
  DEFAULT_COMMANDER_MEMORY_RECALL_POLICY,
  applyCommanderRecallStrictness,
  buildCommanderMemoryRecallQuery,
  commanderMemoryRecallService,
  normalizeCommanderMemoryRecallPolicy,
  resetCommanderMemoryRecallCircuitBreakersForTests,
  type CommanderRecallCandidate,
} from "../services/internal-agent/memory-recall.js";

function buildDb() {
  return {
    update: vi.fn(() => ({
      set: vi.fn((values: unknown) => {
        recallMocks.updateValues(values);
        return {
          where: vi.fn(() => ({
            execute: vi.fn(async () => undefined),
          })),
        };
      }),
    })),
  } as any;
}

function recallItem(overrides: Partial<CommanderRecallCandidate>): CommanderRecallCandidate {
  return {
    id: "memory-1",
    title: "Memory",
    content: "Content",
    layer: "domain",
    status: "approved",
    visibility: "scoped",
    expiresAt: null,
    conversationId: null,
    createdBy: "user-1",
    departmentId: null,
    projectId: null,
    goalId: null,
    taskId: null,
    retrievalRank: 1,
    similarity: null,
    semanticRank: null,
    keywordRank: 1,
    temporalRank: null,
    finalScore: 0.016,
    ...overrides,
  };
}

function searchResult(overrides: Partial<Record<string, unknown>>) {
  return {
    id: "shown",
    companyId: "company-1",
    title: "Refund policy",
    content: "30 days",
    category: "policy",
    source: "founder",
    status: "approved",
    visibility: "shared",
    expiresAt: null,
    conversationId: null,
    createdBy: "founder-1",
    tags: [],
    departmentId: null,
    projectId: null,
    goalId: null,
    taskId: null,
    layer: "identity",
    priority: 0,
    validationCount: 1,
    agentId: null,
    pinnedToSkill: false,
    createdAt: new Date("2026-05-01"),
    updatedAt: new Date("2026-05-01"),
    rrfScore: 0.02,
    finalScore: 0.02,
    similarity: 0.9,
    semanticRank: 1,
    keywordRank: null,
    temporalRank: null,
    ...overrides,
  };
}

beforeEach(() => {
  recallMocks.searchMultiPath.mockReset();
  recallMocks.recordMemoryRetrievals.mockClear();
  recallMocks.updateValues.mockClear();
  resetCommanderMemoryRecallCircuitBreakersForTests();
});

describe("Commander memory recall audit trigger", () => {
  it("declares commander_context for automatic Commander prompt recall", () => {
    expect(MEMORY_RETRIEVAL_TRIGGERS).toContain("commander_context");
  });
});

describe("Commander memory recall policy", () => {
  it("defaults to balanced layered recall", () => {
    expect(DEFAULT_COMMANDER_MEMORY_RECALL_POLICY).toMatchObject({
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
        working: true,
      },
    });
  });

  it("normalizes malformed policy metadata to safe defaults", () => {
    const policy = normalizeCommanderMemoryRecallPolicy({
      enabled: "maybe",
      strictness: "wild",
      timeoutMs: 999999,
      maxItems: 999,
      layers: { working: "yes" },
    });

    expect(policy.enabled).toBe(true);
    expect(policy.strictness).toBe("balanced");
    expect(policy.timeoutMs).toBe(3000);
    expect(policy.maxItems).toBe(8);
    expect(policy.layers.working).toBe(true);
  });

  it("treats explicit string false as disabled", () => {
    expect(normalizeCommanderMemoryRecallPolicy({ enabled: "false" }).enabled).toBe(false);
  });
});

describe("Commander memory recall query", () => {
  it("uses the latest user message as the primary query", () => {
    expect(buildCommanderMemoryRecallQuery({
      latestUserMessage: "What did we decide about refunds?",
    })).toBe("What did we decide about refunds?");
  });

  it("strips recalled memory plugin blocks and code fences", () => {
    const query = buildCommanderMemoryRecallQuery({
      latestUserMessage: [
        "```json",
        "{\"debug\":true}",
        "```",
        "<active_memory_plugin source=\"previous\">old memory</active_memory_plugin>",
        "## Relevant Company Memory",
        "Refund policy: old injected memory",
        "What did we decide about refunds?",
      ].join("\n"),
    });

    expect(query).toBe("What did we decide about refunds?");
  });

  it("clamps very long queries", () => {
    const query = buildCommanderMemoryRecallQuery({
      latestUserMessage: "x".repeat(1000),
    });

    expect(query.length).toBeLessThanOrEqual(480);
  });
});

describe("Commander recall strictness", () => {
  it("balanced keeps strong semantic or keyword results", () => {
    const out = applyCommanderRecallStrictness({
      items: [
        recallItem({ id: "semantic", similarity: 0.86, semanticRank: 1 }),
        recallItem({ id: "keyword", similarity: null, keywordRank: 1, retrievalRank: 2 }),
      ],
      strictness: "balanced",
    });
    expect(out.map((item) => item.id)).toEqual(["semantic", "keyword"]);
  });

  it("precision-heavy drops weak temporal-only results", () => {
    const out = applyCommanderRecallStrictness({
      items: [recallItem({ similarity: null, keywordRank: null, temporalRank: 1, finalScore: 0.016 })],
      strictness: "precision-heavy",
    });
    expect(out).toEqual([]);
  });

  it("recall-heavy keeps temporal results from multi-path ranking", () => {
    const out = applyCommanderRecallStrictness({
      items: [recallItem({ similarity: null, keywordRank: null, temporalRank: 1, finalScore: 0.016 })],
      strictness: "recall-heavy",
    });
    expect(out).toHaveLength(1);
  });
});

describe("Commander memory recall runtime", () => {
  it("uses searchMultiPath and audits shown plus filtered items", async () => {
    recallMocks.searchMultiPath.mockResolvedValue([
      searchResult({ id: "shown" }),
      searchResult({
        id: "filtered",
        title: "Working note",
        content: "private scratch",
        category: "context",
        source: "commander",
        status: "pending",
        layer: "working",
        visibility: "scoped",
        departmentId: "dept-2",
        similarity: 0.91,
        semanticRank: 2,
        finalScore: 0.019,
      }),
    ]);

    const db = buildDb();
    const out = await commanderMemoryRecallService(db).recall({
      companyId: "company-1",
      userId: "user-1",
      userRole: "founder",
      agentId: "commander-agent",
      latestUserMessage: "refund policy",
      scope: { departmentId: "dept-1" },
    });

    expect(out.status).toBe("ok");
    expect(out.items.map((item) => item.id)).toEqual(["shown"]);
    expect(recallMocks.searchMultiPath).toHaveBeenCalledWith("company-1", "refund policy", { limit: 8 });
    expect(recallMocks.recordMemoryRetrievals).toHaveBeenCalledWith(db, {
      companyId: "company-1",
      agentId: "commander-agent",
      taskId: null,
      runId: null,
      conversationId: null, // no conversationId passed in this call → null recorded
      triggeredBy: "commander_context",
      query: "refund policy",
      items: [
        { id: "shown", rank: 1, similarityScore: 0.9, shownToAgent: true },
        { id: "filtered", rank: 2, similarityScore: 0.91, shownToAgent: false },
      ],
    });
    expect(recallMocks.updateValues).toHaveBeenCalledWith(expect.objectContaining({ accessedAt: expect.any(Date) }));
  });

  // ── Codex P2 #2: conversationId recorded on auto-recall (commander_context) ──

  it("records conversationId when called with the real agent-loop shape (Codex P2 #2)", async () => {
    // Mirrors how agent-loop.ts:226-234 calls recall:
    //   recall({ …, conversationId: conversation.id, scope: { conversationId: conversation.id, … } })
    recallMocks.searchMultiPath.mockResolvedValue([
      searchResult({ id: "mem-1" }),
    ]);

    const db = buildDb();
    await commanderMemoryRecallService(db).recall({
      companyId: "company-1",
      userId: "user-1",
      userRole: "founder",
      agentId: "commander-agent",
      latestUserMessage: "refund policy",
      conversationId: "conv-abc-123",
      scope: { conversationId: "conv-abc-123", departmentId: "dept-1" },
    });

    expect(recallMocks.recordMemoryRetrievals).toHaveBeenCalledWith(db, expect.objectContaining({
      triggeredBy: "commander_context",
      conversationId: "conv-abc-123",
    }));
  });

  it("records conversationId: null when both input.conversationId and scope.conversationId are absent (both-absent contract)", async () => {
    // Documents the contract: if a caller forgets conversationId, the audit row is
    // still written with conversationId: null — the row is invisible to the
    // conversation Memory card but not silently dropped.
    recallMocks.searchMultiPath.mockResolvedValue([
      searchResult({ id: "mem-2" }),
    ]);

    const db = buildDb();
    await commanderMemoryRecallService(db).recall({
      companyId: "company-1",
      userId: "user-1",
      userRole: "founder",
      agentId: "commander-agent",
      latestUserMessage: "refund policy",
      // conversationId intentionally absent
      scope: { departmentId: "dept-1" }, // scope.conversationId also absent
    });

    expect(recallMocks.recordMemoryRetrievals).toHaveBeenCalledWith(db, expect.objectContaining({
      triggeredBy: "commander_context",
      conversationId: null,
    }));
  });

  it("returns timeout when search exceeds policy timeout", async () => {
    recallMocks.searchMultiPath.mockReturnValue(new Promise(() => undefined));
    const out = await commanderMemoryRecallService(buildDb()).recall({
      companyId: "company-1",
      userId: "user-1",
      userRole: "founder",
      latestUserMessage: "refund policy",
      policy: { ...DEFAULT_COMMANDER_MEMORY_RECALL_POLICY, timeoutMs: 1 },
    });

    expect(out.status).toBe("timeout");
    expect(out.items).toEqual([]);
  });

  it("does not search or audit when recall is disabled", async () => {
    const out = await commanderMemoryRecallService(buildDb()).recall({
      companyId: "company-1",
      userId: "user-1",
      userRole: "founder",
      latestUserMessage: "refund policy",
      policy: { ...DEFAULT_COMMANDER_MEMORY_RECALL_POLICY, enabled: false },
    });

    expect(out.status).toBe("disabled");
    expect(recallMocks.searchMultiPath).not.toHaveBeenCalled();
    expect(recallMocks.recordMemoryRetrievals).not.toHaveBeenCalled();
  });

  it("returns no_relevant_memory when strictness removes all shown items", async () => {
    recallMocks.searchMultiPath.mockResolvedValue([
      searchResult({
        id: "temporal-only",
        title: "Old note",
        content: "Not enough for precision",
        similarity: null,
        semanticRank: null,
        keywordRank: null,
        temporalRank: 1,
        finalScore: 0.016,
      }),
    ]);

    const out = await commanderMemoryRecallService(buildDb()).recall({
      companyId: "company-1",
      userId: "user-1",
      userRole: "founder",
      latestUserMessage: "refund policy",
      policy: { ...DEFAULT_COMMANDER_MEMORY_RECALL_POLICY, strictness: "precision-heavy" },
    });

    expect(out.status).toBe("no_relevant_memory");
    expect(out.items).toEqual([]);
  });

  it("does not search for an empty cleaned recall query", async () => {
    const out = await commanderMemoryRecallService(buildDb()).recall({
      companyId: "company-1",
      userId: "user-1",
      userRole: "founder",
      latestUserMessage: "```ts\nconst noop = true;\n```",
    });

    expect(out.status).toBe("no_relevant_memory");
    expect(out.query).toBe("");
    expect(recallMocks.searchMultiPath).not.toHaveBeenCalled();
  });

  it("restricts non-founder recall to scoped non-sensitive layers", async () => {
    recallMocks.searchMultiPath.mockResolvedValue([
      searchResult({ id: "identity", layer: "identity" }),
      searchResult({
        id: "domain-scoped",
        layer: "domain",
        departmentId: "dept-1",
        similarity: 0.91,
        semanticRank: 2,
      }),
      searchResult({
        id: "working",
        layer: "working",
        source: "commander",
        visibility: "scoped",
        departmentId: "dept-1",
        conversationId: "conv-1",
        similarity: 0.91,
        semanticRank: 3,
      }),
    ]);

    const out = await commanderMemoryRecallService(buildDb()).recall({
      companyId: "company-1",
      userId: "user-1",
      userRole: "member",
      latestUserMessage: "refund policy",
      scope: { departmentId: "dept-1", conversationId: "conv-1" },
    });

    expect(out.status).toBe("ok");
    expect(out.items.map((item) => item.id)).toEqual(["domain-scoped", "working"]);
  });
});

describe("Commander memory recall circuit breaker", () => {
  it("skips search after repeated timeouts for the same company/user", async () => {
    recallMocks.searchMultiPath.mockReturnValue(new Promise(() => undefined));

    const policy = {
      ...DEFAULT_COMMANDER_MEMORY_RECALL_POLICY,
      timeoutMs: 1,
      circuitBreakerMaxTimeouts: 1,
    };

    const first = await commanderMemoryRecallService(buildDb()).recall({
      companyId: "company-1",
      userId: "user-1",
      userRole: "founder",
      latestUserMessage: "refunds",
      policy,
    });
    const second = await commanderMemoryRecallService(buildDb()).recall({
      companyId: "company-1",
      userId: "user-1",
      userRole: "founder",
      latestUserMessage: "refunds",
      policy,
    });

    expect(first.status).toBe("timeout");
    expect(second.status).toBe("circuit_breaker");
  });

  it("resets after a successful recall", async () => {
    recallMocks.searchMultiPath
      .mockReturnValueOnce(new Promise(() => undefined))
      .mockResolvedValueOnce([
        searchResult({ id: "shown", layer: "identity", similarity: 0.9, semanticRank: 1 }),
      ])
      .mockResolvedValueOnce([
        searchResult({ id: "shown-again", layer: "identity", similarity: 0.9, semanticRank: 1 }),
      ]);

    const policy = {
      ...DEFAULT_COMMANDER_MEMORY_RECALL_POLICY,
      timeoutMs: 1,
      circuitBreakerMaxTimeouts: 2,
    };

    const timeout = await commanderMemoryRecallService(buildDb()).recall({
      companyId: "company-1",
      userId: "user-1",
      userRole: "founder",
      latestUserMessage: "refunds",
      policy,
    });
    const success = await commanderMemoryRecallService(buildDb()).recall({
      companyId: "company-1",
      userId: "user-1",
      userRole: "founder",
      latestUserMessage: "refunds",
      policy,
    });
    const stillOpen = await commanderMemoryRecallService(buildDb()).recall({
      companyId: "company-1",
      userId: "user-1",
      userRole: "founder",
      latestUserMessage: "refunds",
      policy: { ...policy, circuitBreakerMaxTimeouts: 1 },
    });

    expect(timeout.status).toBe("timeout");
    expect(success.status).toBe("ok");
    expect(stillOpen.status).toBe("ok");
  });

  it("opens after repeated recall failures, not just timeouts", async () => {
    recallMocks.searchMultiPath.mockRejectedValue(new Error("search failed"));

    const policy = {
      ...DEFAULT_COMMANDER_MEMORY_RECALL_POLICY,
      circuitBreakerMaxTimeouts: 1,
    };

    const first = await commanderMemoryRecallService(buildDb()).recall({
      companyId: "company-1",
      userId: "user-1",
      userRole: "founder",
      latestUserMessage: "refunds",
      policy,
    });
    const second = await commanderMemoryRecallService(buildDb()).recall({
      companyId: "company-1",
      userId: "user-1",
      userRole: "founder",
      latestUserMessage: "refunds",
      policy,
    });

    expect(first.status).toBe("failed");
    expect(second.status).toBe("circuit_breaker");
    expect(recallMocks.searchMultiPath).toHaveBeenCalledTimes(1);
  });
});
