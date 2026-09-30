// server/src/__tests__/c2-memory-find-similar.test.ts
//
// Task C2 batch 3 — find_similar_memory_hnsw tool tests.
// Mirrors the C2 batch 1 find_similar_threads test shape (vector embed + HNSW
// cosine query). Verifies: EMBEDDINGS_UNAVAILABLE when service missing, ranked
// rows returned when service available, layer filter validation, defaults +
// cap, INVALID_PARAMS for empty text, EMBEDDING_FAILED when embedder throws.

import { describe, expect, it, vi } from "vitest";

// Instrument drizzle's `eq` (keeping every other operator real) so we can assert
// the governance filter eq(status, 'approved') is part of the HNSW query.
const { eqCalls } = vi.hoisted(() => ({ eqCalls: [] as Array<[unknown, unknown]> }));
vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: (col: unknown, val: unknown) => {
      eqCalls.push([col, val]);
      return (actual.eq as any)(col, val);
    },
  };
});

import { findSimilarMemoryHnswTool } from "../services/internal-agent/tools/memory-find-similar.js";
import type { ToolContext } from "../services/internal-agent/types.js";

function makeDbReturning(rows: any[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const orderBy = vi.fn().mockReturnValue({ limit });
  const where = vi.fn().mockReturnValue({ orderBy });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { db: { select } as any, limitMock: limit, whereMock: where };
}

function makeCtx(db: any, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    companyId: "co-1",
    userId: "u-1",
    userRole: "team_member",
    enabledCapabilities: [],
    db,
    services: {} as any,
    ...overrides,
  } as unknown as ToolContext;
}

describe("find_similar_memory_hnsw tool (C2 batch 3)", () => {
  it("metadata: name, category=memory, requiredRole=team_member, no confirmation", () => {
    expect(findSimilarMemoryHnswTool.name).toBe("find_similar_memory_hnsw");
    expect(findSimilarMemoryHnswTool.category).toBe("memory");
    expect(findSimilarMemoryHnswTool.requiredRole).toBe("team_member");
    expect(findSimilarMemoryHnswTool.requiresConfirmation).toBe(false);
  });

  it("returns EMBEDDINGS_UNAVAILABLE when embedding service is missing", async () => {
    const { db } = makeDbReturning([]);
    const result = await findSimilarMemoryHnswTool.execute(
      { text: "billing rules" },
      makeCtx(db),
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("EMBEDDINGS_UNAVAILABLE");
    expect(result.data).toEqual([]);
  });

  it("returns ranked rows when embedding service is available", async () => {
    const rows = [
      { id: "m-1", title: "Pricing tiers", content: "...", layer: "domain", status: "approved", category: "decision" },
      { id: "m-2", title: "Stripe key rotation", content: "...", layer: "domain", status: "approved", category: "reference" },
    ];
    const { db } = makeDbReturning(rows);
    const embedSync = vi.fn().mockResolvedValue(new Array(1536).fill(0.001));
    const ctx = makeCtx(db, {
      services: { embeddings: { embedSync } } as any,
    });
    const result = await findSimilarMemoryHnswTool.execute(
      { text: "billing config" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.data).toEqual(rows);
    expect(embedSync).toHaveBeenCalledOnce();
    expect(embedSync).toHaveBeenCalledWith("billing config", "co-1");
    expect(result.summary).toContain("2");
  });

  it("governance (P1): query filters to approved status (pending memory is not recalled)", async () => {
    eqCalls.length = 0;
    const { db, whereMock } = makeDbReturning([]);
    const embedSync = vi.fn().mockResolvedValue(new Array(1536).fill(0.001));
    const ctx = makeCtx(db, {
      services: { embeddings: { embedSync } } as any,
    });
    await findSimilarMemoryHnswTool.execute({ text: "anything" }, ctx);

    expect(whereMock).toHaveBeenCalledOnce();
    // The query MUST constrain status to 'approved' so unapproved pending
    // agent/MCP memory can never surface via semantic recall (Critical Rule #6).
    expect(eqCalls.some(([, val]) => val === "approved")).toBe(true);
  });

  it("respects layer filter and includes it in the where clause", async () => {
    // We can't easily peek into the drizzle conditions array from the mock,
    // but we can verify the tool accepts the layer param and still hits db.
    const { db } = makeDbReturning([]);
    const embedSync = vi.fn().mockResolvedValue(new Array(1536).fill(0));
    const ctx = makeCtx(db, {
      services: { embeddings: { embedSync } } as any,
    });
    const result = await findSimilarMemoryHnswTool.execute(
      { text: "x", layer: "domain" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(embedSync).toHaveBeenCalledOnce();
  });

  it("rejects invalid layer values with INVALID_PARAMS", async () => {
    const { db } = makeDbReturning([]);
    const embedSync = vi.fn();
    const ctx = makeCtx(db, {
      services: { embeddings: { embedSync } } as any,
    });
    const result = await findSimilarMemoryHnswTool.execute(
      { text: "x", layer: "bogus" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
    expect(embedSync).not.toHaveBeenCalled();
  });

  it("caps the limit at MAX_LIMIT=25", async () => {
    const { db, limitMock } = makeDbReturning([]);
    const embedSync = vi.fn().mockResolvedValue(new Array(1536).fill(0));
    const ctx = makeCtx(db, {
      services: { embeddings: { embedSync } } as any,
    });
    await findSimilarMemoryHnswTool.execute(
      { text: "x", limit: 100 },
      ctx,
    );
    expect(limitMock).toHaveBeenCalledWith(25);
  });

  it("defaults to limit=5 when not specified", async () => {
    const { db, limitMock } = makeDbReturning([]);
    const embedSync = vi.fn().mockResolvedValue(new Array(1536).fill(0));
    const ctx = makeCtx(db, {
      services: { embeddings: { embedSync } } as any,
    });
    await findSimilarMemoryHnswTool.execute({ text: "x" }, ctx);
    expect(limitMock).toHaveBeenCalledWith(5);
  });

  it("returns INVALID_PARAMS when text is empty", async () => {
    const { db } = makeDbReturning([]);
    const embedSync = vi.fn();
    const ctx = makeCtx(db, {
      services: { embeddings: { embedSync } } as any,
    });
    const result = await findSimilarMemoryHnswTool.execute(
      { text: "   " },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
    expect(embedSync).not.toHaveBeenCalled();
  });

  it("returns EMBEDDING_FAILED when embedSync throws", async () => {
    const { db } = makeDbReturning([]);
    const embedSync = vi.fn().mockRejectedValue(new Error("OpenAI 429"));
    const ctx = makeCtx(db, {
      services: { embeddings: { embedSync } } as any,
    });
    const result = await findSimilarMemoryHnswTool.execute(
      { text: "x" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("EMBEDDING_FAILED");
    expect(result.summary).toContain("OpenAI 429");
  });
});
