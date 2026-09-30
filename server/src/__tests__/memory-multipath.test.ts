import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTableProxy, drizzleOperatorStubs, mockDbCapabilities } from "./helpers/drizzle-mock.js";

vi.mock("@armyofagents/db", () => ({
  memoryItems: makeTableProxy("memory_items"),
  memoryItemVersions: makeTableProxy("memory_item_versions"),
  memoryRetrievals: makeTableProxy("memory_retrievals"),
  agents: makeTableProxy("agents"),
  suggestions: makeTableProxy("suggestions"),
}));

vi.mock("drizzle-orm", () => drizzleOperatorStubs());
vi.mock("../services/db-capabilities.js", () => mockDbCapabilities());

vi.mock("../services/embeddings.js", () => ({
  generateEmbedding: vi.fn(async (_: string, __: string) => Array(1536).fill(0.1)),
}));

vi.mock("../adapters/api-common.js", () => ({
  // Default: no API key (semantic disabled). Tests that need the
  // semantic path mock this per-test.
  resolveApiKey: vi.fn(async () => {
    throw new Error("No API key");
  }),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { memoryService } from "../services/memory.js";
import { recordMemoryRetrievals } from "../services/memory-retrieval-audit.js";

type Row = Record<string, unknown>;

/**
 * Sequence-based mock db. Each `db.select()` call consumes the next
 * pre-configured result array. Each `db.insert()` call captures values
 * and returns the next insert result.
 *
 * For multi-path search we run 3 pathways in Promise.all: their order
 * within the queue is [semantic, keyword, temporal]. When semantic is
 * disabled (no pgvector OR no API key), only keyword + temporal queries
 * fire, so the queue is [keyword, temporal].
 */
function makeMockDb(config: { selects?: Row[][]; inserts?: Row[][] } = {}) {
  let selectIdx = 0;
  let insertIdx = 0;
  const captured: { inserts: unknown[][] } = { inserts: [] };

  const buildChain = (getResult: () => Row[]) => {
    const chain: Record<string, unknown> = {};
    for (const method of ["from", "where", "orderBy", "limit", "returning", "innerJoin", "leftJoin"]) {
      (chain as Record<string, (...a: unknown[]) => unknown>)[method] = () => chain;
    }
    (chain as { values: (v: unknown[]) => unknown }).values = (v: unknown[]) => {
      captured.inserts.push(v);
      return chain;
    };
    (chain as { then: (r: (rows: Row[]) => unknown) => Promise<unknown> }).then = (
      resolve: (rows: Row[]) => unknown,
    ) => Promise.resolve(resolve(getResult()));
    return chain;
  };

  return {
    db: {
      select: () => buildChain(() => config.selects?.[selectIdx++] ?? []),
      insert: () => buildChain(() => config.inserts?.[insertIdx++] ?? []),
    } as unknown as Parameters<typeof memoryService>[0],
    captured,
  };
}

function makeRow(overrides: Partial<Row> = {}): Row {
  return {
    id: overrides.id ?? "mem-1",
    companyId: "co-1",
    title: "Test item",
    content: "Test content",
    category: "reference",
    source: "founder",
    status: "approved",
    tags: [],
    departmentId: null,
    projectId: null,
    goalId: null,
    taskId: null,
    conversationId: null,
    createdBy: "founder-1",
    layer: "domain",
    visibility: "scoped",
    expiresAt: null,
    priority: 0,
    validationCount: 1,
    agentId: null,
    pinnedToSkill: false,
    accessedAt: null,
    lastValidatedAt: null,
    createdAt: new Date("2026-04-01"),
    updatedAt: new Date("2026-04-01"),
    ...overrides,
  };
}

describe("memoryService.searchMultiPath", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("merges keyword + temporal pathways via RRF when semantic is unavailable", async () => {
    // Semantic disabled (no API key per default mock).
    // Queue: [keyword, temporal].
    const item1 = makeRow({ id: "item-1", title: "Brand voice" });
    const item2 = makeRow({ id: "item-2", title: "Logo guide" });
    const { db } = makeMockDb({
      selects: [
        [item1, item2],     // keyword pathway: item-1 rank 1, item-2 rank 2
        [item2, item1],     // temporal pathway: item-2 rank 1, item-1 rank 2
      ],
    });

    const svc = memoryService(db);
    const results = await svc.searchMultiPath("co-1", "brand", { limit: 10 });

    expect(results).toHaveLength(2);
    expect(results[0]).toHaveProperty("conversationId");
    expect(results[0]).toHaveProperty("status");
    expect(results[0]).toHaveProperty("visibility");
    expect(results[0]).toHaveProperty("expiresAt");
    expect(results[0]).toHaveProperty("createdBy");
    // Both items appear in both pathways → both get RRF contributions from
    // both. Their final ordering depends on RRF + trust. Trust is equal
    // (validationCount=1 for both, no accessedAt/lastValidatedAt).
    // RRF for item-1: 1/(60+1) + 1/(60+2) = 1/61 + 1/62 ≈ 0.0327
    // RRF for item-2: 1/(60+2) + 1/(60+1) = same ≈ 0.0327
    // Tie — both should have similar finalScore.
    expect(results[0].rrfScore).toBeCloseTo(1 / 61 + 1 / 62, 4);
    expect(results[1].rrfScore).toBeCloseTo(1 / 61 + 1 / 62, 4);
  });

  it("ranks items higher when they appear in multiple pathways", async () => {
    // item-A appears in BOTH keyword and temporal at rank 1.
    // item-B appears only in temporal at rank 2.
    const itemA = makeRow({ id: "item-A" });
    const itemB = makeRow({ id: "item-B" });
    const { db } = makeMockDb({
      selects: [
        [itemA],          // keyword: A rank 1
        [itemA, itemB],   // temporal: A rank 1, B rank 2
      ],
    });

    const svc = memoryService(db);
    const results = await svc.searchMultiPath("co-1", "test", { limit: 10 });

    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("item-A"); // higher rrfScore (in 2 pathways)
    expect(results[1].id).toBe("item-B");
    expect(results[0].rrfScore).toBeGreaterThan(results[1].rrfScore);
  });

  it("trust-weights items with higher validationCount above unvalidated peers", async () => {
    // Both items at rank 1 in both pathways → equal RRF.
    // Item with higher validationCount should rank higher via trust weight.
    const high = makeRow({ id: "high", validationCount: 100 });
    const low = makeRow({ id: "low", validationCount: 1 });
    const { db } = makeMockDb({
      selects: [
        [high, low], // keyword: high rank 1, low rank 2
        [high, low], // temporal: same
      ],
    });

    const svc = memoryService(db);
    const results = await svc.searchMultiPath("co-1", "test", { limit: 10 });

    expect(results[0].id).toBe("high");
    expect(results[0].finalScore).toBeGreaterThan(results[1].finalScore);
    // Trust bonus: log(1 + validationCount) * 0.1
    // high gets ~log(101)*0.1 ≈ 0.46 bonus
    // low gets log(2)*0.1 ≈ 0.069 bonus
    expect(results[0].validationCount).toBe(100);
  });

  it("returns empty array when both pathways return nothing", async () => {
    const { db } = makeMockDb({
      selects: [[], []],
    });

    const svc = memoryService(db);
    const results = await svc.searchMultiPath("co-1", "nonexistent", { limit: 10 });

    expect(results).toEqual([]);
  });

  it("respects the limit parameter (top-K)", async () => {
    const items = Array.from({ length: 20 }, (_, i) => makeRow({ id: `item-${i}` }));
    const { db } = makeMockDb({
      selects: [items, items],
    });

    const svc = memoryService(db);
    const results = await svc.searchMultiPath("co-1", "test", { limit: 5 });

    expect(results).toHaveLength(5);
  });

  it("skips keyword pathway when query is empty", async () => {
    // Empty query → keyword skipped (no select call).
    // Only temporal pathway runs.
    const item = makeRow({ id: "item-1" });
    const { db } = makeMockDb({
      selects: [[item]], // only temporal call
    });

    const svc = memoryService(db);
    const results = await svc.searchMultiPath("co-1", "", { limit: 10 });

    expect(results).toHaveLength(1);
    expect(results[0].temporalRank).toBe(1);
    expect(results[0].keywordRank).toBeNull();
  });

  it("disables individual pathways via filter flags", async () => {
    const item = makeRow({ id: "item-1" });
    const { db } = makeMockDb({
      selects: [[item]], // only keyword call (semantic + temporal disabled)
    });

    const svc = memoryService(db);
    const results = await svc.searchMultiPath("co-1", "test", {
      enableSemantic: false,
      enableTemporal: false,
      limit: 10,
    });

    expect(results).toHaveLength(1);
    expect(results[0].keywordRank).toBe(1);
    expect(results[0].temporalRank).toBeNull();
    expect(results[0].semanticRank).toBeNull();
  });

  it("populates per-pathway ranks and similarity field correctly", async () => {
    const item = makeRow({ id: "item-1" });
    const { db } = makeMockDb({
      selects: [
        [item],          // keyword rank 1
        [item],          // temporal rank 1
      ],
    });

    const svc = memoryService(db);
    const results = await svc.searchMultiPath("co-1", "test", { limit: 10 });

    expect(results).toHaveLength(1);
    expect(results[0].keywordRank).toBe(1);
    expect(results[0].temporalRank).toBe(1);
    expect(results[0].semanticRank).toBeNull();
    expect(results[0].similarity).toBeNull(); // semantic didn't run
  });

  it("preserves goal and task scope fields in results", async () => {
    const item = makeRow({ id: "item-1", goalId: "goal-1", taskId: "task-1" });
    const { db } = makeMockDb({
      selects: [[item]],
    });

    const svc = memoryService(db);
    const results = await svc.searchMultiPath("co-1", "", { limit: 10 });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      goalId: "goal-1",
      taskId: "task-1",
    });
  });

  it("searchAuditCandidates includes non-approved keyword candidates for retrieval audit", async () => {
    const pending = makeRow({ id: "pending", status: "pending" });
    const rejected = makeRow({ id: "rejected", status: "rejected" });
    const { db } = makeMockDb({
      selects: [[pending, rejected]],
    });

    const svc = memoryService(db);
    const results = await svc.searchAuditCandidates("co-1", "test", { limit: 10 });

    expect(results).toEqual([
      expect.objectContaining({ id: "pending", status: "pending" }),
      expect.objectContaining({ id: "rejected", status: "rejected" }),
    ]);
  });
});

describe("recordMemoryRetrievals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("inserts one row per item with the right fields", async () => {
    const { db, captured } = makeMockDb({
      inserts: [[]],
    });

    await recordMemoryRetrievals(db as any, {
      companyId: "co-1",
      agentId: "agent-1",
      runId: "run-1",
      taskId: "task-1",
      triggeredBy: "agent_search",
      query: "brand voice",
      items: [
        { id: "mem-1", rank: 1, similarityScore: 0.92, shownToAgent: true },
        { id: "mem-2", rank: 2, similarityScore: 0.84, shownToAgent: true },
      ],
    });

    expect(captured.inserts).toHaveLength(1);
    const inserted = captured.inserts[0] as Array<Record<string, unknown>>;
    expect(inserted).toHaveLength(2);
    expect(inserted[0].itemId).toBe("mem-1");
    expect(inserted[0].rank).toBe(1);
    expect(inserted[0].similarityScore).toBe("0.92");
    expect(inserted[0].triggeredBy).toBe("agent_search");
    expect(inserted[0].query).toBe("brand voice");
    expect(inserted[1].itemId).toBe("mem-2");
  });

  it("is a no-op when items array is empty", async () => {
    const { db, captured } = makeMockDb({});

    await recordMemoryRetrievals(db as any, {
      companyId: "co-1",
      triggeredBy: "auto",
      items: [],
    });

    expect(captured.inserts).toHaveLength(0);
  });

  it("nulls similarityScore when not finite", async () => {
    const { db, captured } = makeMockDb({
      inserts: [[]],
    });

    await recordMemoryRetrievals(db as any, {
      companyId: "co-1",
      triggeredBy: "agent_get",
      items: [
        { id: "mem-1", similarityScore: NaN },
        { id: "mem-2", similarityScore: undefined },
        { id: "mem-3", similarityScore: 0.5 },
      ],
    });

    const inserted = captured.inserts[0] as Array<Record<string, unknown>>;
    expect(inserted[0].similarityScore).toBeNull();
    expect(inserted[1].similarityScore).toBeNull();
    expect(inserted[2].similarityScore).toBe("0.5");
  });

  it("defaults shownToAgent to true when not provided", async () => {
    const { db, captured } = makeMockDb({
      inserts: [[]],
    });

    await recordMemoryRetrievals(db as any, {
      companyId: "co-1",
      triggeredBy: "skill_materialize",
      items: [{ id: "mem-1" }],
    });

    const inserted = captured.inserts[0] as Array<Record<string, unknown>>;
    expect(inserted[0].shownToAgent).toBe(true);
  });
});
