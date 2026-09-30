import { describe, expect, it, vi } from "vitest";
import { makeTableProxy, drizzleOperatorStubs } from "./helpers/drizzle-mock.js";

vi.mock("@armyofagents/db", () => ({
  memorySettings: makeTableProxy("memory_settings"),
  projects: makeTableProxy("projects"),
}));
vi.mock("drizzle-orm", () => drizzleOperatorStubs());

import { pickAutonomyLevel, memorySettingsService } from "../services/memory-settings.js";

const rows = [
  { departmentId: null, autonomyLevel: "trusted" },
  { departmentId: "deptA", autonomyLevel: "manual" },
];

describe("pickAutonomyLevel", () => {
  it("a department override wins over the company default", () => {
    expect(pickAutonomyLevel(rows, "deptA")).toBe("manual");
  });
  it("falls back to the company default when no dept override exists", () => {
    expect(pickAutonomyLevel(rows, "deptB")).toBe("trusted");
  });
  it("falls back to the company default when no department is given", () => {
    expect(pickAutonomyLevel(rows, null)).toBe("trusted");
  });
  it("falls back to 'supervised' when nothing is set", () => {
    expect(pickAutonomyLevel([], null)).toBe("supervised");
  });
  it("coerces an invalid stored value to 'supervised'", () => {
    expect(pickAutonomyLevel([{ departmentId: null, autonomyLevel: "bogus" }], null)).toBe(
      "supervised",
    );
  });
});

/**
 * Chainable, thenable mock query. Every builder method returns the same chain;
 * awaiting/`.then`-ing it resolves to `result`. `capture` records method args so
 * we can assert what insert/update/delete received.
 */
function makeChain(result: unknown, capture?: (method: string, args: unknown[]) => void) {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "where", "set", "values", "onConflictDoUpdate", "returning", "orderBy", "limit"]) {
    chain[m] = (...args: unknown[]) => {
      capture?.(m, args);
      return chain;
    };
  }
  (chain as { then: (r: (v: unknown) => unknown) => Promise<unknown> }).then = (resolve) =>
    Promise.resolve(resolve(result));
  return chain;
}

type Captured = {
  insertValues?: Record<string, unknown>;
  updateSet?: Record<string, unknown>;
  deleteCalled?: boolean;
  conflictArgs?: Record<string, unknown>;
  ops: string[];
};

function makeDb(selectResult: unknown[], writeResult: unknown[], captured: Captured) {
  return {
    select: () => {
      captured.ops.push("select");
      return makeChain(selectResult);
    },
    update: () => {
      captured.ops.push("update");
      return makeChain(writeResult, (m, args) => {
        if (m === "set") captured.updateSet = args[0] as Record<string, unknown>;
      });
    },
    insert: () => {
      captured.ops.push("insert");
      return makeChain(writeResult, (m, args) => {
        if (m === "values") captured.insertValues = args[0] as Record<string, unknown>;
        if (m === "onConflictDoUpdate") captured.conflictArgs = args[0] as Record<string, unknown>;
      });
    },
    delete: () => {
      captured.ops.push("delete");
      captured.deleteCalled = true;
      return makeChain(writeResult);
    },
  } as unknown as Parameters<typeof memorySettingsService>[0];
}

describe("memorySettingsService.upsert", () => {
  it("atomically upserts the company-default row through its partial unique index", async () => {
    const captured: Captured = { ops: [] };
    const existing = { id: "row-1", companyId: "co-1", departmentId: null };
    const db = makeDb([], [{ ...existing, autonomyLevel: "trusted" }], captured);
    const out = await memorySettingsService(db).upsert("co-1", null, { autonomyLevel: "trusted" });
    expect(captured.ops).toContain("insert");
    expect(captured.ops).not.toContain("select");
    expect(captured.conflictArgs).toMatchObject({
      set: expect.objectContaining({ autonomyLevel: "trusted", updatedAt: expect.any(Date) }),
    });
    expect(captured.conflictArgs?.targetWhere).toBeDefined();
    expect(out).toMatchObject({ id: "row-1", autonomyLevel: "trusted" });
  });

  it("inserts a company-default row (departmentId null) when none exists", async () => {
    const captured: Captured = { ops: [] };
    const db = makeDb([], [{ id: "new-1" }], captured);
    await memorySettingsService(db).upsert("co-1", null, { activeContextTier: "protected" });
    expect(captured.ops).toContain("insert");
    expect(captured.conflictArgs).toBeDefined();
    expect(captured.insertValues).toMatchObject({
      companyId: "co-1",
      departmentId: null,
      activeContextTier: "protected",
    });
  });

  it("inserts a department override carrying the departmentId", async () => {
    const captured: Captured = { ops: [] };
    const db = makeDb([], [{ id: "new-2" }], captured);
    await memorySettingsService(db).upsert("co-1", "deptA", { autonomyLevel: "manual" });
    expect(captured.insertValues).toMatchObject({
      companyId: "co-1",
      departmentId: "deptA",
      autonomyLevel: "manual",
    });
    expect(captured.conflictArgs).toMatchObject({
      target: expect.any(Array),
      set: expect.objectContaining({ autonomyLevel: "manual", updatedAt: expect.any(Date) }),
    });
  });
});

describe("memorySettingsService.deleteOverride", () => {
  it("issues a delete for the department override row", async () => {
    const captured: Captured = { ops: [] };
    const db = makeDb([], [], captured);
    await memorySettingsService(db).deleteOverride("co-1", "deptA");
    expect(captured.deleteCalled).toBe(true);
  });
});
