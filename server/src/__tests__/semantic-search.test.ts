import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeTableProxy, drizzleOperatorStubs, mockDbCapabilities } from "./helpers/drizzle-mock.js";

// Mock drizzle-orm and db to avoid ESM cycle issues
vi.mock("drizzle-orm", () => drizzleOperatorStubs());
vi.mock("@armyofagents/db", () => ({
  memoryItems: makeTableProxy("memory_items"),
}));

// Embedding generation, semantic search, and embedding invalidation are all
// gated behind hasVectorSupport. Default in production is false (probe hasn't
// run). All tests in this file exercise those paths, so override to true.
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

// Track resolveApiKey calls
const mockResolveApiKey = vi.fn();
// Search paths resolve the embedding key via getProviderApiKey (env-fallback
// aware). Delegate to the same mock (dropping the leading db arg) so existing
// has-key / no-key scenarios keep driving the vector vs. text-fallback paths.
vi.mock("../services/internal-agent/providers/index.js", () => ({
  getProviderApiKey: (...args: any[]) => mockResolveApiKey(...args.slice(1)),
}));
vi.mock("../adapters/api-common.js", () => ({
  resolveApiKey: (...args: any[]) => mockResolveApiKey(...args),
}));

// Track generateEmbedding calls
const mockGenerateEmbedding = vi.fn();
vi.mock("../services/embeddings.js", () => ({
  generateEmbedding: (...args: any[]) => mockGenerateEmbedding(...args),
}));

import { memoryService } from "../services/memory.js";

function makeFakeEmbedding(dim = 1536): number[] {
  return Array.from({ length: dim }, (_, i) => i * 0.001);
}

describe("Memory Service — Semantic Search", () => {
  // Create a mock db that returns controlled results
  function makeMockDb(rows: any[] = []) {
    const chain = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(rows),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      delete: vi.fn().mockReturnThis(),
      then: vi.fn(),
    };
    return chain as any;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("searchSemantic", () => {
    it("falls back to text search when no API key is configured", async () => {
      const missingKeyError = new Error("Configure your OpenAI API key");
      (missingKeyError as any).errorCode = "missing_api_key";
      mockResolveApiKey.mockRejectedValue(missingKeyError);

      const mockDb = makeMockDb([
        { id: "1", title: "Test", content: "Matching content", similarity: null },
      ]);
      const svc = memoryService(mockDb);

      const results = await svc.searchSemantic("company-1", "test query");

      expect(mockResolveApiKey).toHaveBeenCalledWith("company-1", "openai");
      expect(mockGenerateEmbedding).not.toHaveBeenCalled();
      expect(results).toHaveLength(1);
    });

    it("uses embedding-based search when API key is available", async () => {
      const fakeEmbedding = makeFakeEmbedding();
      mockResolveApiKey.mockResolvedValue("sk-test-key");
      mockGenerateEmbedding.mockResolvedValue(fakeEmbedding);

      const mockDb = makeMockDb([
        { id: "1", title: "Relevant", content: "Matching content", similarity: 0.92 },
      ]);
      const svc = memoryService(mockDb);

      const results = await svc.searchSemantic("company-1", "test query");

      expect(mockResolveApiKey).toHaveBeenCalledWith("company-1", "openai");
      expect(mockGenerateEmbedding).toHaveBeenCalledWith("test query", "sk-test-key");
      expect(results).toHaveLength(1);
    });

    it("falls back to text search when embedding generation fails", async () => {
      mockResolveApiKey.mockResolvedValue("sk-test-key");
      mockGenerateEmbedding.mockRejectedValue(new Error("API rate limited"));

      const mockDb = makeMockDb([
        { id: "1", title: "Fallback result", similarity: null },
      ]);
      const svc = memoryService(mockDb);

      const results = await svc.searchSemantic("company-1", "test query");

      expect(results).toHaveLength(1);
    });

    it("passes filter parameters (layer, departmentId)", async () => {
      mockResolveApiKey.mockResolvedValue("sk-test-key");
      mockGenerateEmbedding.mockResolvedValue(makeFakeEmbedding());

      const mockDb = makeMockDb([]);
      const svc = memoryService(mockDb);

      await svc.searchSemantic("company-1", "test", {
        layer: "domain",
        departmentId: "dept-1",
        limit: 5,
      });

      // Verify the query was built with filters (db.select was called)
      expect(mockDb.select).toHaveBeenCalled();
      expect(mockDb.limit).toHaveBeenCalledWith(5);
    });

    it("applies default limit of 10", async () => {
      mockResolveApiKey.mockResolvedValue("sk-test-key");
      mockGenerateEmbedding.mockResolvedValue(makeFakeEmbedding());

      const mockDb = makeMockDb([]);
      const svc = memoryService(mockDb);

      await svc.searchSemantic("company-1", "test");

      expect(mockDb.limit).toHaveBeenCalledWith(10);
    });
  });

  describe("findSimilarItems", () => {
    it("falls back to text overlap when no API key", async () => {
      const missingKeyError = new Error("No key");
      (missingKeyError as any).errorCode = "missing_api_key";
      mockResolveApiKey.mockRejectedValue(missingKeyError);

      const mockDb = makeMockDb([
        {
          id: "1",
          title: "Test item matching words",
          content: "matching content words here for testing overlap",
          category: "reference",
          source: "founder",
          status: "approved",
          tags: [],
          departmentId: null,
          projectId: null,
          layer: "domain",
          priority: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);
      const svc = memoryService(mockDb);

      const results = await svc.findSimilarItems(
        "matching content words here for testing overlap",
        { companyId: "company-1" },
      );

      expect(mockGenerateEmbedding).not.toHaveBeenCalled();
      // Results may or may not match depending on overlap calculation
      expect(Array.isArray(results)).toBe(true);
    });

    it("uses cosine similarity when API key is available", async () => {
      mockResolveApiKey.mockResolvedValue("sk-test-key");
      mockGenerateEmbedding.mockResolvedValue(makeFakeEmbedding());

      const mockDb = makeMockDb([
        { id: "1", title: "Similar item", content: "Very similar", similarity: 0.91 },
      ]);
      const svc = memoryService(mockDb);

      const results = await svc.findSimilarItems("test content", {
        companyId: "company-1",
        departmentId: "dept-1",
        layer: "domain",
      });

      expect(mockGenerateEmbedding).toHaveBeenCalledWith("test content", "sk-test-key");
      expect(results).toHaveLength(1);
    });

    it("falls back to text overlap when embedding generation fails", async () => {
      mockResolveApiKey.mockResolvedValue("sk-test-key");
      mockGenerateEmbedding.mockRejectedValue(new Error("API error"));

      const mockDb = makeMockDb([]);
      const svc = memoryService(mockDb);

      const results = await svc.findSimilarItems("test content here", {
        companyId: "company-1",
      });

      expect(Array.isArray(results)).toBe(true);
    });

    it("returns empty for empty content in text fallback", async () => {
      const missingKeyError = new Error("No key");
      mockResolveApiKey.mockRejectedValue(missingKeyError);

      const mockDb = makeMockDb([]);
      const svc = memoryService(mockDb);

      // Short words (<=2 chars) are filtered, so "a b c" → empty
      const results = await svc.findSimilarItems("a b c", {
        companyId: "company-1",
      });

      expect(results).toEqual([]);
    });
  });
});

describe("Memory Service — Embedding invalidation on update", () => {
  it("sets embedding to null when content changes", async () => {
    const setData: Record<string, any> = {};
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockReturnValue({
        then: vi.fn().mockResolvedValue(null),
      }),
      update: vi.fn().mockReturnThis(),
      set: vi.fn((data: any) => {
        Object.assign(setData, data);
        return {
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockReturnValue({
              then: vi.fn().mockResolvedValue(null),
            }),
          }),
        };
      }),
      delete: vi.fn().mockReturnThis(),
      then: vi.fn(),
    } as any;

    const svc = memoryService(mockDb);
    await svc.update("company-1", "item-1", { content: "updated content" });

    expect(setData.embedding).toBeNull();
    expect(setData.content).toBe("updated content");
  });

  it("sets embedding to null when title changes", async () => {
    const setData: Record<string, any> = {};
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockReturnValue({
        then: vi.fn().mockResolvedValue(null),
      }),
      update: vi.fn().mockReturnThis(),
      set: vi.fn((data: any) => {
        Object.assign(setData, data);
        return {
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockReturnValue({
              then: vi.fn().mockResolvedValue(null),
            }),
          }),
        };
      }),
      delete: vi.fn().mockReturnThis(),
      then: vi.fn(),
    } as any;

    const svc = memoryService(mockDb);
    await svc.update("company-1", "item-1", { title: "new title" });

    expect(setData.embedding).toBeNull();
  });

  it("does NOT invalidate embedding when non-content fields change", async () => {
    const setData: Record<string, any> = {};
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockReturnValue({
        then: vi.fn().mockResolvedValue(null),
      }),
      update: vi.fn().mockReturnThis(),
      set: vi.fn((data: any) => {
        Object.assign(setData, data);
        return {
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockReturnValue({
              then: vi.fn().mockResolvedValue(null),
            }),
          }),
        };
      }),
      delete: vi.fn().mockReturnThis(),
      then: vi.fn(),
    } as any;

    const svc = memoryService(mockDb);
    await svc.update("company-1", "item-1", { category: "insight" });

    expect(setData.embedding).toBeUndefined();
  });
});

describe("Memory Service — Embedding is NULL on create", () => {
  it("always creates items with embedding=null", async () => {
    // buildMemoryInsert now uses db.execute() with a raw SQL template.
    // The INSERT excludes the embedding column when hasVector=false (the test default),
    // which is equivalent to inserting with embedding=null.
    const mockDb = {
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockReturnThis(),
      // buildMemoryInsert calls db.execute() — return a row with embedding null
      execute: vi.fn().mockResolvedValue([{ id: "new-item", embedding: null }]),
    } as any;

    const svc = memoryService(mockDb);
    const result = await svc.create("company-1", {
      title: "Test",
      content: "Content",
      category: "reference",
      source: "founder",
      createdBy: "user-1",
    });

    // db.execute was called (raw INSERT via buildMemoryInsert)
    expect(mockDb.execute).toHaveBeenCalledTimes(1);
    // The returned row has embedding=null (no vector column without pgvector)
    expect(result.embedding).toBeNull();
  });
});
