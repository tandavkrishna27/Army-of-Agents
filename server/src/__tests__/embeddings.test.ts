import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock drizzle-orm and db to avoid ESM cycle issues
vi.mock("drizzle-orm", () => ({
  and: vi.fn(),
  eq: vi.fn(),
  isNull: vi.fn(),
  lte: vi.fn(),
  or: vi.fn(),
  sql: vi.fn(),
}));
vi.mock("@armyofagents/db", () => ({
  memoryItems: {
    id: "id",
    companyId: "company_id",
    status: "status",
    embedding: "embedding",
    content: "content",
  },
  // Added for Task B1: the embeddings module imports these for the
  // write-behind queue's `TARGET_TABLE_MAP`. These tests don't exercise
  // the new factory, so stub references are sufficient.
  discussions: { id: "id" },
  discussionExtractedItems: { id: "id" },
  embeddingQueue: { id: "id" },
}));

// Mock logger before importing module under test
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

// P1-1: generateEmbedding and generateEmbeddingsBatch now delegate to
// createOpenAiEmbedder (OpenAI SDK), not a direct fetch. Mock the SDK.
const mockEmbeddingsCreate = vi.fn();
vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(() => ({
    embeddings: {
      create: mockEmbeddingsCreate,
    },
  })),
}));

// db-capabilities is imported by the module at top level
vi.mock("../services/db-capabilities.js", () => ({
  getDbCapabilities: vi.fn(() => ({ hasVectorSupport: false })),
}));

import { generateEmbedding, generateEmbeddingsBatch } from "../services/embeddings.js";

describe("Embedding Generation", () => {
  let savedFakeEmbedderEnv: string | undefined;

  beforeEach(() => {
    // Reset the SDK mock call history without restoring it
    mockEmbeddingsCreate.mockReset();
    // Ensure fake embedder is off for all tests in this suite
    savedFakeEmbedderEnv = process.env.AOA_E2E_FAKE_EMBEDDER;
    delete process.env.AOA_E2E_FAKE_EMBEDDER;
  });

  afterEach(() => {
    if (savedFakeEmbedderEnv === undefined) {
      delete process.env.AOA_E2E_FAKE_EMBEDDER;
    } else {
      process.env.AOA_E2E_FAKE_EMBEDDER = savedFakeEmbedderEnv;
    }
  });

  function makeFakeEmbedding(dim = 1536): number[] {
    return Array.from({ length: dim }, (_, i) => i * 0.001);
  }

  describe("generateEmbedding", () => {
    it("calls OpenAI SDK and returns 1536-dim vector", async () => {
      const fakeEmbedding = makeFakeEmbedding();
      mockEmbeddingsCreate.mockResolvedValue({
        data: [{ embedding: fakeEmbedding }],
      });

      const result = await generateEmbedding("Hello world", "sk-test-key");

      expect(result).toEqual(fakeEmbedding);
      expect(result).toHaveLength(1536);
      expect(mockEmbeddingsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "text-embedding-3-small",
          input: "Hello world",
        }),
      );
    });

    it("throws on empty text", async () => {
      await expect(generateEmbedding("", "sk-test")).rejects.toThrow(
        "Cannot generate embedding for empty text",
      );
      await expect(generateEmbedding("   ", "sk-test")).rejects.toThrow(
        "Cannot generate embedding for empty text",
      );
    });

    it("throws when OpenAI SDK returns no embedding data", async () => {
      mockEmbeddingsCreate.mockResolvedValue({ data: [] });

      await expect(generateEmbedding("test", "sk-test")).rejects.toThrow(
        "OpenAI returned no embedding data",
      );
    });

    it("propagates SDK errors", async () => {
      mockEmbeddingsCreate.mockRejectedValue(new Error("network error"));

      await expect(generateEmbedding("test", "sk-test")).rejects.toThrow(
        "network error",
      );
    });

    it("routes through fake embedder when AOA_E2E_FAKE_EMBEDDER=1", async () => {
      process.env.AOA_E2E_FAKE_EMBEDDER = "1";

      const result = await generateEmbedding("Hello world", "any-key");

      // Must NOT have called the OpenAI SDK
      expect(mockEmbeddingsCreate).not.toHaveBeenCalled();
      // Must return a 1536-dim vector (fake)
      expect(result).toHaveLength(1536);
      for (const v of result) {
        expect(Number.isFinite(v)).toBe(true);
      }
    });
  });

  describe("generateEmbeddingsBatch", () => {
    it("calls OpenAI SDK and returns vectors in input order", async () => {
      const emb1 = makeFakeEmbedding();
      const emb2 = makeFakeEmbedding();
      // Simulate batch fetch path via the underlying fetch (legacy path, fake OFF)
      // generateEmbeddingsBatch uses direct fetch when fake is off.
      // We need to mock global fetch for the batch path.
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { embedding: emb1, index: 0 },
            { embedding: emb2, index: 1 },
          ],
        }),
      });

      try {
        const result = await generateEmbeddingsBatch(["hello", "world"], "sk-test");

        expect(result).toHaveLength(2);
        expect(result[0]).toEqual(emb1);
        expect(result[1]).toEqual(emb2);
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("returns empty array for empty input", async () => {
      const result = await generateEmbeddingsBatch([], "sk-test");
      expect(result).toEqual([]);
    });

    it("filters out empty strings before calling API", async () => {
      const emb1 = makeFakeEmbedding();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [{ embedding: emb1, index: 0 }],
        }),
      });

      try {
        const result = await generateEmbeddingsBatch(["hello", "", "  "], "sk-test");

        expect(result).toHaveLength(1);
        const call = (globalThis.fetch as any).mock.calls[0];
        const body = JSON.parse(call[1].body);
        expect(body.input).toEqual(["hello"]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("sorts results by index to maintain order", async () => {
      const emb1 = makeFakeEmbedding();
      const emb2 = makeFakeEmbedding();
      const originalFetch = globalThis.fetch;
      // API returns out of order
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            { embedding: emb2, index: 1 },
            { embedding: emb1, index: 0 },
          ],
        }),
      });

      try {
        const result = await generateEmbeddingsBatch(["first", "second"], "sk-test");

        expect(result[0]).toEqual(emb1);
        expect(result[1]).toEqual(emb2);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("throws on API error", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "Internal server error",
      });

      try {
        await expect(
          generateEmbeddingsBatch(["test"], "sk-test"),
        ).rejects.toThrow("OpenAI Embeddings API error 500");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("routes through fake embedder when AOA_E2E_FAKE_EMBEDDER=1 (no fetch, no SDK)", async () => {
      process.env.AOA_E2E_FAKE_EMBEDDER = "1";
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn();

      try {
        const result = await generateEmbeddingsBatch(["hello", "world"], "any-key");

        // Fake path: one vector per input, no fetch
        expect(result).toHaveLength(2);
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(mockEmbeddingsCreate).not.toHaveBeenCalled();
        for (const vec of result) {
          expect(vec).toHaveLength(1536);
          for (const v of vec) expect(Number.isFinite(v)).toBe(true);
        }
      } finally {
        globalThis.fetch = originalFetch;
        delete process.env.AOA_E2E_FAKE_EMBEDDER;
      }
    });
  });
});
