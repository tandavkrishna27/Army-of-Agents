import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeTableProxy, drizzleOperatorStubs, mockDbCapabilities } from "./helpers/drizzle-mock.js";

// Mock @armyofagents/db to avoid drizzle-orm ESM cycle
vi.mock("@armyofagents/db", () => ({
  memoryItems: makeTableProxy("memory_items"),
  // Added for Task B1: the embeddings module also imports these for the
  // write-behind queue factory. These tests don't exercise that path,
  // so proxy stubs are sufficient.
  discussions: makeTableProxy("discussions"),
  discussionExtractedItems: makeTableProxy("discussion_extracted_items"),
  embeddingQueue: makeTableProxy("embedding_queue"),
}));

// Mock drizzle-orm operators
vi.mock("drizzle-orm", () => drizzleOperatorStubs());

// Mock db-capabilities: all tests in this file exercise the embedding-queue
// worker which returns early when hasVectorSupport is false.
vi.mock("../services/db-capabilities.js", () => mockDbCapabilities());

// Mock logger
vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

// Mock resolveApiKey
vi.mock("../adapters/api-common.js", () => ({
  resolveApiKey: vi.fn(),
}));

import { resolveApiKey } from "../adapters/api-common.js";
import { processEmbeddingQueue, invalidateEmbedding } from "../services/embeddings.js";

// ---------------------------------------------------------------------------
// Sequence-based mock DB (with setCalls tracking for update assertions)
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

  function makeChain(getResult: () => MockRow[], trackSet?: boolean) {
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "where", "values", "returning", "innerJoin", "leftJoin", "orderBy", "limit"]) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    if (trackSet) {
      chain.set = (val: Record<string, unknown>) => {
        setCalls.push(val);
        return chain;
      };
    } else {
      chain.set = (..._args: unknown[]) => chain;
    }
    chain.then = (resolve: (v: MockRow[]) => unknown) => Promise.resolve(resolve(getResult()));
    return chain;
  }

  return {
    select: (..._args: unknown[]) => makeChain(() => selects[selectIdx++] ?? []),
    update: (..._args: unknown[]) => makeChain(() => updates[updateIdx++] ?? [], true),
    insert: (..._args: unknown[]) => makeChain(() => []),
    setCalls,
  };
}

describe("Embedding Retry Persistence", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    (resolveApiKey as any).mockResolvedValue("sk-test-key");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeFakeEmbedding(dim = 1536): number[] {
    return Array.from({ length: dim }, (_, i) => i * 0.001);
  }

  it("skips items with embeddingRetries >= MAX_RETRIES (filtered at query level)", async () => {
    // The query includes a filter `embeddingRetries < 3`, so items at max
    // retries simply don't appear in the result set. We simulate this by
    // returning an empty pending list.
    const db = createSequenceDb({
      selects: [
        [], // no pending items (all have retries >= 3)
      ],
    });

    const result = await processEmbeddingQueue(db as any, "company-1");
    expect(result).toBe(0);
  });

  it("increments embeddingRetries on failure", async () => {
    const db = createSequenceDb({
      selects: [
        [{ id: "item-1", title: "Test", content: "Some content" }],
      ],
      updates: [
        [], // update for retry increment
      ],
    });

    // Make the embedding API call fail
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal server error",
    });

    const result = await processEmbeddingQueue(db as any, "company-1");
    expect(result).toBe(0);
    // The set call should include embeddingRetries increment
    expect(db.setCalls.length).toBe(1);
    expect(db.setCalls[0]).toHaveProperty("embeddingRetries");
  });

  it("resets embeddingRetries to 0 on success", async () => {
    const fakeEmbedding = makeFakeEmbedding();
    const db = createSequenceDb({
      selects: [
        [{ id: "item-1", title: "Test", content: "Some content" }],
      ],
      updates: [
        [], // update for embedding + retry reset
      ],
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: fakeEmbedding }] }),
    });

    const result = await processEmbeddingQueue(db as any, "company-1");
    expect(result).toBe(1);
    // The set call should include embeddingRetries: 0
    expect(db.setCalls.length).toBe(1);
    expect(db.setCalls[0]).toHaveProperty("embeddingRetries", 0);
  });

  it("processes multiple items via batch — all succeed when API succeeds", async () => {
    const fakeEmbedding = makeFakeEmbedding();
    const db = createSequenceDb({
      selects: [
        [
          { id: "item-1", title: "Good", content: "Will succeed" },
          { id: "item-2", title: "Good2", content: "Will succeed too" },
          { id: "item-3", title: "Good3", content: "Will succeed three" },
        ],
      ],
      updates: [
        [], // item-1 success
        [], // item-2 success
        [], // item-3 success
      ],
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { embedding: fakeEmbedding, index: 0 },
          { embedding: fakeEmbedding, index: 1 },
          { embedding: fakeEmbedding, index: 2 },
        ],
      }),
    });

    const result = await processEmbeddingQueue(db as any, "company-1");
    expect(result).toBe(3); // all 3 succeeded

    // 3 set calls, all success (embeddingRetries reset to 0)
    expect(db.setCalls.length).toBe(3);
    expect(db.setCalls[0]).toHaveProperty("embeddingRetries", 0);
    expect(db.setCalls[1]).toHaveProperty("embeddingRetries", 0);
    expect(db.setCalls[2]).toHaveProperty("embeddingRetries", 0);
  });

  it("increments retry count for ALL items when batch API call fails", async () => {
    const db = createSequenceDb({
      selects: [
        [
          { id: "item-1", title: "A", content: "content" },
          { id: "item-2", title: "B", content: "content" },
        ],
      ],
      updates: [
        [], // item-1 retry increment
        [], // item-2 retry increment
      ],
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "Rate limited",
    });

    const result = await processEmbeddingQueue(db as any, "company-1");
    expect(result).toBe(0); // none succeeded

    // Both items got their retry count incremented
    expect(db.setCalls.length).toBe(2);
    expect(db.setCalls[0]).toHaveProperty("embeddingRetries");
    expect(db.setCalls[1]).toHaveProperty("embeddingRetries");
  });

  it("invalidateEmbedding resets embeddingRetries to 0", async () => {
    const db = createSequenceDb({
      updates: [
        [], // invalidation update
      ],
    });

    await invalidateEmbedding(db as any, "item-1");
    expect(db.setCalls.length).toBe(1);
    expect(db.setCalls[0]).toHaveProperty("embeddingRetries", 0);
  });
});
