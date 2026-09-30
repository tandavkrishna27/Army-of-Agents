/**
 * Codex fix regression tests (P1-2, P2-1).
 *
 * P1-2: resetStaleProcessing recovers stranded 'processing' rows.
 * P2-1: processQueue normalises db.execute() results from both driver shapes
 *       (array-like RowList AND { rows: [...] } object).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module-level mocks ─────────────────────────────────────────────────────────
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

import {
  resetStaleProcessing,
  createEmbeddingService,
  type LlmEmbedder,
} from "../services/embeddings.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFakeEmbedding(dim = 1536): number[] {
  return Array.from({ length: dim }, (_, i) => i * 0.001);
}

function makeMockEmbedder(vector: number[] = makeFakeEmbedding()): LlmEmbedder {
  return { embed: vi.fn().mockResolvedValue(vector) };
}

// ── P1-2: resetStaleProcessing ────────────────────────────────────────────────

describe("resetStaleProcessing (P1-2)", () => {
  it("resets stale processing rows to pending and returns count", async () => {
    const updatedRows = [{ id: "queue-1" }, { id: "queue-2" }];
    const db = {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue(updatedRows),
          }),
        }),
      }),
    };

    const result = await resetStaleProcessing(db as any, 5 * 60 * 1000);

    expect(result.reset).toBe(2);
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it("returns reset=0 when no stale rows exist", async () => {
    const db = {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    };

    const result = await resetStaleProcessing(db as any);

    expect(result.reset).toBe(0);
  });

  it("uses the provided leaseMs threshold (default = 5 min)", async () => {
    // We can't inspect the WHERE clause directly in the mock, but we can
    // verify the function doesn't throw and returns correctly for various
    // lease values.
    for (const leaseMs of [1000, 60_000, 10 * 60 * 1000]) {
      const db = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: "row-x" }]),
            }),
          }),
        }),
      };
      const result = await resetStaleProcessing(db as any, leaseMs);
      expect(result.reset).toBe(1);
    }
  });

  it("does NOT bump attempts (only status + nextRetryAt + updatedAt are set)", async () => {
    let capturedSet: Record<string, unknown> | null = null;
    const db = {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
          capturedSet = vals;
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: "row-1" }]),
            }),
          };
        }),
      }),
    };

    await resetStaleProcessing(db as any);

    expect(capturedSet).not.toBeNull();
    expect(capturedSet!.status).toBe("pending");
    expect("attempts" in capturedSet!).toBe(false);
    // nextRetryAt must be explicitly nulled out so the row is immediately eligible
    expect(capturedSet!.nextRetryAt).toBeNull();
  });
});

// ── P2-1: db.execute() result shape normalisation ─────────────────────────────

describe("processQueue — db.execute result shape normalisation (P2-1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Build a mock DB that makes db.execute() return the given shape, then
  // falls back to a sequence of select/update calls for the processing loop.
  function buildDbWithExecuteResult(executeResult: unknown) {
    const updateCalls: Array<Record<string, unknown>> = [];
    const makeUpdateChain = (set?: Record<string, unknown>) => {
      const chain: Record<string, unknown> = {};
      for (const m of ["where", "returning"]) {
        chain[m] = () => chain;
      }
      chain.set = (val: Record<string, unknown>) => {
        updateCalls.push(val);
        return chain;
      };
      chain.then = (resolve: (v: unknown[]) => unknown) =>
        Promise.resolve(resolve([]));
      return chain;
    };

    return {
      execute: vi.fn().mockResolvedValue(executeResult),
      update: vi.fn().mockReturnValue(makeUpdateChain()),
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      updateCalls,
    };
  }

  it("handles array shape (RowList) — processes a single row", async () => {
    const row = {
      id: "q-1",
      targetTable: "memory_items",
      targetId: "m-1",
      targetColumn: "embedding",
      inputText: "hello",
      status: "processing",
      attempts: 0,
      companyId: null,
      nextRetryAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      error: null,
    };

    // Array shape (standard RowList / most adapters)
    const db = buildDbWithExecuteResult([row]);
    const llm = makeMockEmbedder();
    const svc = createEmbeddingService(db as any, llm);
    const result = await svc.processQueue();

    // Row was picked up (not empty)
    expect(result.processed + result.failed + result.remaining).toBeGreaterThan(0);
  });

  it("handles {rows: [...]} shape — processes a single row", async () => {
    const row = {
      id: "q-2",
      targetTable: "memory_items",
      targetId: "m-2",
      targetColumn: "embedding",
      inputText: "world",
      status: "processing",
      attempts: 0,
      companyId: null,
      nextRetryAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      error: null,
    };

    // {rows: [...]} shape (some node-postgres adapter versions)
    const db = buildDbWithExecuteResult({ rows: [row] });
    const llm = makeMockEmbedder();
    const svc = createEmbeddingService(db as any, llm);
    const result = await svc.processQueue();

    // Row was picked up (not empty)
    expect(result.processed + result.failed + result.remaining).toBeGreaterThan(0);
  });

  it("handles empty array shape — returns zero results", async () => {
    const db = buildDbWithExecuteResult([]);
    const llm = makeMockEmbedder();
    const svc = createEmbeddingService(db as any, llm);
    const result = await svc.processQueue();

    expect(result).toEqual({ processed: 0, failed: 0, remaining: 0, skipped: 0 });
  });

  it("handles {rows: []} shape — returns zero results", async () => {
    const db = buildDbWithExecuteResult({ rows: [] });
    const llm = makeMockEmbedder();
    const svc = createEmbeddingService(db as any, llm);
    const result = await svc.processQueue();

    expect(result).toEqual({ processed: 0, failed: 0, remaining: 0, skipped: 0 });
  });
});
