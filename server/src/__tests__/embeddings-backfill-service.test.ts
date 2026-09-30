import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeTableProxy, drizzleOperatorStubs } from "./helpers/drizzle-mock.js";

/**
 * Unit tests for embeddings-backfill.ts (Task 4 + Task W4, keyless-except-embeddings).
 *
 * Covers:
 *   - backfillQueueCompanyIds (Task 4): stamps company_id on pre-keyless queue rows
 *   - reindexCompany (Task W4): requeues failed + enqueues missing for a company
 *   - reconcileNullVectors (Task W4): global sweep for null-vector rows
 *
 * Mocking strategy: follows the same pattern as embedding-retry-persistence.test.ts —
 * Proxy-based table stubs to avoid ESM drizzle-orm circular deps, sequence-based mock
 * DB, and setCalls tracking for update assertions.
 */

vi.mock("@armyofagents/db", () => ({
  embeddingQueue: makeTableProxy("embedding_queue"),
  memoryItems: makeTableProxy("memory_items"),
  discussions: makeTableProxy("discussions"),
  discussionEntries: makeTableProxy("discussion_entries"),
  discussionExtractedItems: makeTableProxy("discussion_extracted_items"),
}));

vi.mock("drizzle-orm", () => drizzleOperatorStubs());

// ── Mocks for new imports in embeddings-backfill.ts ──────────────────────────

const mockGetDbCapabilities = vi.hoisted(() => vi.fn());

vi.mock("../services/db-capabilities.js", () => ({
  getDbCapabilities: mockGetDbCapabilities,
}));

const mockEnqueueMemoryEmbedding = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../services/memory-write.js", () => ({
  enqueueMemoryEmbedding: mockEnqueueMemoryEmbedding,
  writeMemoryAndIndex: vi.fn(),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
  },
}));

// ---------------------------------------------------------------------------
// Sequence-based mock DB with per-operation tracking
// ---------------------------------------------------------------------------
type MockRow = Record<string, unknown>;

function createSequenceDb(config: {
  selects?: MockRow[][];
  updates?: MockRow[][];
} = {}) {
  let selectIdx = 0;
  let updateIdx = 0;
  const selects = config.selects ?? [];
  const updates = config.updates ?? [];

  const setCalls: Array<Record<string, unknown>> = [];
  const whereCalls: Array<unknown> = [];

  function makeChain(getResult: () => MockRow[], trackSet = false) {
    const chain: Record<string, unknown> = {};
    const chainable = [
      "from", "innerJoin", "leftJoin", "where", "values",
      "returning", "orderBy", "limit", "onConflictDoNothing",
    ];
    for (const m of chainable) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    chain.set = (val: Record<string, unknown>) => {
      if (trackSet) setCalls.push(val);
      return chain;
    };
    // where() is called twice per update (once for the condition, we capture
    // the argument to check the queue ID filter)
    chain.where = (arg: unknown) => {
      whereCalls.push(arg);
      return chain;
    };
    chain.then = (resolve: (v: MockRow[]) => unknown) =>
      Promise.resolve(resolve(getResult()));
    return chain;
  }

  return {
    select: (..._args: unknown[]) => makeChain(() => selects[selectIdx++] ?? []),
    update: (..._args: unknown[]) => makeChain(() => updates[updateIdx++] ?? [], true),
    insert: (..._args: unknown[]) => makeChain(() => []),
    setCalls,
    whereCalls,
  };
}

// Import after mocks are registered
import { backfillQueueCompanyIds, reindexCompany, reindexAllCompany, reconcileNullVectors } from "../services/embeddings-backfill.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("backfillQueueCompanyIds", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns { updated: 0 } when all three target-table selects return empty", async () => {
    const db = createSequenceDb({
      selects: [[], [], []], // memory_items, discussions, discussion_extracted_items
    });

    const result = await backfillQueueCompanyIds(db as any);
    expect(result).toEqual({ updated: 0 });
    expect(db.setCalls.length).toBe(0);
  });

  it("updates company_id for memory_items rows", async () => {
    const db = createSequenceDb({
      selects: [
        // memory_items join: 2 rows to backfill
        [
          { queueId: "q-1", companyId: "c-1" },
          { queueId: "q-2", companyId: "c-2" },
        ],
        [], // discussions: none
        [], // discussion_extracted_items: none
      ],
      updates: [{}, {}],
    });

    const result = await backfillQueueCompanyIds(db as any);
    expect(result).toEqual({ updated: 2 });
    expect(db.setCalls.length).toBe(2);
    expect(db.setCalls[0]).toEqual({ companyId: "c-1" });
    expect(db.setCalls[1]).toEqual({ companyId: "c-2" });
  });

  it("updates company_id for discussions rows", async () => {
    const db = createSequenceDb({
      selects: [
        [], // memory_items: none
        [{ queueId: "q-3", companyId: "c-10" }], // discussions: 1 row
        [], // discussion_extracted_items: none
      ],
      updates: [{}],
    });

    const result = await backfillQueueCompanyIds(db as any);
    expect(result).toEqual({ updated: 1 });
    expect(db.setCalls.length).toBe(1);
    expect(db.setCalls[0]).toEqual({ companyId: "c-10" });
  });

  it("updates company_id for discussion_extracted_items rows (2-hop join)", async () => {
    const db = createSequenceDb({
      selects: [
        [], // memory_items: none
        [], // discussions: none
        // discussion_extracted_items → entries → discussions: 1 row
        [{ queueId: "q-5", companyId: "c-99" }],
      ],
      updates: [{}],
    });

    const result = await backfillQueueCompanyIds(db as any);
    expect(result).toEqual({ updated: 1 });
    expect(db.setCalls.length).toBe(1);
    expect(db.setCalls[0]).toEqual({ companyId: "c-99" });
  });

  it("aggregates updates across all three target tables", async () => {
    const db = createSequenceDb({
      selects: [
        [{ queueId: "q-A", companyId: "c-A" }], // memory_items: 1
        [{ queueId: "q-B", companyId: "c-B" }], // discussions: 1
        [{ queueId: "q-C", companyId: "c-C" }], // discussion_extracted_items: 1
      ],
      updates: [{}, {}, {}],
    });

    const result = await backfillQueueCompanyIds(db as any);
    expect(result).toEqual({ updated: 3 });
    expect(db.setCalls.length).toBe(3);
    expect(db.setCalls[0]).toEqual({ companyId: "c-A" });
    expect(db.setCalls[1]).toEqual({ companyId: "c-B" });
    expect(db.setCalls[2]).toEqual({ companyId: "c-C" });
  });

  it("is idempotent — second run with no NULL rows updates 0 rows", async () => {
    // All three selects return empty (no NULL company_id rows remain)
    const db = createSequenceDb({ selects: [[], [], []] });

    const result1 = await backfillQueueCompanyIds(db as any);
    expect(result1).toEqual({ updated: 0 });
    expect(db.setCalls.length).toBe(0);
  });

  it("handles multiple rows per target table in a single call", async () => {
    const db = createSequenceDb({
      selects: [
        [
          { queueId: "q-1", companyId: "c-1" },
          { queueId: "q-2", companyId: "c-1" },
          { queueId: "q-3", companyId: "c-2" },
        ],
        [],
        [],
      ],
      updates: [{}, {}, {}],
    });

    const result = await backfillQueueCompanyIds(db as any);
    expect(result).toEqual({ updated: 3 });
    expect(db.setCalls.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// reindexCompany (Task W4)
// ---------------------------------------------------------------------------

/**
 * Build a mock DB for reindexCompany/reconcileNullVectors.
 *
 * select calls are returned in order. The function needs:
 *   - select #0 (reindexCompany): failed rows for the company
 *   - select #1 (reindexCompany): live (pending|processing) queue rows
 *   - select #2 (reindexCompany): missing-embedding memory_items
 *
 * For reconcileNullVectors:
 *   - select #0: live queue rows (global)
 *   - select #1: missing-embedding memory_items (global)
 */
function createReindexDb(config: {
  selects?: MockRow[][];
} = {}) {
  let selectIdx = 0;
  const selects = config.selects ?? [];
  const setCalls: Array<Record<string, unknown>> = [];
  // Captures every `insert().values(rows)` payload (reindexAllCompany bulk path).
  const insertCalls: Array<unknown[]> = [];

  function makeSelectChain(): Record<string, unknown> {
    const result = selects[selectIdx++] ?? [];
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "innerJoin", "leftJoin", "where", "orderBy", "limit"]) {
      chain[m] = () => chain;
    }
    chain.then = (resolve: (v: MockRow[]) => unknown) =>
      Promise.resolve(resolve(result));
    return chain;
  }

  function makeUpdateChain() {
    const chain: Record<string, unknown> = {};
    chain.set = (val: Record<string, unknown>) => {
      setCalls.push(val);
      return chain;
    };
    chain.where = () => chain;
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(resolve([]));
    return chain;
  }

  return {
    select: () => makeSelectChain(),
    update: () => makeUpdateChain(),
    insert: () => {
      const c: Record<string, unknown> = {};
      c.values = (rows: unknown) => {
        insertCalls.push(Array.isArray(rows) ? rows : [rows]);
        return c;
      };
      for (const m of ["returning", "onConflictDoNothing"]) {
        c[m] = () => c;
      }
      c.then = (resolve: (v: unknown) => unknown) => Promise.resolve(resolve([]));
      return c;
    },
    setCalls,
    insertCalls,
  };
}

describe("reindexCompany", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: pgvector present
    mockGetDbCapabilities.mockReturnValue({ hasVectorSupport: true });
    mockEnqueueMemoryEmbedding.mockResolvedValue(undefined);
  });

  it("returns zeros without touching DB when pgvector is absent", async () => {
    mockGetDbCapabilities.mockReturnValue({ hasVectorSupport: false });
    const db = createReindexDb();

    const result = await reindexCompany(db as any, "c-1");
    expect(result).toEqual({ requeuedFailed: 0, enqueuedMissing: 0 });
    expect(db.setCalls.length).toBe(0);
    expect(mockEnqueueMemoryEmbedding).not.toHaveBeenCalled();
  });

  it("requeues failed rows: sets status=pending, attempts=0, error=null", async () => {
    const db = createReindexDb({
      selects: [
        // select #0: 2 failed rows (with target keys)
        [
          { id: "q-1", targetTable: "memory_items", targetId: "mi-1", targetColumn: "embedding" },
          { id: "q-2", targetTable: "memory_items", targetId: "mi-2", targetColumn: "embedding" },
        ],
        // select #1: superseding (completed/live) rows — none, so both requeue
        [],
        // select #2: no live queue rows (step 2)
        [],
        // select #3: no missing-embedding items (step 2)
        [],
      ],
    });

    const result = await reindexCompany(db as any, "c-company");

    expect(result.requeuedFailed).toBe(2);
    // Two updates now: [0] requeue-failed → pending, then [1] the unconditional
    // backoff-clear (step 1b) that resets nextRetryAt for live pending rows so a
    // key-add drains no-key/circuit-backed-off rows immediately.
    expect(db.setCalls.length).toBe(2);
    expect(db.setCalls[0]).toMatchObject({
      status: "pending",
      attempts: 0,
      error: null,
    });
    expect(db.setCalls[1]).toEqual({ nextRetryAt: null });
    expect(result.enqueuedMissing).toBe(0);
    expect(mockEnqueueMemoryEmbedding).not.toHaveBeenCalled();
  });

  it("enqueues null-vector memory_items lacking a live queue row", async () => {
    const db = createReindexDb({
      selects: [
        // select #0: no failed rows
        [],
        // select #1: superseding rows (none)
        [],
        // select #2: no live queue rows (step 2)
        [],
        // select #3: 2 items with null embedding (step 2)
        [
          { id: "mi-1", title: "A", content: "aa" },
          { id: "mi-2", title: "B", content: "bb" },
        ],
      ],
    });

    const result = await reindexCompany(db as any, "c-company");

    expect(result.requeuedFailed).toBe(0);
    expect(result.enqueuedMissing).toBe(2);
    expect(mockEnqueueMemoryEmbedding).toHaveBeenCalledTimes(2);
    expect(mockEnqueueMemoryEmbedding).toHaveBeenCalledWith(
      expect.anything(),
      "c-company",
      expect.objectContaining({ id: "mi-1" }),
    );
  });

  it("skips items that have a live queue row (dedup)", async () => {
    const db = createReindexDb({
      selects: [
        // select #0: no failed rows
        [],
        // select #1: superseding rows (none)
        [],
        // select #2: 1 live queue row — notInArray will exclude mi-1 (step 2)
        [{ targetId: "mi-1" }],
        // select #3: only mi-2 returned (notInArray excluded mi-1) (step 2)
        [{ id: "mi-2", title: "B", content: "bb" }],
      ],
    });

    const result = await reindexCompany(db as any, "c-company");

    expect(result.enqueuedMissing).toBe(1);
    expect(mockEnqueueMemoryEmbedding).toHaveBeenCalledOnce();
    expect(mockEnqueueMemoryEmbedding).toHaveBeenCalledWith(
      expect.anything(),
      "c-company",
      expect.objectContaining({ id: "mi-2" }),
    );
  });

  it("handles both requeue and missing enqueue in one call", async () => {
    const db = createReindexDb({
      selects: [
        // select #0: 1 failed row (with target keys)
        [{ id: "q-failed", targetTable: "memory_items", targetId: "mi-x", targetColumn: "embedding" }],
        // select #1: superseding rows (none)
        [],
        // select #2: no live queue rows (step 2)
        [],
        // select #3: 1 missing item (step 2)
        [{ id: "mi-3", title: "C", content: "cc" }],
      ],
    });

    const result = await reindexCompany(db as any, "c-company");

    expect(result.requeuedFailed).toBe(1);
    expect(result.enqueuedMissing).toBe(1);
    // [0] requeue-failed, [1] unconditional backoff-clear (step 1b).
    expect(db.setCalls.length).toBe(2);
    expect(db.setCalls[1]).toEqual({ nextRetryAt: null });
    expect(mockEnqueueMemoryEmbedding).toHaveBeenCalledOnce();
  });

  it("does NOT requeue a stale failed row when a NEWER completed sibling exists (P2)", async () => {
    const db = createReindexDb({
      selects: [
        // select #0: failed row created EARLIER (stale pre-edit content)
        [{ id: "q-stale", targetTable: "memory_items", targetId: "mi-stale", targetColumn: "embedding", createdAt: "2026-06-01T00:00:00Z" }],
        // select #1: a NEWER completed sibling → mi-stale was re-indexed after the
        // failure; requeuing q-stale would clobber the current vector.
        [{ targetTable: "memory_items", targetId: "mi-stale", targetColumn: "embedding", createdAt: "2026-06-02T00:00:00Z" }],
        // select #2: no live queue rows (step 2)
        [],
        // select #3: no missing items (step 2)
        [],
      ],
    });

    const result = await reindexCompany(db as any, "c-company");

    expect(result.requeuedFailed).toBe(0);
    // Only the unconditional step-1b backoff-clear should have run (no failed requeue).
    expect(db.setCalls.length).toBe(1);
    expect(db.setCalls[0]).toEqual({ nextRetryAt: null });
  });

  it("DOES requeue the newest failed row even when an OLDER completed sibling exists (P2 recency)", async () => {
    const db = createReindexDb({
      selects: [
        // select #0: failed row created LATER (the latest edit's attempt failed)
        [{ id: "q-newest", targetTable: "memory_items", targetId: "mi-x", targetColumn: "embedding", createdAt: "2026-06-02T00:00:00Z" }],
        // select #1: an OLDER completed sibling (pre-edit content) — must NOT
        // suppress the newer failed row, or the stored vector stays stale.
        [{ targetTable: "memory_items", targetId: "mi-x", targetColumn: "embedding", createdAt: "2026-06-01T00:00:00Z" }],
        // select #2: no live queue rows (step 2)
        [],
        // select #3: no missing items (step 2)
        [],
      ],
    });

    const result = await reindexCompany(db as any, "c-company");

    expect(result.requeuedFailed).toBe(1);
    // [0] requeue-failed (the newest stale-vector row), [1] step-1b backoff-clear.
    expect(db.setCalls.length).toBe(2);
    expect(db.setCalls[0]).toMatchObject({ status: "pending", attempts: 0, error: null });
    expect(db.setCalls[1]).toEqual({ nextRetryAt: null });
  });
});

// ---------------------------------------------------------------------------
// reindexAllCompany (Task 6 — founder-only bulk re-embed, dedup-safe)
// ---------------------------------------------------------------------------

describe("reindexAllCompany", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDbCapabilities.mockReturnValue({ hasVectorSupport: true });
  });

  it("returns { enqueued: 0 } without touching DB when pgvector is absent", async () => {
    mockGetDbCapabilities.mockReturnValue({ hasVectorSupport: false });
    const db = createReindexDb({ selects: [[{ id: "m1" }]] });

    const result = await reindexAllCompany(db as any, "co-1");
    expect(result).toEqual({ enqueued: 0 });
    expect(db.insertCalls.length).toBe(0);
  });

  it("enqueues items that have NO live queue row (bulk insert)", async () => {
    const db = createReindexDb({
      selects: [
        // select #0: all memory_items for the company
        [
          { id: "m1", title: "A", content: "aa" },
          { id: "m2", title: "B", content: "bb" },
        ],
        // select #1: live (pending|processing) queue rows — none
        [],
      ],
    });

    const result = await reindexAllCompany(db as any, "co-1");
    expect(result).toEqual({ enqueued: 2 });
    // One bulk insert, NOT a per-item loop.
    expect(db.insertCalls.length).toBe(1);
    expect(db.insertCalls[0]).toHaveLength(2);
    expect(db.insertCalls[0][0]).toMatchObject({
      companyId: "co-1",
      targetTable: "memory_items",
      targetId: "m1",
      targetColumn: "embedding",
      inputText: "A\naa",
      status: "pending",
    });
    expect(db.insertCalls[0][1]).toMatchObject({ targetId: "m2", inputText: "B\nbb" });
  });

  it("skips items that already have a live (pending|processing) row — no duplicate", async () => {
    const db = createReindexDb({
      selects: [
        // select #0: 2 items
        [
          { id: "m1", title: "A", content: "aa" },
          { id: "m2", title: "B", content: "bb" },
        ],
        // select #1: m1 already has a live queue row → excluded
        [{ targetId: "m1" }],
      ],
    });

    const result = await reindexAllCompany(db as any, "co-1");
    expect(result).toEqual({ enqueued: 1 });
    expect(db.insertCalls.length).toBe(1);
    expect(db.insertCalls[0]).toHaveLength(1);
    expect(db.insertCalls[0][0]).toMatchObject({ targetId: "m2", inputText: "B\nbb" });
  });

  it("returns { enqueued: 0 } and does NOT insert when every item already has a live row", async () => {
    const db = createReindexDb({
      selects: [
        [{ id: "m1", title: "A", content: "aa" }],
        [{ targetId: "m1" }],
      ],
    });

    const result = await reindexAllCompany(db as any, "co-1");
    expect(result).toEqual({ enqueued: 0 });
    expect(db.insertCalls.length).toBe(0);
  });

  it("composes inputText from title+content (matches enqueueMemoryEmbedding)", async () => {
    const db = createReindexDb({
      selects: [
        [
          { id: "m1", title: "Title only", content: null },
          { id: "m2", title: null, content: "Content only" },
        ],
        [],
      ],
    });

    const result = await reindexAllCompany(db as any, "co-1");
    expect(result).toEqual({ enqueued: 2 });
    expect(db.insertCalls[0][0]).toMatchObject({ inputText: "Title only" });
    expect(db.insertCalls[0][1]).toMatchObject({ inputText: "Content only" });
  });
});

// ---------------------------------------------------------------------------
// reconcileNullVectors (Task W4)
// ---------------------------------------------------------------------------

describe("reconcileNullVectors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDbCapabilities.mockReturnValue({ hasVectorSupport: true });
    mockEnqueueMemoryEmbedding.mockResolvedValue(undefined);
  });

  it("returns { enqueued: 0 } without touching DB when pgvector is absent", async () => {
    mockGetDbCapabilities.mockReturnValue({ hasVectorSupport: false });
    const db = createReindexDb();

    const result = await reconcileNullVectors(db as any);
    expect(result).toEqual({ enqueued: 0 });
    expect(mockEnqueueMemoryEmbedding).not.toHaveBeenCalled();
  });

  it("returns { enqueued: 0 } when all items already have embeddings", async () => {
    const db = createReindexDb({
      selects: [
        [], // select #0: no live queue rows
        [], // select #1: no missing items
      ],
    });

    const result = await reconcileNullVectors(db as any);
    expect(result).toEqual({ enqueued: 0 });
    expect(mockEnqueueMemoryEmbedding).not.toHaveBeenCalled();
  });

  it("enqueues null-vector rows across all companies", async () => {
    const db = createReindexDb({
      selects: [
        // select #0: no live queue rows
        [],
        // select #1: 3 items from 2 companies
        [
          { id: "mi-1", companyId: "c-A", title: "T1", content: "c1" },
          { id: "mi-2", companyId: "c-A", title: "T2", content: "c2" },
          { id: "mi-3", companyId: "c-B", title: "T3", content: "c3" },
        ],
      ],
    });

    const result = await reconcileNullVectors(db as any);
    expect(result).toEqual({ enqueued: 3 });
    expect(mockEnqueueMemoryEmbedding).toHaveBeenCalledTimes(3);
    expect(mockEnqueueMemoryEmbedding).toHaveBeenCalledWith(
      expect.anything(), "c-A", expect.objectContaining({ id: "mi-1" }),
    );
    expect(mockEnqueueMemoryEmbedding).toHaveBeenCalledWith(
      expect.anything(), "c-B", expect.objectContaining({ id: "mi-3" }),
    );
  });

  it("skips items that have a live queue row (idempotent dedup)", async () => {
    const db = createReindexDb({
      selects: [
        // select #0: mi-1 has a live queue row
        [{ targetId: "mi-1" }],
        // select #1: only mi-2 returned (notInArray excluded mi-1)
        [{ id: "mi-2", companyId: "c-A", title: "T2", content: "c2" }],
      ],
    });

    const result = await reconcileNullVectors(db as any);
    expect(result).toEqual({ enqueued: 1 });
    expect(mockEnqueueMemoryEmbedding).toHaveBeenCalledOnce();
    expect(mockEnqueueMemoryEmbedding).toHaveBeenCalledWith(
      expect.anything(), "c-A", expect.objectContaining({ id: "mi-2" }),
    );
  });

  it("skips orphaned rows with no companyId", async () => {
    const db = createReindexDb({
      selects: [
        [], // no live rows
        [
          { id: "mi-orphan", companyId: null, title: "Orphan", content: "x" },
          { id: "mi-ok", companyId: "c-A", title: "OK", content: "y" },
        ],
      ],
    });

    const result = await reconcileNullVectors(db as any);
    expect(result).toEqual({ enqueued: 1 }); // orphaned row skipped
    expect(mockEnqueueMemoryEmbedding).toHaveBeenCalledOnce();
    expect(mockEnqueueMemoryEmbedding).toHaveBeenCalledWith(
      expect.anything(), "c-A", expect.objectContaining({ id: "mi-ok" }),
    );
  });
});
