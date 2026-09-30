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
    inboxDismissals: makeTable("inbox_dismissals"),
  };
});

vi.mock("drizzle-orm", () => ({
  and: (..._args: unknown[]) => "and",
  eq: (..._args: unknown[]) => "eq",
  desc: (..._args: unknown[]) => "desc",
}));

import { inboxDismissalService } from "../services/inbox-dismissals.js";

type MockRow = Record<string, unknown>;

function createSequenceDb(config: {
  selects?: MockRow[][];
  inserts?: MockRow[][];
  deletes?: MockRow[][];
} = {}) {
  let selectIdx = 0;
  let insertIdx = 0;
  let deleteIdx = 0;
  const selects = config.selects ?? [];
  const inserts = config.inserts ?? [];
  const deletes = config.deletes ?? [];

  function makeChain(getResult: () => MockRow[]) {
    const chain: Record<string, unknown> = {};
    for (const m of [
      "from",
      "where",
      "values",
      "returning",
      "set",
      "onConflictDoUpdate",
      "orderBy",
    ]) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    chain.then = (resolve: (v: MockRow[]) => unknown) =>
      Promise.resolve(resolve(getResult()));
    return chain;
  }

  return {
    select: (..._args: unknown[]) => makeChain(() => selects[selectIdx++] ?? []),
    insert: (..._args: unknown[]) => makeChain(() => inserts[insertIdx++] ?? []),
    delete: (..._args: unknown[]) => makeChain(() => deletes[deleteIdx++] ?? []),
  } as any;
}

const USER = "user-1";
const COMPANY = "00000000-0000-0000-0000-000000000001";

function row(overrides: Partial<MockRow> = {}): MockRow {
  return {
    id: "dismissal-1",
    userId: USER,
    companyId: COMPANY,
    itemKey: "run:abc",
    dismissedAt: new Date("2026-04-20T00:00:00Z"),
    createdAt: new Date("2026-04-20T00:00:00Z"),
    updatedAt: new Date("2026-04-20T00:00:00Z"),
    ...overrides,
  };
}

describe("inboxDismissalService", () => {
  it("list returns empty array when no rows", async () => {
    const db = createSequenceDb({ selects: [[]] });
    const svc = inboxDismissalService(db);
    const result = await svc.list(USER, COMPANY);
    expect(result).toEqual([]);
  });

  it("list returns mapped rows ordered by the service", async () => {
    const db = createSequenceDb({
      selects: [[row({ itemKey: "run:a" }), row({ itemKey: "stale:b", id: "d2" })]],
    });
    const svc = inboxDismissalService(db);
    const result = await svc.list(USER, COMPANY);
    expect(result).toHaveLength(2);
    expect(result[0]!.itemKey).toBe("run:a");
    expect(result[1]!.itemKey).toBe("stale:b");
  });

  it("dismiss upserts and returns the row", async () => {
    const db = createSequenceDb({
      inserts: [[row({ itemKey: "alert:budget" })]],
    });
    const svc = inboxDismissalService(db);
    const result = await svc.dismiss(USER, COMPANY, "alert:budget");
    expect(result.itemKey).toBe("alert:budget");
    expect(result.userId).toBe(USER);
    expect(result.companyId).toBe(COMPANY);
  });

  it("dismiss is idempotent: repeated calls return a row each time", async () => {
    const db = createSequenceDb({
      inserts: [
        [row({ itemKey: "run:x", id: "d-once" })],
        [row({ itemKey: "run:x", id: "d-once" })],
      ],
    });
    const svc = inboxDismissalService(db);
    const first = await svc.dismiss(USER, COMPANY, "run:x");
    const second = await svc.dismiss(USER, COMPANY, "run:x");
    expect(first.id).toBe("d-once");
    expect(second.id).toBe("d-once");
  });

  it("undismiss resolves without returning a row", async () => {
    const db = createSequenceDb({ deletes: [[]] });
    const svc = inboxDismissalService(db);
    await expect(svc.undismiss(USER, COMPANY, "run:gone")).resolves.toBeUndefined();
  });
});
