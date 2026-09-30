/**
 * Task 11: Embedding resilience — pure helper unit tests.
 *
 * Tests `classifyEmbeddingError` and `computeBackoffMs` with NO DB or network
 * dependencies. These helpers are pure functions so no mocking is required.
 */

import { describe, it, expect, vi } from "vitest";

// ── Module-level mocks to break the ESM/drizzle cycle ──────────────────────
// embeddings.ts imports from @armyofagents/db and drizzle-orm at module level.
// We must mock these even though the pure helpers don't use DB at all.
//
// Use vi.hoisted() so helpers are available at vi.mock() hoist time.
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
  classifyEmbeddingError,
  computeBackoffMs,
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
} from "../services/embeddings.js";

// ── classifyEmbeddingError ───────────────────────────────────────────────────

describe("classifyEmbeddingError", () => {
  it("classifies HTTP 429 as transient", () => {
    expect(classifyEmbeddingError({ status: 429 })).toBe("transient");
  });

  it("classifies type=rate_limit_exceeded as transient", () => {
    expect(
      classifyEmbeddingError({ error: { type: "rate_limit_exceeded" } }),
    ).toBe("transient");
  });

  it("classifies HTTP 503 as transient", () => {
    expect(classifyEmbeddingError({ status: 503 })).toBe("transient");
  });

  it("classifies HTTP 500 as transient", () => {
    expect(classifyEmbeddingError({ status: 500 })).toBe("transient");
  });

  it("classifies ECONNRESET message as transient", () => {
    expect(classifyEmbeddingError(new Error("ECONNRESET connection reset"))).toBe(
      "transient",
    );
  });

  it("classifies ETIMEDOUT message as transient", () => {
    expect(classifyEmbeddingError(new Error("ETIMEDOUT"))).toBe("transient");
  });

  it("classifies fetch failed message as transient", () => {
    expect(classifyEmbeddingError(new Error("fetch failed"))).toBe("transient");
  });

  it("classifies network error message as transient", () => {
    expect(classifyEmbeddingError(new Error("network error occurred"))).toBe(
      "transient",
    );
  });

  it("classifies HTTP 401 as systemic", () => {
    expect(classifyEmbeddingError({ status: 401 })).toBe("systemic");
  });

  it("classifies HTTP 403 as systemic", () => {
    expect(classifyEmbeddingError({ status: 403 })).toBe("systemic");
  });

  it("classifies type=insufficient_quota as systemic", () => {
    expect(
      classifyEmbeddingError({ error: { type: "insufficient_quota" } }),
    ).toBe("systemic");
  });

  it("classifies code=insufficient_quota as systemic", () => {
    expect(
      classifyEmbeddingError({ error: { code: "insufficient_quota" } }),
    ).toBe("systemic");
  });

  it("classifies message containing insufficient_quota as systemic", () => {
    expect(
      classifyEmbeddingError(new Error("OpenAI API error: insufficient_quota exceeded")),
    ).toBe("systemic");
  });

  it("classifies HTTP 400 as row_permanent", () => {
    expect(classifyEmbeddingError({ status: 400 })).toBe("row_permanent");
  });

  it("classifies HTTP 422 as row_permanent", () => {
    expect(classifyEmbeddingError({ status: 422 })).toBe("row_permanent");
  });

  it("classifies unknown error as transient (safe default)", () => {
    expect(classifyEmbeddingError(new Error("some unexpected thing"))).toBe(
      "transient",
    );
  });

  it("classifies null/undefined as transient", () => {
    expect(classifyEmbeddingError(null)).toBe("transient");
    expect(classifyEmbeddingError(undefined)).toBe("transient");
  });

  it("classifies plain string error as transient", () => {
    expect(classifyEmbeddingError("something went wrong")).toBe("transient");
  });
});

// ── computeBackoffMs ─────────────────────────────────────────────────────────

describe("computeBackoffMs", () => {
  it("returns >= 1 even for a deterministic rng of 0 (P2-2 clamp)", () => {
    // P2-2: computeBackoffMs clamps to >= 1ms so a rng()===0 never produces
    // an immediately-eligible row (zero-delay retry pin-ball).
    const result = computeBackoffMs(1, () => 0);
    expect(result).toBeGreaterThanOrEqual(1);
  });

  it("returns raw-1 for a deterministic rng of just-below-1", () => {
    // rng=0.9999... → floor(0.9999 * raw) = raw - 1
    const rng = () => 0.9999;
    const attempt1 = computeBackoffMs(1, rng);
    const raw1 = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(2, 0));
    expect(attempt1).toBe(Math.floor(rng() * raw1));
  });

  it("raw value grows monotonically with attempt number (before cap)", () => {
    // Use rng=1 (not a valid rng but lets us test the raw boundary)
    // We'll use rng=0.5 to compare relative sizes.
    const rng = () => 0.5;
    const vals = [1, 2, 3, 4].map((a) => computeBackoffMs(a, rng));
    for (let i = 1; i < vals.length; i++) {
      expect(vals[i]).toBeGreaterThanOrEqual(vals[i - 1]);
    }
  });

  it("never exceeds BACKOFF_CAP_MS regardless of attempt", () => {
    const rng = () => 0.9999;
    for (const attempt of [1, 2, 3, 5, 10, 20, 50]) {
      expect(computeBackoffMs(attempt, rng)).toBeLessThanOrEqual(BACKOFF_CAP_MS);
    }
  });

  it("jitter keeps result within [1, raw] (P2-2 clamp applies at lower bound)", () => {
    for (const attempt of [1, 2, 3, 4, 5]) {
      const raw = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(2, attempt - 1));
      // P2-2: rng=0 now returns 1 (not 0), rng=0.9999 → just below raw
      expect(computeBackoffMs(attempt, () => 0)).toBeGreaterThanOrEqual(1);
      expect(computeBackoffMs(attempt, () => 0.9999)).toBeLessThan(raw);
      expect(computeBackoffMs(attempt, () => 0.9999)).toBeGreaterThanOrEqual(1);
    }
  });

  it("caps at BACKOFF_CAP_MS for very high attempt numbers", () => {
    const rng = () => 0.9999;
    // attempt=100 → BASE * 2^99 >> CAP, so raw = CAP = 300000
    const result = computeBackoffMs(100, rng);
    expect(result).toBeLessThanOrEqual(BACKOFF_CAP_MS);
    // Should be close to CAP * 0.9999
    expect(result).toBeGreaterThan(BACKOFF_CAP_MS * 0.99);
  });

  it("returns an integer (Math.floor applied)", () => {
    const rng = () => 0.3333;
    for (const attempt of [1, 2, 3]) {
      const result = computeBackoffMs(attempt, rng);
      expect(Number.isInteger(result)).toBe(true);
    }
  });

  it("base constants have expected values", () => {
    expect(BACKOFF_BASE_MS).toBe(2000);
    expect(BACKOFF_CAP_MS).toBe(300_000);
  });
});
