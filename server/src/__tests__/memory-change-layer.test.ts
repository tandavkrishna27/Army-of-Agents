import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@armyofagents/db", () => ({
  memoryItems: new Proxy({}, { get: (_t, p) => ({ name: String(p) }) }),
  memoryItemVersions: new Proxy({}, { get: (_t, p) => ({ name: String(p) }) }),
  agents: new Proxy({}, { get: (_t, p) => ({ name: String(p) }) }),
  memoryRetrievals: new Proxy({}, { get: (_t, p) => ({ name: String(p) }) }),
  suggestions: new Proxy({}, { get: (_t, p) => ({ name: String(p) }) }),
}));
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ op: "and", args }),
  eq: (a: unknown, b: unknown) => ({ op: "eq", a, b }),
  desc: (col: unknown) => ({ op: "desc", col }),
  isNull: (a: unknown) => ({ op: "isNull", a }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...vals: unknown[]) => ({ kind: "sql", strings, vals }),
    { raw: (s: string) => ({ kind: "sql_raw", s }) },
  ),
}));
vi.mock("../infra/live-events", () => ({ publishLiveEvent: vi.fn() }));
vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));
vi.mock("../services/embeddings.js", () => ({ generateEmbedding: vi.fn() }));
vi.mock("../services/memory-projection.js", () => ({
  buildMemoryInsert: vi.fn(),
  memoryItemsSelection: () => ({ id: "id" }),
  MEMORY_COLUMN_MAP: {},
}));
vi.mock("../services/db-capabilities.js", () => ({
  getDbCapabilities: () => ({ hasVectorSupport: false }),
}));

import { memoryService } from "../services/memory.js";

type ItemRow = {
  id: string;
  companyId: string;
  layer: string | null;
  goalId: string | null;
  taskId: string | null;
  expiresAt: Date | null;
  folderPath: string;
  departmentId: string | null;
  title: string;
  content: string;
};

function createMockDb(items: ItemRow[] = []) {
  const versionsCreated: Array<Record<string, unknown>> = [];
  const updateCalls: Array<{ patch: Record<string, unknown>; id: string }> = [];
  // A-M6: captures the FOR UPDATE parent-row lock executes inside changeLayer's tx.
  const lockExecutes: unknown[] = [];

  const dbLike: Record<string, unknown> = {
    items,
    versionsCreated,
    updateCalls,
    select: (_projection?: unknown) => ({
      from: () => ({
        where: () => ({
          then: (resolve: (v: ItemRow[]) => void) => resolve(items),
          orderBy: () => ({
            limit: () => ({
              then: (resolve: (v: Array<{ versionNumber: number }>) => void) => resolve([]),
            }),
          }),
        }),
      }),
    }),
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        versionsCreated.push(row);
        return {
          returning: async () => [{ ...row, id: `v-${versionsCreated.length}` }],
        };
      },
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            if (items.length === 0) return [];
            items[0] = { ...items[0], ...patch } as ItemRow;
            updateCalls.push({ patch, id: items[0].id });
            return [items[0]];
          },
        }),
      }),
    }),
  };
  // A-M6: changeLayer now takes a FOR UPDATE parent-row lock as the first
  // statement inside its transaction via tx.execute(sql`… for update`). The
  // mock records the lock call and returns [] (the lock result is not read).
  dbLike.lockExecutes = lockExecutes;
  dbLike.execute = (...args: unknown[]) => {
    lockExecutes.push(args[0]);
    return Promise.resolve([]);
  };
  // Phase 6.2c follow-up: changeLayer now wraps the update + audit-row insert
  // in a db.transaction(...) call. The mock's transaction passes itself as the
  // `tx` so the chained methods inside the callback hit the same fake stores.
  dbLike.transaction = async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(dbLike);
  return dbLike as never;
}

describe("memoryService.changeLayer — Phase 6.2c", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects an invalid layer", async () => {
    const item: ItemRow = {
      id: "i-1",
      companyId: "co-1",
      layer: "domain",
      goalId: null,
      taskId: null,
      expiresAt: null,
      folderPath: "engineering/Decisions",
      departmentId: "d-eng",
      title: "Test",
      content: "Test content",
    };
    const db = createMockDb([item]);
    const svc = memoryService(db as never);
    await expect(
      svc.changeLayer("i-1", "co-1", { newLayer: "invalid" as never }),
    ).rejects.toThrow(/invalid layer/i);
  });

  it("identity → domain: sets departmentId from input, clears folderPath", async () => {
    const item: ItemRow = {
      id: "i-1",
      companyId: "co-1",
      layer: "identity",
      goalId: null,
      taskId: null,
      expiresAt: null,
      folderPath: "Company",
      departmentId: null,
      title: "Vision",
      content: "Content",
    };
    const db = createMockDb([item]);
    const svc = memoryService(db as never);
    await svc.changeLayer("i-1", "co-1", {
      newLayer: "domain",
      departmentId: "d-eng",
    });
    const lastCall = db.updateCalls[0];
    expect(lastCall.patch.layer).toBe("domain");
    expect(lastCall.patch.departmentId).toBe("d-eng");
    expect(lastCall.patch.folderPath).toBe("");
  });

  it("any → active_context: requires goalId, sets goalId + expiresAt", async () => {
    const item: ItemRow = {
      id: "i-1",
      companyId: "co-1",
      layer: "domain",
      goalId: null,
      taskId: null,
      expiresAt: null,
      folderPath: "engineering/Decisions",
      departmentId: "d-eng",
      title: "T",
      content: "C",
    };
    const db = createMockDb([item]);
    const svc = memoryService(db as never);
    // Without goalId → reject
    await expect(
      svc.changeLayer("i-1", "co-1", { newLayer: "active_context" }),
    ).rejects.toThrow(/goalId required/i);
    // With goalId → succeed
    const dbOk = createMockDb([{ ...item }]);
    const svcOk = memoryService(dbOk as never);
    const expiry = new Date("2026-06-01T00:00:00Z");
    await svcOk.changeLayer("i-1", "co-1", {
      newLayer: "active_context",
      goalId: "g-1",
      expiresAt: expiry,
    });
    const patch = dbOk.updateCalls[0].patch;
    expect(patch.layer).toBe("active_context");
    expect(patch.goalId).toBe("g-1");
    expect(patch.expiresAt).toBe(expiry);
  });

  it("any → working: requires taskId, sets taskId", async () => {
    const item: ItemRow = {
      id: "i-1",
      companyId: "co-1",
      layer: "domain",
      goalId: null,
      taskId: null,
      expiresAt: null,
      folderPath: "engineering/Decisions",
      departmentId: "d-eng",
      title: "T",
      content: "C",
    };
    const db = createMockDb([item]);
    const svc = memoryService(db as never);
    await expect(
      svc.changeLayer("i-1", "co-1", { newLayer: "working" }),
    ).rejects.toThrow(/taskId required/i);
    const dbOk = createMockDb([{ ...item }]);
    const svcOk = memoryService(dbOk as never);
    await svcOk.changeLayer("i-1", "co-1", {
      newLayer: "working",
      taskId: "t-1",
    });
    const patch = dbOk.updateCalls[0].patch;
    expect(patch.layer).toBe("working");
    expect(patch.taskId).toBe("t-1");
  });

  it("working → domain: clears taskId", async () => {
    const item: ItemRow = {
      id: "i-1",
      companyId: "co-1",
      layer: "working",
      goalId: null,
      taskId: "t-1",
      expiresAt: null,
      folderPath: "",
      departmentId: "d-eng",
      title: "T",
      content: "C",
    };
    const db = createMockDb([item]);
    const svc = memoryService(db as never);
    await svc.changeLayer("i-1", "co-1", {
      newLayer: "domain",
      departmentId: "d-eng",
    });
    const patch = db.updateCalls[0].patch;
    expect(patch.layer).toBe("domain");
    expect(patch.taskId).toBe(null);
  });

  it("active_context → domain: clears goalId + expiresAt", async () => {
    const item: ItemRow = {
      id: "i-1",
      companyId: "co-1",
      layer: "active_context",
      goalId: "g-1",
      taskId: null,
      expiresAt: new Date("2026-05-15T00:00:00Z"),
      folderPath: "",
      departmentId: "d-eng",
      title: "T",
      content: "C",
    };
    const db = createMockDb([item]);
    const svc = memoryService(db as never);
    await svc.changeLayer("i-1", "co-1", {
      newLayer: "domain",
      departmentId: "d-eng",
    });
    const patch = db.updateCalls[0].patch;
    expect(patch.goalId).toBe(null);
    expect(patch.expiresAt).toBe(null);
  });

  it("writes a memory_item_versions row with the layer-change changelog", async () => {
    const item: ItemRow = {
      id: "i-1",
      companyId: "co-1",
      layer: "domain",
      goalId: null,
      taskId: null,
      expiresAt: null,
      folderPath: "engineering/Decisions",
      departmentId: "d-eng",
      title: "T",
      content: "C",
    };
    const db = createMockDb([item]);
    const svc = memoryService(db as never);
    await svc.changeLayer("i-1", "co-1", {
      newLayer: "identity",
    });
    expect(db.versionsCreated.length).toBeGreaterThan(0);
    const version = db.versionsCreated[0];
    expect(String(version.content)).toMatch(/layer changed: domain → identity/i);
  });

  it("returns null when item not found", async () => {
    const db = createMockDb([]);
    const svc = memoryService(db as never);
    const result = await svc.changeLayer("i-missing", "co-1", {
      newLayer: "domain",
      departmentId: "d-eng",
    });
    expect(result).toBeNull();
  });

  it("A-M6: wraps allocation in a tx and takes a FOR UPDATE parent-row lock before inserting", async () => {
    const item: ItemRow = {
      id: "i-1",
      companyId: "co-1",
      layer: "domain",
      goalId: null,
      taskId: null,
      expiresAt: null,
      folderPath: "engineering/Decisions",
      departmentId: "d-eng",
      title: "T",
      content: "C",
    };
    const db = createMockDb([item]);
    const svc = memoryService(db as never);
    await svc.changeLayer("i-1", "co-1", { newLayer: "identity" });
    // The parent-row lock fired (exactly once) before the version row was written.
    expect(db.lockExecutes.length).toBe(1);
    expect(db.versionsCreated.length).toBeGreaterThan(0);
  });
});
