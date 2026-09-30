import { describe, it, expect, vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  sql: Object.assign(
    vi.fn(() => ({})),
    { raw: vi.fn((s: unknown) => s) },
  ),
}));

vi.mock("@armyofagents/db", () => {
  const makeColumn = (name: string) => ({ __column: name });
  return {
    memoryItems: new Proxy(
      {},
      {
        get(_t, prop) {
          if (typeof prop === "string") return makeColumn(prop);
          return undefined;
        },
      },
    ),
  };
});

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
  },
}));

import { memoryItemsSelection } from "../services/memory-projection.js";
import { setDbCapabilities } from "../services/db-capabilities.js";

describe("memoryItemsSelection", () => {
  it("omits embedding when pgvector is unavailable", () => {
    const projection = memoryItemsSelection(false);
    expect("embedding" in projection).toBe(false);
    expect("embeddingRetries" in projection).toBe(true);
    expect("id" in projection).toBe(true);
    expect("title" in projection).toBe(true);
    expect("content" in projection).toBe(true);
  });

  it("includes embedding when pgvector is available", () => {
    const projection = memoryItemsSelection(true);
    expect("embedding" in projection).toBe(true);
    expect("embeddingRetries" in projection).toBe(true);
    expect("id" in projection).toBe(true);
  });

  it("reads hasVectorSupport from db-capabilities singleton when no arg given", () => {
    setDbCapabilities({ hasVectorSupport: false });
    const withoutVector = memoryItemsSelection();
    expect("embedding" in withoutVector).toBe(false);

    setDbCapabilities({ hasVectorSupport: true });
    const withVector = memoryItemsSelection();
    expect("embedding" in withVector).toBe(true);

    // Reset so other tests aren't affected.
    setDbCapabilities({ hasVectorSupport: false });
  });

  it("exports the same base set of non-embedding columns in both modes", () => {
    const withoutVector = memoryItemsSelection(false);
    const withVector = memoryItemsSelection(true);
    for (const key of Object.keys(withoutVector)) {
      expect(key in withVector).toBe(true);
    }
    // The only difference should be embedding.
    const extras = Object.keys(withVector).filter((k) => !(k in withoutVector));
    expect(extras).toEqual(["embedding"]);
  });
});
