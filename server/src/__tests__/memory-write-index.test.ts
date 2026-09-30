// server/src/__tests__/memory-write-index.test.ts
//
// Task W3 — enqueueMemoryEmbedding + writeMemoryAndIndex tests.
// Verifies:
//   - create with text → exactly ONE embeddingQueue insert with correct fields
//   - dedup: second enqueue with a live 'pending' row → no second insert
//   - approve after create-enqueue → no double insert (dedup)
//   - no pgvector (hasVectorSupport=false) → no insert
//   - empty text → no insert

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeTableProxy, drizzleOperatorStubs, mockDbCapabilities } from "./helpers/drizzle-mock.js";

// ── Module mocks (must be hoisted before imports) ──────────────────────────

vi.mock("@armyofagents/db", () => ({
  embeddingQueue: makeTableProxy("embedding_queue"),
  memoryItems: makeTableProxy("memory_items"),
  discussions: makeTableProxy("discussions"),
  discussionExtractedItems: makeTableProxy("discussion_extracted_items"),
}));

vi.mock("drizzle-orm", () => drizzleOperatorStubs());

// Default: vector support enabled. Individual tests override for the no-vector path.
const caps = { hasVectorSupport: true };
vi.mock("../services/db-capabilities.js", () => ({
  getDbCapabilities: () => caps,
  setDbCapabilities: () => {},
  probeDbCapabilities: () => Promise.resolve(caps),
}));

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

// memory.ts imports these — stub them out so the module loads cleanly.
vi.mock("../services/memory-projection.js", () => ({
  buildMemoryInsert: vi.fn(),
  memoryItemsSelection: vi.fn().mockReturnValue({}),
}));
vi.mock("../adapters/api-common.js", () => ({
  resolveApiKey: vi.fn(),
}));
vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));
vi.mock("../errors.js", () => ({
  badRequest: (msg: string) => new Error(msg),
  conflict: (msg: string) => new Error(msg),
  notFound: (msg: string) => new Error(msg),
}));
// Partial mock: spread the real (pure constants) module so transitive
// importers of hub constants (HUB_SEMANTIC_TYPES et al., pulled in by the
// memory_review hub producer at the writeMemoryAndIndex chokepoint) resolve,
// while overriding just the two helpers these tests pin.
vi.mock("@armyofagents/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@armyofagents/shared")>()),
  MEMORY_ITEM_LAYERS: ["identity", "domain", "active_context", "working"],
  normalizeMemoryFolderPath: (p: string) => p,
}));
vi.mock("../services/embeddings.js", () => ({
  generateEmbedding: vi.fn(),
}));

import { enqueueMemoryEmbedding } from "../services/memory-write.js";

// ── Mock DB factory ──────────────────────────────────────────────────────────
//
// The db needs to handle two operations from enqueueMemoryEmbedding:
//   1. select({id}).from(embeddingQueue).where(...).limit(1) → dedup check
//   2. insert(embeddingQueue).values({...}) → actual enqueue
//
// `existingRows` controls what the dedup SELECT returns.
// `insertedValues` captures what was inserted.

function makeEnqueueDb(opts: { existingRows?: Array<{ id: string }> } = {}) {
  const insertedValues: Array<Record<string, unknown>> = [];
  const updatedValues: Array<Record<string, unknown>> = [];
  let selectCallCount = 0;

  const db: any = {
    select: (_cols?: unknown) => ({
      from: (_table: unknown) => ({
        where: (_cond: unknown) => ({
          limit: (_n: number) => {
            selectCallCount++;
            return Promise.resolve(opts.existingRows ?? []);
          },
        }),
      }),
    }),
    insert: (_table: unknown) => ({
      values: (vals: Record<string, unknown>) => {
        insertedValues.push(vals);
        return Promise.resolve([]);
      },
    }),
    update: (_table: unknown) => ({
      set: (vals: Record<string, unknown>) => {
        updatedValues.push(vals);
        return { where: (_cond: unknown) => Promise.resolve([]) };
      },
    }),
  };

  return { db, insertedValues, updatedValues, getSelectCallCount: () => selectCallCount };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("enqueueMemoryEmbedding", () => {
  beforeEach(() => {
    caps.hasVectorSupport = true;
  });

  it("inserts exactly one queue row with correct fields when item has text", async () => {
    const { db, insertedValues } = makeEnqueueDb();
    const item = { id: "item-1", title: "My Title", content: "Some content here" };

    await enqueueMemoryEmbedding(db, "co-abc", item);

    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0]).toMatchObject({
      companyId: "co-abc",
      targetTable: "memory_items",
      targetId: "item-1",
      targetColumn: "embedding",
      inputText: "My Title\nSome content here",
      status: "pending",
    });
  });

  it("joins title and content with newline in inputText", async () => {
    const { db, insertedValues } = makeEnqueueDb();

    await enqueueMemoryEmbedding(db, "co-1", {
      id: "item-2",
      title: "Title",
      content: "Content",
    });

    expect(insertedValues[0]?.inputText).toBe("Title\nContent");
  });

  it("uses only content when title is null/missing", async () => {
    const { db, insertedValues } = makeEnqueueDb();

    await enqueueMemoryEmbedding(db, "co-1", { id: "item-3", content: "Only content" });

    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0]?.inputText).toBe("Only content");
  });

  it("uses only title when content is null/missing", async () => {
    const { db, insertedValues } = makeEnqueueDb();

    await enqueueMemoryEmbedding(db, "co-1", { id: "item-4", title: "Only title" });

    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0]?.inputText).toBe("Only title");
  });

  it("skips insert when hasVectorSupport is false", async () => {
    caps.hasVectorSupport = false;
    const { db, insertedValues } = makeEnqueueDb();

    await enqueueMemoryEmbedding(db, "co-1", {
      id: "item-5",
      title: "Title",
      content: "Content",
    });

    expect(insertedValues).toHaveLength(0);
  });

  it("skips insert when both title and content are empty/null", async () => {
    const { db, insertedValues } = makeEnqueueDb();

    await enqueueMemoryEmbedding(db, "co-1", { id: "item-6" });

    expect(insertedValues).toHaveLength(0);
  });

  it("skips insert when title is empty string and content is null", async () => {
    const { db, insertedValues } = makeEnqueueDb();

    await enqueueMemoryEmbedding(db, "co-1", { id: "item-7", title: "", content: null });

    expect(insertedValues).toHaveLength(0);
  });

  it("dedup: skips insert when a live 'pending' row already exists for the target", async () => {
    const { db, insertedValues, updatedValues } = makeEnqueueDb({
      existingRows: [{ id: "q-existing" }],
    });

    await enqueueMemoryEmbedding(db, "co-1", {
      id: "item-8",
      title: "T",
      content: "C",
    });

    // Dedup guard fires — no new insert; the pending row is refreshed instead.
    expect(insertedValues).toHaveLength(0);
    expect(updatedValues).toHaveLength(1);
  });

  it("refreshing a pending row resets the retry budget (attempts/error/nextRetryAt) — P2 re-review", async () => {
    // A memory edit while the row is mid transient-retry must NOT inherit the
    // stale attempts count, or the worker would dead-letter the NEW content after
    // a single further failure instead of giving it a fresh retry budget.
    const { db, insertedValues, updatedValues } = makeEnqueueDb({
      existingRows: [{ id: "q-retrying" }],
    });

    await enqueueMemoryEmbedding(db, "co-1", {
      id: "item-edited",
      title: "New Title",
      content: "New content",
    });

    expect(insertedValues).toHaveLength(0);
    expect(updatedValues).toHaveLength(1);
    expect(updatedValues[0]).toMatchObject({
      inputText: "New Title\nNew content",
      attempts: 0,
      error: null,
      nextRetryAt: null,
    });
  });

  it("dedup: two sequential enqueues on the same item — only the first inserts", async () => {
    // First call: no existing rows → inserts. Second call: simulate that row is
    // now pending by returning it from the dedup SELECT.
    const { db: db1, insertedValues: iv1 } = makeEnqueueDb({ existingRows: [] });
    await enqueueMemoryEmbedding(db1, "co-1", { id: "item-9", title: "T", content: "C" });
    expect(iv1).toHaveLength(1);

    const { db: db2, insertedValues: iv2 } = makeEnqueueDb({
      existingRows: [{ id: "q-1" }],
    });
    await enqueueMemoryEmbedding(db2, "co-1", { id: "item-9", title: "T", content: "C" });
    expect(iv2).toHaveLength(0);
  });

  it("is best-effort: swallows insert errors without throwing", async () => {
    const throwingDb: any = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([]),
          }),
        }),
      }),
      insert: () => ({
        values: () => Promise.reject(new Error("DB offline")),
      }),
    };

    // Must NOT throw
    await expect(
      enqueueMemoryEmbedding(throwingDb, "co-1", { id: "item-10", title: "T", content: "C" }),
    ).resolves.toBeUndefined();
  });

  it("is best-effort: swallows dedup SELECT errors without throwing", async () => {
    const throwingDb: any = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.reject(new Error("select failed")),
          }),
        }),
      }),
      insert: vi.fn(),
    };

    await expect(
      enqueueMemoryEmbedding(throwingDb, "co-1", { id: "item-11", title: "T", content: "C" }),
    ).resolves.toBeUndefined();
  });

  it("passes the tx handle to select and insert when provided", async () => {
    // Verify that when a tx is passed, the tx object (not db) is used for
    // both the dedup SELECT and the INSERT.
    const dbInserted: Array<Record<string, unknown>> = [];
    const txInserted: Array<Record<string, unknown>> = [];

    const db: any = {
      select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
      insert: () => ({ values: (v: any) => { dbInserted.push(v); return Promise.resolve([]); } }),
    };
    const tx: any = {
      select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
      insert: () => ({ values: (v: any) => { txInserted.push(v); return Promise.resolve([]); } }),
    };

    await enqueueMemoryEmbedding(db, "co-1", { id: "item-12", title: "T", content: "C" }, tx);

    // tx should have been used, not db
    expect(txInserted).toHaveLength(1);
    expect(dbInserted).toHaveLength(0);
  });
});

describe("enqueueMemoryEmbedding — approve after create (dedup coverage)", () => {
  beforeEach(() => {
    caps.hasVectorSupport = true;
  });

  it("approve after create-enqueue results in no double insert (dedup)", async () => {
    // Simulate the scenario: create already added a pending queue row.
    // When approve then calls enqueueMemoryEmbedding, the dedup SELECT returns
    // that pending row, so no second insert occurs.
    const { db, insertedValues } = makeEnqueueDb({
      existingRows: [{ id: "q-from-create" }],
    });

    await enqueueMemoryEmbedding(db, "co-1", {
      id: "item-approved",
      title: "Title",
      content: "Content",
    });

    expect(insertedValues).toHaveLength(0);
  });
});
