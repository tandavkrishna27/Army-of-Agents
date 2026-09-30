/**
 * Task 11: Embedding circuit breaker tests (mocked DB — no pgvector needed).
 *
 * Tests processQueue() error-class dispatch using a Proxy-based mock DB:
 *   - transient error → row retried with backoff; at maxAttempts → 'failed'
 *   - row_permanent error → 'failed' immediately, no retry
 *   - systemic error → row restored to pending (attempts unchanged); remaining
 *     rows for the same company skipped this tick; other companies unaffected
 *
 * Pattern: sequence-db with captured update calls (same as embedding-key-resolution.test.ts).
 * openai is mocked so no real API calls occur.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module mocks ──────────────────────────────────────────────────────────────
// Use vi.hoisted so helpers are available at vi.mock() hoist time.
const { makeTableProxy, drizzleOperatorStubs } = await vi.hoisted(async () => {
  const mod = await import("./helpers/drizzle-mock.js");
  return { makeTableProxy: mod.makeTableProxy, drizzleOperatorStubs: mod.drizzleOperatorStubs };
});

vi.mock("@armyofagents/db", () => ({
  embeddingQueue: makeTableProxy("embedding_queue"),
  memoryItems: makeTableProxy("memory_items"),
  discussions: makeTableProxy("discussions"),
  discussionExtractedItems: makeTableProxy("discussion_extracted_items"),
}));

vi.mock("drizzle-orm", () => drizzleOperatorStubs());

vi.mock("../services/db-capabilities.js", () => ({
  getDbCapabilities: () => ({ hasVectorSupport: true }),
  setDbCapabilities: () => {},
  probeDbCapabilities: () => Promise.resolve({ hasVectorSupport: true }),
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

vi.mock("../adapters/api-common.js", () => ({
  resolveApiKey: vi.fn(),
}));

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(() => ({
    embeddings: { create: vi.fn() },
  })),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import {
  createEmbeddingService,
  type CircuitEntry,
} from "../services/embeddings.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

type MockRow = Record<string, unknown>;

interface UpdateCall {
  set: Record<string, unknown>;
  tableName?: string;
}

function tableNameOf(value: unknown): string | undefined {
  if (value && typeof value === "object") {
    const meta = (value as Record<string, unknown>)["_"];
    if (meta && typeof meta === "object") {
      return (meta as Record<string, unknown>).name as string | undefined;
    }
  }
  return undefined;
}

interface SequenceDbConfig {
  selects?: MockRow[][];
  /** When provided, the sequence-db ignores raw SQL execute calls (returns empty rows). */
  skipRawExecute?: boolean;
}

/**
 * Create a mock DB that:
 *  1. Returns pre-seeded select results in sequence.
 *  2. Records all update `.set(...)` calls.
 *  3. Exposes `db.execute` as a no-op (returns empty rows) so the SKIP LOCKED
 *     CTE path throws / falls back to the plain select path.
 *
 * The mock intentionally makes `db.execute` throw so processQueue falls back
 * to the plain select + per-row mark-processing path — this is the correct
 * behaviour for test environments without a real PG connection.
 */
function createSequenceDb(config: SequenceDbConfig = {}) {
  let selectIdx = 0;
  const selects = config.selects ?? [];
  const updateCalls: UpdateCall[] = [];

  function makeChain(
    getResult: () => MockRow[],
    capture?: { kind: "update"; tableName?: string },
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
      makeChain(() => [], {
        kind: "update",
        tableName: tableNameOf(table),
      }),
    insert: (..._args: unknown[]) => makeChain(() => [{ id: "inserted-id" }]),
    // Make execute throw so processQueue falls back to plain select.
    execute: (_query: unknown) => {
      throw new Error("raw SQL not supported in mock DB — use plain select fallback");
    },
    updateCalls,
  };
}

/** Make a minimal queue row fixture. */
function makeQueueRow(overrides: Partial<MockRow> = {}): MockRow {
  return {
    id: "q-1",
    targetTable: "memory_items",
    targetId: "m-1",
    targetColumn: "embedding",
    inputText: "some text",
    status: "pending",
    attempts: 0,
    companyId: "company-A",
    nextRetryAt: null,
    ...overrides,
  };
}

/**
 * Build a fake LlmEmbedder that succeeds with a zero vector, or throws on
 * the given companyId / call index.
 */
function makeFakeEmbedder(
  outcome:
    | { type: "success" }
    | { type: "throw"; err: unknown },
): { embed: ReturnType<typeof vi.fn> } {
  if (outcome.type === "success") {
    return {
      embed: vi.fn().mockResolvedValue(Array.from({ length: 1536 }, () => 0)),
    };
  }
  return {
    embed: vi.fn().mockRejectedValue(outcome.err),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("processQueue — transient error handling", () => {
  beforeEach(() => vi.clearAllMocks());

  it("retries a transient error: status=pending, attempts bumped, next_retry_at set", async () => {
    const db = createSequenceDb({
      selects: [[makeQueueRow({ id: "q-1", attempts: 0 })]],
    });

    const transientErr = Object.assign(new Error("server error"), { status: 503 });
    const svc = createEmbeddingService(db as any, makeFakeEmbedder({ type: "throw", err: transientErr }));

    const result = await svc.processQueue({ maxAttempts: 6 });

    expect(result.processed).toBe(0);
    expect(result.failed).toBe(0);

    // Find the update that set status (excluding the processing claim).
    const statusUpdates = db.updateCalls.filter(
      (u) => u.set.status !== "processing",
    );
    expect(statusUpdates.length).toBeGreaterThanOrEqual(1);
    const retryUpdate = statusUpdates[0];
    expect(retryUpdate.set.status).toBe("pending");
    expect(retryUpdate.set.attempts).toBe(1);
    expect(retryUpdate.set.nextRetryAt).toBeInstanceOf(Date);
    // next_retry_at should be in the future
    expect((retryUpdate.set.nextRetryAt as Date).getTime()).toBeGreaterThan(Date.now());
  });

  it("marks row failed after reaching maxAttempts on transient error", async () => {
    const db = createSequenceDb({
      selects: [[makeQueueRow({ id: "q-1", attempts: 5 })]],
    });

    const transientErr = Object.assign(new Error("timeout"), { status: 503 });
    const svc = createEmbeddingService(db as any, makeFakeEmbedder({ type: "throw", err: transientErr }));

    const result = await svc.processQueue({ maxAttempts: 6 });

    expect(result.failed).toBe(1);
    expect(result.processed).toBe(0);

    const statusUpdates = db.updateCalls.filter(
      (u) => u.set.status !== "processing",
    );
    const failUpdate = statusUpdates[0];
    expect(failUpdate.set.status).toBe("failed");
    expect(failUpdate.set.attempts).toBe(6);
    // nextRetryAt should be null (no point scheduling a retry for a dead row)
    expect(failUpdate.set.nextRetryAt).toBeNull();
  });

  it("does not mark failed if attempts < maxAttempts", async () => {
    const db = createSequenceDb({
      selects: [[makeQueueRow({ id: "q-1", attempts: 2 })]],
    });

    const transientErr = Object.assign(new Error("rate limited"), { status: 429 });
    const svc = createEmbeddingService(db as any, makeFakeEmbedder({ type: "throw", err: transientErr }));

    const result = await svc.processQueue({ maxAttempts: 6 });

    expect(result.failed).toBe(0);
    const statusUpdates = db.updateCalls.filter((u) => u.set.status !== "processing");
    expect(statusUpdates[0].set.status).toBe("pending");
    expect(statusUpdates[0].set.attempts).toBe(3);
  });
});

describe("processQueue — row_permanent error handling", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks row failed immediately on HTTP 400 (bad input)", async () => {
    const db = createSequenceDb({
      selects: [[makeQueueRow({ id: "q-1", attempts: 0 })]],
    });

    const permErr = Object.assign(new Error("invalid input"), { status: 400 });
    const svc = createEmbeddingService(db as any, makeFakeEmbedder({ type: "throw", err: permErr }));

    const result = await svc.processQueue({ maxAttempts: 6 });

    expect(result.failed).toBe(1);
    expect(result.processed).toBe(0);

    const statusUpdates = db.updateCalls.filter((u) => u.set.status !== "processing");
    expect(statusUpdates.length).toBeGreaterThanOrEqual(1);
    const failUpdate = statusUpdates[0];
    expect(failUpdate.set.status).toBe("failed");
    // attempts bumped by 1
    expect(failUpdate.set.attempts).toBe(1);
  });

  it("marks row failed immediately on HTTP 422 even with attempts=0", async () => {
    const db = createSequenceDb({
      selects: [[makeQueueRow({ id: "q-1", attempts: 0 })]],
    });

    const permErr = Object.assign(new Error("unprocessable entity"), { status: 422 });
    const svc = createEmbeddingService(db as any, makeFakeEmbedder({ type: "throw", err: permErr }));

    const result = await svc.processQueue({ maxAttempts: 6 });

    expect(result.failed).toBe(1);
    const failUpdate = db.updateCalls.filter((u) => u.set.status !== "processing")[0];
    expect(failUpdate.set.status).toBe("failed");
  });

  it("does NOT set next_retry_at on row_permanent failure", async () => {
    const db = createSequenceDb({
      selects: [[makeQueueRow({ id: "q-1", attempts: 0 })]],
    });

    const permErr = Object.assign(new Error("bad input"), { status: 400 });
    const svc = createEmbeddingService(db as any, makeFakeEmbedder({ type: "throw", err: permErr }));

    await svc.processQueue({ maxAttempts: 6 });

    const statusUpdates = db.updateCalls.filter((u) => u.set.status !== "processing");
    // row_permanent doesn't set nextRetryAt (field absent or undefined)
    expect(statusUpdates[0].set.nextRetryAt).toBeUndefined();
  });
});

describe("processQueue — systemic error + circuit breaker", () => {
  beforeEach(() => vi.clearAllMocks());

  it("restores row to pending (attempts unchanged) on systemic error", async () => {
    const db = createSequenceDb({
      selects: [
        [makeQueueRow({ id: "q-1", attempts: 0, companyId: "company-A" })],
      ],
    });

    const systemicErr = Object.assign(new Error("Unauthorized"), { status: 401 });
    const circuit = new Map<string, CircuitEntry>();
    const svc = createEmbeddingService(db as any, makeFakeEmbedder({ type: "throw", err: systemicErr }));

    const result = await svc.processQueue({ circuit });

    expect(result.processed).toBe(0);
    expect(result.failed).toBe(0);

    // Row restored to pending
    const statusUpdates = db.updateCalls.filter((u) => u.set.status !== "processing");
    expect(statusUpdates.length).toBeGreaterThanOrEqual(1);
    const restoreUpdate = statusUpdates[0];
    expect(restoreUpdate.set.status).toBe("pending");
    // attempts must NOT be bumped
    expect(restoreUpdate.set.attempts).toBeUndefined();
  });

  it("opens the circuit for the company on systemic error", async () => {
    const db = createSequenceDb({
      selects: [
        [makeQueueRow({ id: "q-1", attempts: 0, companyId: "company-A" })],
      ],
    });

    const systemicErr = Object.assign(new Error("Unauthorized"), { status: 401 });
    const circuit = new Map<string, CircuitEntry>();
    const svc = createEmbeddingService(db as any, makeFakeEmbedder({ type: "throw", err: systemicErr }));

    await svc.processQueue({ circuit });

    // Circuit should be open for company-A
    expect(circuit.has("company-A")).toBe(true);
    expect(circuit.get("company-A")!.until).toBeGreaterThan(Date.now());
  });

  it("skips second company-A row after systemic error on first row", async () => {
    // Two company-A rows + one company-B row.
    // Uses the LEGACY path (no resolveCompanyKey) so the injected embedder is
    // used directly, letting us control throw vs. success per call index.
    // The circuit breaker still operates on companyId from the row.
    const rows = [
      makeQueueRow({ id: "q-1", attempts: 0, companyId: "company-A" }),
      makeQueueRow({ id: "q-2", attempts: 0, companyId: "company-A" }),
      makeQueueRow({ id: "q-3", attempts: 0, companyId: "company-B" }),
    ];

    const db = createSequenceDb({ selects: [rows] });

    // Embedder: throws systemic on first call (company-A q-1), succeeds for company-B q-3.
    // company-A q-2 is never reached (circuit opened by q-1, skipped this tick).
    let embedCallCount = 0;
    const embedder = {
      embed: vi.fn().mockImplementation(async () => {
        embedCallCount++;
        if (embedCallCount === 1) {
          // company-A's first row — systemic error
          const err = Object.assign(new Error("Unauthorized"), { status: 401 });
          throw err;
        }
        // company-B's row — success
        return Array.from({ length: 1536 }, () => 0);
      }),
    };

    const circuit = new Map<string, CircuitEntry>();
    // No resolveCompanyKey — legacy path uses the injected embedder directly.
    const svc = createEmbeddingService(db as any, embedder);

    const result = await svc.processQueue({ circuit });

    // company-A q-1: systemic → circuit opened, row restored to pending (not counted as failed/processed)
    // company-A q-2: circuit open this tick → skipped (restored to pending, counted as skipped)
    // company-B q-3: succeeds → processed=1
    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);

    // Embedder was called exactly TWICE: once for q-1 (threw systemic), once for q-3 (succeeded).
    // q-2 was never passed to embed (circuit short-circuit).
    expect(embedder.embed).toHaveBeenCalledTimes(2);
  });

  it("company-B row succeeds even when company-A has a systemic error", async () => {
    // Legacy path so the injected embedder controls throw/success per call.
    const rows = [
      makeQueueRow({ id: "q-1", attempts: 0, companyId: "company-A" }),
      makeQueueRow({ id: "q-2", attempts: 0, companyId: "company-B" }),
    ];

    const db = createSequenceDb({ selects: [rows] });

    let callIdx = 0;
    const embedder = {
      embed: vi.fn().mockImplementation(async () => {
        callIdx++;
        if (callIdx === 1) {
          // company-A's row — systemic
          const err = Object.assign(new Error("Unauthorized"), { status: 401 });
          throw err;
        }
        // company-B's row — success
        return Array.from({ length: 1536 }, () => 0.5);
      }),
    };

    const circuit = new Map<string, CircuitEntry>();
    const svc = createEmbeddingService(db as any, embedder);

    const result = await svc.processQueue({ circuit });

    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);

    // company-B update should include status='completed'
    const completedUpdates = db.updateCalls.filter(
      (u) => u.set.status === "completed",
    );
    expect(completedUpdates.length).toBe(1);
  });

  it("circuit persists across ticks (second tick skips company-A without calling embedder)", async () => {
    const circuit = new Map<string, CircuitEntry>();
    // Pre-open the circuit for company-A (simulating a previous tick)
    circuit.set("company-A", {
      reason: "Unauthorized",
      until: Date.now() + 60_000,
    });

    const db = createSequenceDb({
      selects: [
        [makeQueueRow({ id: "q-1", attempts: 0, companyId: "company-A" })],
      ],
    });

    // Legacy path: injected embedder; circuit check fires before resolveCompanyKey.
    const embedder = {
      embed: vi.fn().mockResolvedValue(Array.from({ length: 1536 }, () => 0)),
    };

    const svc = createEmbeddingService(db as any, embedder);
    // No resolveCompanyKey — circuit check still fires because it's before key-resolution.
    const result = await svc.processQueue({ circuit });

    // Row skipped — embedder NOT called because circuit is open
    expect(embedder.embed).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    expect(result.processed).toBe(0);
  });

  it("circuit auto-closes after TTL expires", async () => {
    const circuit = new Map<string, CircuitEntry>();
    // Expired circuit
    circuit.set("company-A", {
      reason: "old error",
      until: Date.now() - 1, // already expired
    });

    const db = createSequenceDb({
      selects: [
        [makeQueueRow({ id: "q-1", attempts: 0, companyId: "company-A" })],
      ],
    });

    // Legacy path: injected embedder is used directly, so we can assert it was called.
    const embedder = {
      embed: vi.fn().mockResolvedValue(Array.from({ length: 1536 }, () => 0)),
    };

    const svc = createEmbeddingService(db as any, embedder);
    // No resolveCompanyKey — legacy path uses the injected embedder.
    const result = await svc.processQueue({ circuit });

    // Expired circuit → row should be embedded and processed
    expect(embedder.embed).toHaveBeenCalledTimes(1);
    expect(result.processed).toBe(1);
    // Stale circuit entry should have been cleared
    expect(circuit.has("company-A")).toBe(false);
  });
});

describe("processQueue — successful embed", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks row completed and calls embedder with the row's inputText", async () => {
    const db = createSequenceDb({
      selects: [[makeQueueRow({ id: "q-1", inputText: "hello world" })]],
    });

    const embedder = {
      embed: vi.fn().mockResolvedValue(Array.from({ length: 1536 }, () => 0.1)),
    };

    const svc = createEmbeddingService(db as any, embedder);
    const result = await svc.processQueue();

    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);
    expect(embedder.embed).toHaveBeenCalledWith("hello world");

    const completedUpdates = db.updateCalls.filter(
      (u) => u.set.status === "completed",
    );
    expect(completedUpdates.length).toBe(1);
  });
});
