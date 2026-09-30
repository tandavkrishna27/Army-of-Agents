/**
 * T15: env-gated fake embedder guard tests.
 *
 * These tests verify that createOpenAiEmbedder() returns the fake when the
 * guard is active, and the real OpenAI-backed embedder when it is not.
 * No real network calls are made.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── ESM/drizzle cycle stubs (required by embeddings.ts at module level) ──────
vi.mock("drizzle-orm", () => ({
  and: vi.fn(),
  eq: vi.fn(),
  isNull: vi.fn(),
  lte: vi.fn(),
  or: vi.fn(),
  sql: Object.assign(vi.fn(), { raw: vi.fn() }),
}));
vi.mock("@armyofagents/db", () => ({
  memoryItems: { id: "id", companyId: "company_id", status: "status", embedding: "embedding", content: "content", embeddingRetries: "embedding_retries" },
  discussions: { id: "id" },
  discussionExtractedItems: { id: "id" },
  embeddingQueue: { id: "id", status: "status", companyId: "company_id", nextRetryAt: "next_retry_at", createdAt: "created_at", updatedAt: "updated_at", attempts: "attempts", targetTable: "target_table", targetId: "target_id", targetColumn: "target_column", inputText: "input_text", error: "error" },
}));
vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));
vi.mock("../adapters/api-common.js", () => ({ resolveApiKey: vi.fn() }));
vi.mock("../services/db-capabilities.js", () => ({
  getDbCapabilities: vi.fn(() => ({ hasVectorSupport: false })),
}));

// Mock the OpenAI SDK — we spy on whether the real constructor is called.
const mockEmbeddingsCreate = vi.fn();
vi.mock("openai", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      embeddings: {
        create: mockEmbeddingsCreate,
      },
    })),
  };
});

import {
  createOpenAiEmbedder,
  isFakeEmbedderEnabled,
  createFakeEmbedder,
  classifyEmbeddingError,
} from "../services/embeddings.js";
import OpenAI from "openai";

const EMBEDDING_DIMENSIONS = 1536;

// ── env save/restore ──────────────────────────────────────────────────────────

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {
    AOA_E2E_FAKE_EMBEDDER: process.env.AOA_E2E_FAKE_EMBEDDER,
    AOA_E2E_FAKE_EMBEDDER_CONTROL: process.env.AOA_E2E_FAKE_EMBEDDER_CONTROL,
    NODE_ENV: process.env.NODE_ENV,
  };
  // Reset OpenAI mock call counts
  mockEmbeddingsCreate.mockReset();
  vi.mocked(OpenAI).mockClear();
});

afterEach(() => {
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
});

// ── isFakeEmbedderEnabled ─────────────────────────────────────────────────────

describe("isFakeEmbedderEnabled", () => {
  it("returns false when flag is not set", () => {
    expect(isFakeEmbedderEnabled({})).toBe(false);
  });

  it("returns true when AOA_E2E_FAKE_EMBEDDER=1 and NODE_ENV is not production", () => {
    expect(isFakeEmbedderEnabled({ AOA_E2E_FAKE_EMBEDDER: "1" })).toBe(true);
    expect(isFakeEmbedderEnabled({ AOA_E2E_FAKE_EMBEDDER: "1", NODE_ENV: "test" })).toBe(true);
    expect(isFakeEmbedderEnabled({ AOA_E2E_FAKE_EMBEDDER: "1", NODE_ENV: "development" })).toBe(true);
  });

  it("returns false even when flag is set but NODE_ENV is production (defense-in-depth)", () => {
    expect(
      isFakeEmbedderEnabled({ AOA_E2E_FAKE_EMBEDDER: "1", NODE_ENV: "production" }),
    ).toBe(false);
  });

  it("returns false when flag is '0' or any non-'1' value", () => {
    expect(isFakeEmbedderEnabled({ AOA_E2E_FAKE_EMBEDDER: "0" })).toBe(false);
    expect(isFakeEmbedderEnabled({ AOA_E2E_FAKE_EMBEDDER: "true" })).toBe(false);
    expect(isFakeEmbedderEnabled({ AOA_E2E_FAKE_EMBEDDER: "" })).toBe(false);
  });
});

// ── createOpenAiEmbedder — fake path ─────────────────────────────────────────

describe("createOpenAiEmbedder with fake embedder active", () => {
  beforeEach(() => {
    process.env.AOA_E2E_FAKE_EMBEDDER = "1";
    // Ensure NODE_ENV is not production so the guard fires
    if (process.env.NODE_ENV === "production") {
      process.env.NODE_ENV = "test";
    }
  });

  it("returns a 1536-length finite number[] without making any OpenAI SDK calls", async () => {
    const embedder = createOpenAiEmbedder("any-key");
    const result = await embedder.embed("hello world");

    expect(result).toHaveLength(EMBEDDING_DIMENSIONS);
    for (const v of result) {
      expect(Number.isFinite(v)).toBe(true);
    }
    // The OpenAI SDK constructor must NOT have been called
    expect(vi.mocked(OpenAI)).not.toHaveBeenCalled();
    // And the embeddings.create must NOT have been called
    expect(mockEmbeddingsCreate).not.toHaveBeenCalled();
  });

  it("returns a deterministic vector (same text → same vector)", async () => {
    const embedder = createOpenAiEmbedder("key-1");
    const v1 = await embedder.embed("deterministic text");
    const v2 = await embedder.embed("deterministic text");
    expect(v1).toEqual(v2);
  });

  it("returns different vectors for different texts", async () => {
    const embedder = createOpenAiEmbedder("key-1");
    const v1 = await embedder.embed("text A");
    const v2 = await embedder.embed("text B");
    // At least one element must differ
    expect(v1).not.toEqual(v2);
  });
});

// ── createOpenAiEmbedder — guard OFF ─────────────────────────────────────────

describe("createOpenAiEmbedder with fake embedder OFF", () => {
  it("does NOT return the fake when flag is unset (uses real OpenAI SDK path)", async () => {
    delete process.env.AOA_E2E_FAKE_EMBEDDER;

    mockEmbeddingsCreate.mockResolvedValue({
      data: [{ embedding: new Array(EMBEDDING_DIMENSIONS).fill(0.1) }],
    });

    const embedder = createOpenAiEmbedder("sk-real-key");
    const result = await embedder.embed("test");

    // The real OpenAI SDK constructor should have been called
    expect(vi.mocked(OpenAI)).toHaveBeenCalledWith({ apiKey: "sk-real-key" });
    // And embeddings.create should have been called
    expect(mockEmbeddingsCreate).toHaveBeenCalled();
    // Result is what the mock returned
    expect(result).toHaveLength(EMBEDDING_DIMENSIONS);
  });

  it("does NOT return the fake when NODE_ENV=production even if flag is set (defense-in-depth)", async () => {
    process.env.AOA_E2E_FAKE_EMBEDDER = "1";
    process.env.NODE_ENV = "production";

    mockEmbeddingsCreate.mockResolvedValue({
      data: [{ embedding: new Array(EMBEDDING_DIMENSIONS).fill(0.2) }],
    });

    const embedder = createOpenAiEmbedder("sk-prod-key");
    await embedder.embed("test");

    // Must have gone through the real OpenAI SDK path
    expect(vi.mocked(OpenAI)).toHaveBeenCalled();
    expect(mockEmbeddingsCreate).toHaveBeenCalled();
  });
});

// ── createFakeEmbedder — forced-error modes ────────────────────────────────────

describe("createFakeEmbedder forced-error modes", () => {
  let controlPath: string;

  beforeEach(() => {
    controlPath = path.join(os.tmpdir(), `aoa-test-fake-embedder-ctrl-${Date.now()}.json`);
  });

  afterEach(() => {
    try { fs.rmSync(controlPath, { force: true }); } catch { /* ok */ }
  });

  it('{ fail: "systemic" } → rejects with error classified as "systemic"', async () => {
    fs.writeFileSync(controlPath, JSON.stringify({ fail: "systemic" }));
    const embedder = createFakeEmbedder({ AOA_E2E_FAKE_EMBEDDER_CONTROL: controlPath });

    await expect(embedder.embed("text")).rejects.toSatisfy((err: unknown) => {
      return classifyEmbeddingError(err) === "systemic";
    });
  });

  it('{ fail: "transient" } → rejects with error classified as "transient"', async () => {
    fs.writeFileSync(controlPath, JSON.stringify({ fail: "transient" }));
    const embedder = createFakeEmbedder({ AOA_E2E_FAKE_EMBEDDER_CONTROL: controlPath });

    await expect(embedder.embed("text")).rejects.toSatisfy((err: unknown) => {
      return classifyEmbeddingError(err) === "transient";
    });
  });

  it('{ fail: "row_permanent" } → rejects with error classified as "row_permanent"', async () => {
    fs.writeFileSync(controlPath, JSON.stringify({ fail: "row_permanent" }));
    const embedder = createFakeEmbedder({ AOA_E2E_FAKE_EMBEDDER_CONTROL: controlPath });

    await expect(embedder.embed("text")).rejects.toSatisfy((err: unknown) => {
      return classifyEmbeddingError(err) === "row_permanent";
    });
  });

  it("no control file → succeeds with 1536-length vector", async () => {
    // No file written at controlPath
    const embedder = createFakeEmbedder({ AOA_E2E_FAKE_EMBEDDER_CONTROL: controlPath });
    const result = await embedder.embed("no control file");

    expect(result).toHaveLength(EMBEDDING_DIMENSIONS);
    for (const v of result) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("control file with no fail field → succeeds", async () => {
    fs.writeFileSync(controlPath, JSON.stringify({}));
    const embedder = createFakeEmbedder({ AOA_E2E_FAKE_EMBEDDER_CONTROL: controlPath });
    const result = await embedder.embed("no fail field");

    expect(result).toHaveLength(EMBEDDING_DIMENSIONS);
  });

  it("no env → succeeds (no control path to read)", async () => {
    const embedder = createFakeEmbedder({});
    const result = await embedder.embed("no env");

    expect(result).toHaveLength(EMBEDDING_DIMENSIONS);
    for (const v of result) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});
