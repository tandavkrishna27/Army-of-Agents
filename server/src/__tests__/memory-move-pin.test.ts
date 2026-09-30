import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@armyofagents/db", () => ({
  memoryItems: new Proxy({}, { get: (_t, p) => ({ name: String(p) }) }),
  memoryItemVersions: new Proxy({}, { get: (_t, p) => ({ name: String(p) }) }),
  memoryRetrievals: new Proxy({}, { get: (_t, p) => ({ name: String(p) }) }),
  agents: new Proxy({}, { get: (_t, p) => ({ name: String(p) }) }),
  suggestions: new Proxy({}, { get: (_t, p) => ({ name: String(p) }) }),
}));
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ op: "and", args }),
  eq: (a: unknown, b: unknown) => ({ op: "eq", a, b }),
  or: (...args: unknown[]) => ({ op: "or", args }),
  ilike: (a: unknown, b: unknown) => ({ op: "ilike", a, b }),
  desc: (a: unknown) => ({ op: "desc", a }),
  sql: new Proxy(
    Object.assign(function () { return {}; }, { join: () => ({}), raw: () => ({}) }),
    { get: (t: Record<string, unknown>, p: string) => p in t ? t[p] : () => ({}) },
  ),
}));
vi.mock("../services/db-capabilities.js", () => ({
  getDbCapabilities: () => ({ hasVectorSupport: false }),
}));
vi.mock("../services/embeddings.js", () => ({
  generateEmbedding: vi.fn(),
}));
vi.mock("../adapters/api-common.js", () => ({
  resolveApiKey: vi.fn(async () => { throw new Error("No API key"); }),
}));
vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));
vi.mock("../errors.js", () => ({
  badRequest: (msg: string) => new Error(msg),
  conflict: (msg: string) => new Error(msg),
  notFound: (msg: string) => new Error(msg),
}));
vi.mock("./memory-projection.js", () => ({
  buildMemoryInsert: vi.fn(),
  memoryItemsSelection: () => ({}),
}));
vi.mock("../services/memory-projection.js", () => ({
  buildMemoryInsert: vi.fn(),
  memoryItemsSelection: () => ({}),
}));

import { memoryService } from "../services/memory.js";

function createMockDb() {
  const items: Array<Record<string, unknown>> = [];
  return {
    items,
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            if (items.length === 0) return [];
            items[0] = { ...items[0], ...patch };
            return [items[0]];
          },
        }),
      }),
    }),
  };
}

describe("memoryService.moveItem / setPinnedToTop", () => {
  beforeEach(() => vi.clearAllMocks());

  it("moveItem updates folderPath with normalization", async () => {
    const db = createMockDb();
    db.items.push({ id: "i-1", companyId: "co-1", folderPath: "" });
    const svc = memoryService(db as never);
    const updated = await svc.moveItem("i-1", "co-1", " Engineering / Decisions ");
    expect(updated?.folderPath).toBe("Engineering/Decisions");
  });

  it("setPinnedToTop toggles founderPinnedToTop", async () => {
    const db = createMockDb();
    db.items.push({ id: "i-1", companyId: "co-1", founderPinnedToTop: false });
    const svc = memoryService(db as never);
    const updated = await svc.setPinnedToTop("i-1", "co-1", true);
    expect(updated?.founderPinnedToTop).toBe(true);
  });

  it("setPinnedToTop returns null if item not found in this company", async () => {
    const db = createMockDb();
    const svc = memoryService(db as never);
    const updated = await svc.setPinnedToTop("missing", "co-1", true);
    expect(updated).toBeNull();
  });
});
