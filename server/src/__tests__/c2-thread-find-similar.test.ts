// server/src/__tests__/c2-thread-find-similar.test.ts
//
// Task C2 batch 1 — find_similar_threads tool tests.
// Verifies: graceful EMBEDDINGS_UNAVAILABLE when service missing, embed-and-
// query happy path when service available, param validation, and embedding
// failure handling.

import { describe, expect, it, vi } from "vitest";
import { findSimilarThreadsTool } from "../services/internal-agent/tools/thread-find-similar.js";
import type { ToolContext } from "../services/internal-agent/types.js";

function makeDbReturning(rows: any[]) {
  // db.select().from().where().orderBy().limit() → Promise<rows>
  const limit = vi.fn().mockResolvedValue(rows);
  const orderBy = vi.fn().mockReturnValue({ limit });
  const where = vi.fn().mockReturnValue({ orderBy });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { db: { select } as any, limitMock: limit };
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

describe("find_similar_threads tool (C2 batch 1)", () => {
  it("metadata: name, category=query, requiredRole=team_member, no confirmation", () => {
    expect(findSimilarThreadsTool.name).toBe("find_similar_threads");
    expect(findSimilarThreadsTool.category).toBe("query");
    expect(findSimilarThreadsTool.requiredRole).toBe("team_member");
    expect(findSimilarThreadsTool.requiresConfirmation).toBe(false);
  });

  it("returns EMBEDDINGS_UNAVAILABLE when embedding service is missing", async () => {
    const { db } = makeDbReturning([]);
    const ctx = makeCtx(db);
    const result = await findSimilarThreadsTool.execute(
      { text: "auth refactor" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("EMBEDDINGS_UNAVAILABLE");
    expect(result.data).toEqual([]);
  });

  it("returns ranked threads when embedding service is available", async () => {
    const rows = [
      { id: "t-1", title: "Auth refactor", summaryText: "...", visibility: "company", phase: "scope" },
      { id: "t-2", title: "Login bug", summaryText: "...", visibility: "company", phase: "done" },
    ];
    const { db } = makeDbReturning(rows);
    const embedSync = vi.fn().mockResolvedValue(new Array(1536).fill(0.001));
    const ctx = makeCtx(db, {
      services: { embeddings: { embedSync } } as any,
    });
    const result = await findSimilarThreadsTool.execute(
      { text: "auth flow" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.data).toEqual(rows);
    expect(embedSync).toHaveBeenCalledOnce();
    expect(embedSync).toHaveBeenCalledWith("auth flow", "co-1");
    expect(result.summary).toContain("2");
  });

  it("respects the limit parameter (capped at MAX_LIMIT=25)", async () => {
    const { db, limitMock } = makeDbReturning([]);
    const embedSync = vi.fn().mockResolvedValue(new Array(1536).fill(0));
    const ctx = makeCtx(db, {
      services: { embeddings: { embedSync } } as any,
    });
    await findSimilarThreadsTool.execute(
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
    await findSimilarThreadsTool.execute({ text: "x" }, ctx);
    expect(limitMock).toHaveBeenCalledWith(5);
  });

  it("returns INVALID_PARAMS when text is missing", async () => {
    const { db } = makeDbReturning([]);
    const embedSync = vi.fn();
    const ctx = makeCtx(db, {
      services: { embeddings: { embedSync } } as any,
    });
    const result = await findSimilarThreadsTool.execute({}, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
    expect(embedSync).not.toHaveBeenCalled();
  });

  it("returns INVALID_PARAMS when text is empty", async () => {
    const { db } = makeDbReturning([]);
    const embedSync = vi.fn();
    const ctx = makeCtx(db, {
      services: { embeddings: { embedSync } } as any,
    });
    const result = await findSimilarThreadsTool.execute(
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
    const result = await findSimilarThreadsTool.execute(
      { text: "x" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("EMBEDDING_FAILED");
    expect(result.summary).toContain("OpenAI 429");
  });
});
