import { describe, it, expect, vi } from "vitest";

vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) => {
    const cols: Record<string, symbol> = {};
    return new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (prop === "_") return { name };
        if (prop === "$inferSelect" || prop === "$inferInsert") return {};
        if (typeof prop === "string") {
          if (!cols[prop]) cols[prop] = Symbol(prop);
          return cols[prop];
        }
        return undefined;
      },
    });
  };
  return {
    sidebarPreferences: makeTable("sidebar_preferences"),
  };
});

vi.mock("drizzle-orm", () => ({
  and: (..._args: unknown[]) => "and",
  eq: (..._args: unknown[]) => "eq",
}));

import { sidebarPreferencesService } from "../services/sidebar-preferences.js";

type MockRow = Record<string, unknown>;

function createSequenceDb(config: {
  selects?: MockRow[][];
  inserts?: MockRow[][];
} = {}) {
  let selectIdx = 0;
  let insertIdx = 0;
  const selects = config.selects ?? [];
  const inserts = config.inserts ?? [];

  function makeChain(getResult: () => MockRow[]) {
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "where", "values", "returning", "set", "onConflictDoUpdate"]) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    chain.then = (resolve: (v: MockRow[]) => unknown) => Promise.resolve(resolve(getResult()));
    return chain;
  }

  return {
    select: (..._args: unknown[]) => makeChain(() => selects[selectIdx++] ?? []),
    insert: (..._args: unknown[]) => makeChain(() => inserts[insertIdx++] ?? []),
  } as any;
}

describe("sidebarPreferencesService", () => {
  it("get returns empty arrays when no row exists", async () => {
    const db = createSequenceDb({ selects: [[]] });
    const svc = sidebarPreferencesService(db);
    const result = await svc.get("user-1", "00000000-0000-0000-0000-000000000001");
    expect(result).toEqual({
      departmentOrder: [],
      projectOrder: [],
      updatedAt: null,
    });
  });

  it("get returns stored order and updatedAt", async () => {
    const updatedAt = new Date("2026-04-20T00:00:00Z");
    const db = createSequenceDb({
      selects: [[
        {
          departmentOrder: ["a", "b"],
          projectOrder: ["c"],
          updatedAt,
        },
      ]],
    });
    const svc = sidebarPreferencesService(db);
    const result = await svc.get("user-1", "00000000-0000-0000-0000-000000000001");
    expect(result.departmentOrder).toEqual(["a", "b"]);
    expect(result.projectOrder).toEqual(["c"]);
    expect(result.updatedAt).toEqual(updatedAt);
  });

  it("upsert normalizes ids: trims, drops non-strings, dedupes, preserves order", async () => {
    const now = new Date();
    const db = createSequenceDb({
      inserts: [[
        {
          departmentOrder: ["x", "y"],
          projectOrder: [],
          updatedAt: now,
        },
      ]],
    });
    const svc = sidebarPreferencesService(db);
    const result = await svc.upsert("user-1", "00000000-0000-0000-0000-000000000001", {
      departmentOrder: ["x", "x", "  y  ", "", 42 as unknown as string],
    });
    expect(result.departmentOrder).toEqual(["x", "y"]);
  });

  it("upsert preserves existing order when patch omits a field", async () => {
    const now = new Date();
    // 1) read existing
    // 2) insert/upsert returning the merged row
    const db = createSequenceDb({
      selects: [[
        {
          departmentOrder: ["keep-dept"],
          projectOrder: ["keep-proj"],
          updatedAt: new Date("2020-01-01"),
        },
      ]],
      inserts: [[
        {
          departmentOrder: ["keep-dept"],
          projectOrder: ["new-proj"],
          updatedAt: now,
        },
      ]],
    });
    const svc = sidebarPreferencesService(db);
    const result = await svc.upsert("user-1", "00000000-0000-0000-0000-000000000001", {
      projectOrder: ["new-proj"],
    });
    expect(result.departmentOrder).toEqual(["keep-dept"]);
    expect(result.projectOrder).toEqual(["new-proj"]);
  });

  it("reset clears both orders", async () => {
    const now = new Date();
    const db = createSequenceDb({
      inserts: [[
        {
          departmentOrder: [],
          projectOrder: [],
          updatedAt: now,
        },
      ]],
    });
    const svc = sidebarPreferencesService(db);
    const result = await svc.reset("user-1", "00000000-0000-0000-0000-000000000001");
    expect(result.departmentOrder).toEqual([]);
    expect(result.projectOrder).toEqual([]);
  });
});
