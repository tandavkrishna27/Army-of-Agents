import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTableProxy, mockDbCapabilities } from "./helpers/drizzle-mock.js";

const { eqCalls } = vi.hoisted(() => ({
  eqCalls: [] as Array<[unknown, unknown]>,
}));

vi.mock("@armyofagents/db", () => ({
  memoryItems: makeTableProxy("memory_items"),
  memoryItemVersions: makeTableProxy("memory_item_versions"),
  memoryRetrievals: makeTableProxy("memory_retrievals"),
  agents: makeTableProxy("agents"),
  suggestions: makeTableProxy("suggestions"),
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  or: vi.fn((...args: unknown[]) => ({ or: args })),
  eq: vi.fn((a: unknown, b: unknown) => {
    eqCalls.push([a, b]);
    return { eq: [a, b] };
  }),
  isNull: vi.fn((arg: unknown) => ({ isNull: arg })),
  gt: vi.fn((...args: unknown[]) => ({ gt: args })),
  ilike: vi.fn((...args: unknown[]) => ({ ilike: args })),
  desc: vi.fn((arg: unknown) => ({ desc: arg })),
  sql: vi.fn(() => ({ as: vi.fn(() => "sql") })),
}));

vi.mock("../services/db-capabilities.js", () => mockDbCapabilities({ hasVectorSupport: false }));

vi.mock("../services/embeddings.js", () => ({
  generateEmbedding: vi.fn(),
}));

vi.mock("../adapters/api-common.js", () => ({
  resolveApiKey: vi.fn(),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import { memoryService } from "../services/memory.js";

function makeDb() {
  const chain: Record<string, unknown> = {};
  for (const method of ["from", "where", "orderBy", "limit"]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = vi.fn((resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve([])));
  return {
    select: vi.fn(() => chain),
  };
}

describe("memoryService.searchMultiPath goal filter", () => {
  beforeEach(() => {
    eqCalls.length = 0;
    vi.clearAllMocks();
  });

  it("adds goalId to the shared multi-path search conditions", async () => {
    const db = makeDb();

    await memoryService(db as any).searchMultiPath("co-1", "", {
      goalId: "goal-1",
      enableSemantic: false,
      enableKeyword: false,
      enableTemporal: true,
    });

    expect(eqCalls).toContainEqual([expect.anything(), "goal-1"]);
  });
});
