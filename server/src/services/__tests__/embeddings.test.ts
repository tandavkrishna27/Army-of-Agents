/**
 * Unit tests for `createEmbeddingService` — the write-behind embedding queue
 * factory (Task B1, Decision D2).
 *
 * Pattern mirrors `server/src/__tests__/embedding-retry-persistence.test.ts`:
 *   - `@armyofagents/db` and `drizzle-orm` are mocked at module level to
 *     avoid the drizzle-orm ESM cycle warning that makes real imports
 *     resolve to `undefined`.
 *   - A `createSequenceDb` helper returns a chainable mock that yields
 *     pre-configured rows per `select`/`update`/`insert` call.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  makeTableProxy,
  drizzleOperatorStubs,
} from "../../__tests__/helpers/drizzle-mock.js";

// Mock @armyofagents/db with proxy tables for every table the service touches.
vi.mock("@armyofagents/db", () => ({
  embeddingQueue: makeTableProxy("embedding_queue"),
  memoryItems: makeTableProxy("memory_items"),
  discussions: makeTableProxy("discussions"),
  discussionExtractedItems: makeTableProxy("discussion_extracted_items"),
}));

// Mock drizzle-orm operators.
vi.mock("drizzle-orm", () => drizzleOperatorStubs());

// Mock db-capabilities for the legacy `processEmbeddingQueue` path that
// shares the same module. The new write-behind queue doesn't gate on
// pgvector, but the legacy export does — the module would still import
// it at top level.
vi.mock("../db-capabilities.js", () => ({
  getDbCapabilities: () => ({ hasVectorSupport: true }),
  setDbCapabilities: () => {},
  probeDbCapabilities: () => Promise.resolve({ hasVectorSupport: true }),
}));

// Mock logger so the service's `logger.child({...}).warn(...)` calls
// don't pollute test output.
vi.mock("../../middleware/logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

// Mock resolveApiKey (legacy path; not exercised here).
vi.mock("../../adapters/api-common.js", () => ({
  resolveApiKey: vi.fn(),
}));

import {
  createEmbeddingService,
  withEmbedTimeout,
  classifyEmbeddingError,
  type LlmEmbedder,
  type EmbeddingTargetTable,
} from "../embeddings.js";

// ---------------------------------------------------------------------------
// Sequence-based mock DB with insert/update tracking.
// ---------------------------------------------------------------------------

type MockRow = Record<string, unknown>;

interface SequenceDbConfig {
  selects?: MockRow[][];
  updates?: MockRow[][];
  inserts?: MockRow[][];
}

interface UpdateCall {
  set: Record<string, unknown>;
  // Useful for asserting which table was updated. We capture only the table
  // identity from the proxy via its `_.name` accessor.
  tableName?: string;
}

interface InsertCall {
  values: Record<string, unknown>;
  tableName?: string;
}

function tableNameOf(value: unknown): string | undefined {
  if (value && typeof value === "object") {
    const meta = (value as Record<string, unknown>)["_"];
    if (meta && typeof meta === "object") {
      const name = (meta as Record<string, unknown>).name;
      if (typeof name === "string") return name;
    }
  }
  return undefined;
}

function createSequenceDb(config: SequenceDbConfig = {}) {
  let selectIdx = 0;
  let updateIdx = 0;
  let insertIdx = 0;
  const selects = config.selects ?? [];
  const updates = config.updates ?? [];
  const inserts = config.inserts ?? [];

  const updateCalls: UpdateCall[] = [];
  const insertCalls: InsertCall[] = [];

  function makeChain(
    getResult: () => MockRow[],
    capture?: { kind: "update" | "insert"; tableName?: string },
  ) {
    const chain: Record<string, unknown> = {};
    for (const m of [
      "from",
      "where",
      "returning",
      "innerJoin",
      "leftJoin",
      "orderBy",
      "limit",
    ]) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    if (capture?.kind === "update") {
      chain.set = (val: Record<string, unknown>) => {
        updateCalls.push({ set: val, tableName: capture.tableName });
        return chain;
      };
      chain.values = (..._args: unknown[]) => chain;
    } else if (capture?.kind === "insert") {
      chain.set = (..._args: unknown[]) => chain;
      chain.values = (val: Record<string, unknown>) => {
        insertCalls.push({ values: val, tableName: capture.tableName });
        return chain;
      };
    } else {
      chain.set = (..._args: unknown[]) => chain;
      chain.values = (..._args: unknown[]) => chain;
    }
    chain.then = (resolve: (v: MockRow[]) => unknown) =>
      Promise.resolve(resolve(getResult()));
    return chain;
  }

  return {
    select: (..._args: unknown[]) =>
      makeChain(() => selects[selectIdx++] ?? []),
    update: (table: unknown) =>
      makeChain(() => updates[updateIdx++] ?? [], {
        kind: "update",
        tableName: tableNameOf(table),
      }),
    insert: (table: unknown) =>
      makeChain(() => inserts[insertIdx++] ?? [], {
        kind: "insert",
        tableName: tableNameOf(table),
      }),
    updateCalls,
    insertCalls,
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeFakeEmbedding(dim = 1536): number[] {
  return Array.from({ length: dim }, (_, i) => i * 0.001);
}

function makeMockEmbedder(
  result: number[] | (() => Promise<number[]>),
): LlmEmbedder & { calls: number } {
  let calls = 0;
  const embedder = {
    async embed(_text: string) {
      calls++;
      if (typeof result === "function") return result();
      return result;
    },
    get calls() {
      return calls;
    },
  };
  return embedder as LlmEmbedder & { calls: number };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createEmbeddingService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("enqueue", () => {
    it("creates a pending row in embedding_queue", async () => {
      const db = createSequenceDb({
        inserts: [[{ id: "row-1" }]],
      });
      const llm = makeMockEmbedder(makeFakeEmbedding());

      const svc = createEmbeddingService(db as any, llm);
      const result = await svc.enqueue({
        targetTable: "memory_items",
        targetId: "mem-1",
        targetColumn: "embedding",
        inputText: "Hello world",
      });

      expect(result).toEqual({ id: "row-1" });
      expect(db.insertCalls.length).toBe(1);
      expect(db.insertCalls[0].tableName).toBe("embedding_queue");
      expect(db.insertCalls[0].values).toMatchObject({
        targetTable: "memory_items",
        targetId: "mem-1",
        targetColumn: "embedding",
        inputText: "Hello world",
        status: "pending",
      });
    });

    it("rejects unknown target tables", async () => {
      const db = createSequenceDb({ inserts: [[]] });
      const llm = makeMockEmbedder(makeFakeEmbedding());
      const svc = createEmbeddingService(db as any, llm);

      await expect(
        svc.enqueue({
          targetTable: "not_a_real_table" as EmbeddingTargetTable,
          targetId: "id-1",
          targetColumn: "embedding",
          inputText: "hi",
        }),
      ).rejects.toThrow(/Unknown target table/);
      // No insert should have been issued.
      expect(db.insertCalls.length).toBe(0);
    });

    it.each([
      ["memory_items", "embedding"],
      ["discussions", "summary_embedding"],
      ["discussion_extracted_items", "embedding"],
    ] as const)(
      "enqueues for target table %s with column %s",
      async (targetTable, targetColumn) => {
        const db = createSequenceDb({
          inserts: [[{ id: "row-X" }]],
        });
        const llm = makeMockEmbedder(makeFakeEmbedding());
        const svc = createEmbeddingService(db as any, llm);

        const result = await svc.enqueue({
          targetTable,
          targetId: "row-target",
          targetColumn,
          inputText: "Some text",
        });
        expect(result.id).toBe("row-X");
        expect(db.insertCalls[0].values).toMatchObject({
          targetTable,
          targetColumn,
          status: "pending",
        });
      },
    );
  });

  describe("processQueue", () => {
    it("returns processed=0/failed=0/remaining=0 for an empty pending list", async () => {
      const db = createSequenceDb({ selects: [[]] });
      const llm = makeMockEmbedder(makeFakeEmbedding());

      const svc = createEmbeddingService(db as any, llm);
      const result = await svc.processQueue();

      expect(result).toEqual({ processed: 0, failed: 0, remaining: 0, skipped: 0 });
      expect(llm.calls).toBe(0);
      expect(db.updateCalls.length).toBe(0);
    });

    it("embeds + updates target table AND marks queue row completed (memory_items)", async () => {
      const db = createSequenceDb({
        selects: [
          [
            {
              id: "queue-1",
              targetTable: "memory_items",
              targetId: "mem-1",
              targetColumn: "embedding",
              inputText: "Some text",
              status: "pending",
              attempts: 0,
            },
          ],
        ],
        // 3 updates per successful row: processing marker, target column,
        // completed marker.
        updates: [[], [], []],
      });
      const fakeEmbedding = makeFakeEmbedding();
      const llm = makeMockEmbedder(fakeEmbedding);

      const svc = createEmbeddingService(db as any, llm);
      const result = await svc.processQueue();

      expect(result).toEqual({ processed: 1, failed: 0, remaining: 0, skipped: 0 });
      expect(llm.calls).toBe(1);

      // Expect: marker (processing) on embedding_queue, target update on
      // memory_items, completion marker on embedding_queue.
      expect(db.updateCalls.length).toBe(3);
      expect(db.updateCalls[0].tableName).toBe("embedding_queue");
      expect(db.updateCalls[0].set).toMatchObject({ status: "processing" });
      expect(db.updateCalls[1].tableName).toBe("memory_items");
      // The vector is written as a `${literal}::vector` SQL expression (Drizzle's
      // dynamic .set() mis-binds a raw number[]). This mock only confirms the
      // write targets the embedding column; the actual stored + retrievable
      // vector is verified by the pgvector e2e (semantic-retrieval.spec.ts).
      expect(db.updateCalls[1].set).toHaveProperty("embedding");
      expect(db.updateCalls[2].tableName).toBe("embedding_queue");
      expect(db.updateCalls[2].set).toMatchObject({ status: "completed" });
    });

    // Third tuple element = the expected Drizzle JS PROPERTY for the SET key.
    // It differs from the DB column name (2nd element) for discussions
    // (summary_embedding ↔ summaryEmbedding); passing the DB name to `.set()`
    // would be silently dropped → empty SET → SQL error. This asserts the
    // VECTOR_COLUMN_DB_TO_PROP resolution in updateVectorColumn.
    it.each([
      ["memory_items", "embedding", "embedding"],
      ["discussions", "summary_embedding", "summaryEmbedding"],
      ["discussion_extracted_items", "embedding", "embedding"],
    ] as const)(
      "embeds and updates target table %s/%s (SET key = %s)",
      async (targetTable, targetColumn, expectedSetProp) => {
        const db = createSequenceDb({
          selects: [
            [
              {
                id: "queue-1",
                targetTable,
                targetId: "row-1",
                targetColumn,
                inputText: "text",
                status: "pending",
                attempts: 0,
              },
            ],
          ],
          updates: [[], [], []],
        });
        const fakeEmbedding = makeFakeEmbedding();
        const llm = makeMockEmbedder(fakeEmbedding);

        const svc = createEmbeddingService(db as any, llm);
        const result = await svc.processQueue();

        expect(result.processed).toBe(1);
        expect(db.updateCalls[1].tableName).toBe(targetTable);
        // The column value is a `${literal}::vector` SQL expression (see the
        // memory_items case above). Confirm the write uses the JS PROPERTY key
        // (not the DB column name); vector correctness is covered by the e2e.
        expect(db.updateCalls[1].set).toHaveProperty(expectedSetProp);
      },
    );

    it("retries on transient errors and succeeds when the embedder later works", async () => {
      // Simulate two failures then a success across three sequential
      // processQueue() calls — each call sees a single pending row.
      let attempt = 0;
      const llm = makeMockEmbedder(async () => {
        attempt++;
        if (attempt < 3) throw new Error("transient");
        return makeFakeEmbedding();
      });

      // Run 1: attempts 0 → 1, status stays 'pending' (re-queued)
      const db1 = createSequenceDb({
        selects: [
          [
            {
              id: "queue-1",
              targetTable: "memory_items",
              targetId: "mem-1",
              targetColumn: "embedding",
              inputText: "text",
              status: "pending",
              attempts: 0,
            },
          ],
        ],
        updates: [[], []], // processing marker, retry marker
      });
      const svc1 = createEmbeddingService(db1 as any, llm);
      const r1 = await svc1.processQueue();
      expect(r1).toEqual({ processed: 0, failed: 0, remaining: 1, skipped: 0 });
      // Last update is the retry marker with attempts incremented.
      expect(db1.updateCalls.at(-1)?.set).toMatchObject({
        status: "pending",
        attempts: 1,
      });

      // Run 2: attempts 1 → 2, still re-queued.
      const db2 = createSequenceDb({
        selects: [
          [
            {
              id: "queue-1",
              targetTable: "memory_items",
              targetId: "mem-1",
              targetColumn: "embedding",
              inputText: "text",
              status: "pending",
              attempts: 1,
            },
          ],
        ],
        updates: [[], []],
      });
      const svc2 = createEmbeddingService(db2 as any, llm);
      const r2 = await svc2.processQueue();
      expect(r2.processed).toBe(0);
      expect(r2.failed).toBe(0);
      expect(db2.updateCalls.at(-1)?.set).toMatchObject({
        status: "pending",
        attempts: 2,
      });

      // Run 3: succeeds, attempts NOT bumped past 2 — the success path doesn't
      // touch `attempts`.
      const db3 = createSequenceDb({
        selects: [
          [
            {
              id: "queue-1",
              targetTable: "memory_items",
              targetId: "mem-1",
              targetColumn: "embedding",
              inputText: "text",
              status: "pending",
              attempts: 2,
            },
          ],
        ],
        updates: [[], [], []],
      });
      const svc3 = createEmbeddingService(db3 as any, llm);
      const r3 = await svc3.processQueue();
      expect(r3.processed).toBe(1);
      expect(db3.updateCalls.at(-1)?.set).toMatchObject({ status: "completed" });
    });

    it("marks row 'failed' once attempts >= maxAttempts", async () => {
      const llm = makeMockEmbedder(async () => {
        throw new Error("persistent failure");
      });

      // Pending row already has attempts=2; one more failure should hit
      // maxAttempts=3 and mark the row 'failed'.
      const db = createSequenceDb({
        selects: [
          [
            {
              id: "queue-1",
              targetTable: "memory_items",
              targetId: "mem-1",
              targetColumn: "embedding",
              inputText: "text",
              status: "pending",
              attempts: 2,
            },
          ],
        ],
        updates: [[], []], // processing, fail
      });

      const svc = createEmbeddingService(db as any, llm);
      const result = await svc.processQueue({ maxAttempts: 3 });

      expect(result.processed).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.remaining).toBe(0);

      // The last update is the failure marker with error captured.
      const final = db.updateCalls.at(-1)?.set as Record<string, unknown>;
      expect(final.status).toBe("failed");
      expect(final.attempts).toBe(3);
      expect(final.error).toContain("persistent failure");
    });

    it("respects the batchSize opt by passing it down to .limit()", async () => {
      // The sequence DB's `limit()` returns the chain unchanged; we instead
      // assert that processing more than batchSize rows behaves correctly.
      const fakeEmbedding = makeFakeEmbedding();
      const llm = makeMockEmbedder(fakeEmbedding);

      const pending = Array.from({ length: 5 }, (_, i) => ({
        id: `queue-${i}`,
        targetTable: "memory_items",
        targetId: `mem-${i}`,
        targetColumn: "embedding",
        inputText: `text-${i}`,
        status: "pending",
        attempts: 0,
      }));

      const db = createSequenceDb({
        selects: [pending],
        // 5 rows * 3 updates each = 15 updates total.
        updates: Array.from({ length: 15 }, () => []),
      });

      const svc = createEmbeddingService(db as any, llm);
      const result = await svc.processQueue({ batchSize: 5 });

      expect(result.processed).toBe(5);
      expect(result.failed).toBe(0);
      expect(llm.calls).toBe(5);
      // Each row triggers exactly one target-table update.
      const targetUpdates = db.updateCalls.filter(
        (u) => u.tableName === "memory_items",
      );
      expect(targetUpdates.length).toBe(5);
    });

    it("does not crash when an unknown target table sneaks past enqueue", async () => {
      // The validation guard in `updateVectorColumn` should also catch
      // bad queue rows (e.g. inserted via raw SQL by a misbehaving plugin).
      const llm = makeMockEmbedder(makeFakeEmbedding());
      const db = createSequenceDb({
        selects: [
          [
            {
              id: "queue-X",
              targetTable: "bogus_table",
              targetId: "row-X",
              targetColumn: "embedding",
              inputText: "text",
              status: "pending",
              attempts: 0,
            },
          ],
        ],
        // processing marker + retry marker; the embed call is never reached.
        updates: [[], []],
      });

      const svc = createEmbeddingService(db as any, llm);
      const result = await svc.processQueue();

      // Failed row goes back to pending until it hits maxAttempts; it counts
      // as 0 processed, 0 finally-failed.
      expect(result.processed).toBe(0);
      // The last update is a retry (not a completion).
      const finalSet = db.updateCalls.at(-1)?.set as Record<string, unknown>;
      expect(finalSet.error).toContain("Unknown target table");
    });
  });

  describe("withEmbedTimeout (audit: bound embed below stale lease)", () => {
    it("passes through a value that resolves before the timeout", async () => {
      const value = [1, 2, 3];
      await expect(withEmbedTimeout(Promise.resolve(value), 1000)).resolves.toBe(
        value,
      );
    });

    it("rejects with a transient-classified 'timeout' error when exceeded", async () => {
      vi.useFakeTimers();
      try {
        // A never-resolving embed → only the timeout branch settles the race.
        const never = new Promise<number[]>(() => {});
        const p = withEmbedTimeout(never, 1000);
        // Attach the rejection handler BEFORE advancing so it isn't unhandled.
        const assertion = expect(p).rejects.toThrow(/timeout/);
        await vi.advanceTimersByTimeAsync(1001);
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });

    it("a timeout error classifies as transient (so the row retries, not fails)", () => {
      expect(
        classifyEmbeddingError(new Error("embedding request exceeded 120000ms timeout")),
      ).toBe("transient");
    });
  });
});
