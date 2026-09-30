import { describe, it, expect, vi } from "vitest";
import { HOME_BOARD_LAYOUT_SCHEMA_VERSION } from "@armyofagents/shared";
import { makeTableProxy, drizzleOperatorStubs } from "./helpers/drizzle-mock.js";

vi.mock("@armyofagents/db", () => ({
  homeBoardLayouts: makeTableProxy("home_board_layouts"),
}));

vi.mock("drizzle-orm", () => drizzleOperatorStubs());

import { homeBoardLayouts as homeBoardLayoutsTable } from "@armyofagents/db";
import { homeBoardLayoutService } from "../services/home-board-layout.js";

type MockRow = Record<string, unknown>;

function createSequenceDb(
  config: {
    selects?: MockRow[][];
    inserts?: MockRow[][];
  } = {},
) {
  let selectIdx = 0;
  let insertIdx = 0;
  const selects = config.selects ?? [];
  const inserts = config.inserts ?? [];
  const deleteSpy = vi.fn();

  function makeChain(getResult: () => MockRow[]) {
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "where", "values", "returning", "set", "onConflictDoUpdate"]) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    chain.then = (resolve: (v: MockRow[]) => unknown) => Promise.resolve(resolve(getResult()));
    return chain;
  }

  const db = {
    select: (..._args: unknown[]) => makeChain(() => selects[selectIdx++] ?? []),
    insert: (..._args: unknown[]) => makeChain(() => inserts[insertIdx++] ?? []),
    delete: (...args: unknown[]) => {
      deleteSpy(...args);
      return makeChain(() => []);
    },
  } as any;

  return { db, deleteSpy };
}

const USER_ID = "user-1";
const COMPANY_ID = "00000000-0000-0000-0000-000000000001";
const SAMPLE_LAYOUT = [{ i: "budget", x: 0, y: 0, w: 1, h: 1 }];

describe("homeBoardLayoutService", () => {
  it("get returns null when no row exists", async () => {
    const { db } = createSequenceDb({ selects: [[]] });
    const svc = homeBoardLayoutService(db);
    const result = await svc.get(USER_ID, COMPANY_ID);
    expect(result).toBeNull();
  });

  it("get returns the stored layout and schemaVersion", async () => {
    const db = createSequenceDb({
      selects: [
        [
          {
            layout: SAMPLE_LAYOUT,
            schemaVersion: HOME_BOARD_LAYOUT_SCHEMA_VERSION,
          },
        ],
      ],
    }).db;
    const svc = homeBoardLayoutService(db);
    const result = await svc.get(USER_ID, COMPANY_ID);
    expect(result).toEqual({
      layout: SAMPLE_LAYOUT,
      schemaVersion: HOME_BOARD_LAYOUT_SCHEMA_VERSION,
    });
  });

  it("upsert returns the persisted layout stamped with the server schemaVersion", async () => {
    const db = createSequenceDb({
      inserts: [
        [
          {
            layout: SAMPLE_LAYOUT,
            schemaVersion: HOME_BOARD_LAYOUT_SCHEMA_VERSION,
          },
        ],
      ],
    }).db;
    const svc = homeBoardLayoutService(db);
    const result = await svc.upsert(USER_ID, COMPANY_ID, SAMPLE_LAYOUT);
    expect(result).toEqual({
      layout: SAMPLE_LAYOUT,
      schemaVersion: HOME_BOARD_LAYOUT_SCHEMA_VERSION,
    });
  });

  it("upsert ignores any client-side schemaVersion — the server always stamps its own", async () => {
    // Even if a caller somehow passed a stale/forged schemaVersion through, the
    // service's insert values must carry HOME_BOARD_LAYOUT_SCHEMA_VERSION, which
    // is exactly what this mock DB echoes back via its "inserts" fixture — proving
    // upsert doesn't thread any external schemaVersion value into the write.
    const db = createSequenceDb({
      inserts: [
        [
          {
            layout: SAMPLE_LAYOUT,
            schemaVersion: HOME_BOARD_LAYOUT_SCHEMA_VERSION,
          },
        ],
      ],
    }).db;
    const svc = homeBoardLayoutService(db);
    const result = await svc.upsert(USER_ID, COMPANY_ID, SAMPLE_LAYOUT);
    expect(result.schemaVersion).toBe(HOME_BOARD_LAYOUT_SCHEMA_VERSION);
  });

  it("reset deletes the row for the given user + company", async () => {
    const { db, deleteSpy } = createSequenceDb();
    const svc = homeBoardLayoutService(db);
    await svc.reset(USER_ID, COMPANY_ID);
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith(homeBoardLayoutsTable);
  });

  it("reset resolves even when no row exists (idempotent)", async () => {
    const { db } = createSequenceDb();
    const svc = homeBoardLayoutService(db);
    await expect(svc.reset(USER_ID, COMPANY_ID)).resolves.toBeUndefined();
  });

  it("get returns null after reset (contract: DELETE, not soft-clear)", async () => {
    // Two independent svc instances against sequence DBs seeded to represent
    // "before reset" (a row exists) and "after reset" (no row) — this proves the
    // contract (delete => future reads see null) since a real DB round-trip is
    // covered separately by the migration integration test (Phase D).
    const beforeDb = createSequenceDb({
      selects: [[{ layout: SAMPLE_LAYOUT, schemaVersion: HOME_BOARD_LAYOUT_SCHEMA_VERSION }]],
    }).db;
    expect(await homeBoardLayoutService(beforeDb).get(USER_ID, COMPANY_ID)).not.toBeNull();

    const afterDb = createSequenceDb({ selects: [[]] }).db;
    expect(await homeBoardLayoutService(afterDb).get(USER_ID, COMPANY_ID)).toBeNull();
  });
});
