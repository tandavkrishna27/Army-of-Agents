/**
 * Unit tests for `setFirstRunProgress` (WS0b). `../services/onboarding.js`
 * imports the real `onboardingProgress` table + drizzle-orm operators at
 * module scope; loading those together triggers an ESM require-cycle crash
 * in this environment's Node version (reproduced even on the pre-existing,
 * untouched `onboarding-advance.test.ts` — see
 * server/src/__tests__/helpers/drizzle-mock.ts). Mock both at module level,
 * matching the repo's established Service-tests-with-mocks pattern.
 */
import { describe, it, expect, vi } from "vitest";
import { makeTableProxy, drizzleOperatorStubs } from "./helpers/drizzle-mock.js";

vi.mock("@armyofagents/db", () => ({
  onboardingProgress: makeTableProxy("onboarding_progress"),
}));

vi.mock("drizzle-orm", () => drizzleOperatorStubs());

const { setFirstRunProgress } = await import("../services/onboarding.js");
type ProgressRow = Awaited<ReturnType<typeof setFirstRunProgress>> extends { row: infer R } ? R : never;

// Stateful fake db modelling a single progress row + optimistic version.
// Mirrors the fakeDb helper in onboarding-advance.test.ts.
function fakeDb(opts: { start?: Partial<ProgressRow> | null; alwaysConflict?: boolean } = {}) {
  let row: any =
    opts.start === null
      ? null
      : {
          id: "r1",
          userId: "u1",
          companyId: "c1",
          journey: "founder",
          currentState: "SETUP_COMPLETE",
          completedStates: ["AUTHENTICATED", "SETUP_COMPLETE"],
          version: 0,
          firstRunCompletedAt: null,
          firstRunPersona: null,
          ...opts.start,
        };
  let bumpOnce = false;
  const db: any = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => (row ? [{ ...row }] : []) }) }) }),
    update: () => ({
      set: (patch: any) => ({
        where: () => ({
          returning: async () => {
            if (opts.alwaysConflict) return [];
            if (bumpOnce) {
              bumpOnce = false;
              row = { ...row, version: row.version + 1 }; // concurrent writer won
              return [];
            }
            if (row.version !== patch.version - 1) return [];
            row = { ...row, ...patch };
            return [{ ...row }];
          },
        }),
      }),
    }),
    _row: () => row,
    _triggerConflictOnce: () => {
      bumpOnce = true;
    },
  };
  return db;
}

describe("setFirstRunProgress (WS0b)", () => {
  it("sets firstRunPersona without touching firstRunCompletedAt", async () => {
    const db = fakeDb();
    const r = await setFirstRunProgress(db, { userId: "u1", companyId: "c1", persona: "in_flight" });
    expect(r.status).toBe("ok");
    expect(db._row().firstRunPersona).toBe("in_flight");
    expect(db._row().firstRunCompletedAt).toBeNull();
  });

  it("sets firstRunCompletedAt to now() when completed:true", async () => {
    const db = fakeDb();
    const before = Date.now();
    const r = await setFirstRunProgress(db, { userId: "u1", companyId: "c1", completed: true });
    expect(r.status).toBe("ok");
    const stamped = db._row().firstRunCompletedAt as Date;
    expect(stamped).toBeInstanceOf(Date);
    expect(stamped.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("is idempotent — a second completed:true write does not clobber the existing timestamp", async () => {
    const already = new Date("2020-01-01T00:00:00Z");
    const db = fakeDb({ start: { firstRunCompletedAt: already, version: 3 } });
    const r = await setFirstRunProgress(db, { userId: "u1", companyId: "c1", completed: true });
    expect(r.status).toBe("ok");
    expect(db._row().firstRunCompletedAt).toEqual(already);
  });

  it("can set persona and completion together in one call", async () => {
    const db = fakeDb();
    const r = await setFirstRunProgress(db, { userId: "u1", companyId: "c1", persona: "explorer", completed: true });
    expect(r.status).toBe("ok");
    expect(db._row().firstRunPersona).toBe("explorer");
    expect(db._row().firstRunCompletedAt).toBeInstanceOf(Date);
  });

  it("returns not_found when no row exists for this (userId, companyId)", async () => {
    const db = fakeDb({ start: null });
    const r = await setFirstRunProgress(db, { userId: "u1", companyId: "c1", completed: true });
    expect(r).toEqual({ status: "not_found" });
  });

  it("rejects an invalid persona value before touching the db", async () => {
    const db = fakeDb();
    await expect(
      setFirstRunProgress(db, { userId: "u1", companyId: "c1", persona: "bogus" as any }),
    ).rejects.toThrow(/invalid firstRunPersona/);
    // untouched
    expect(db._row().firstRunPersona).toBeNull();
  });

  it("is a true no-op — a redundant completed:true on an already-complete row does NOT bump version", async () => {
    const already = new Date("2020-01-01T00:00:00Z");
    const db = fakeDb({
      start: { firstRunCompletedAt: already, firstRunPersona: "explorer", version: 3 },
    });
    const r = await setFirstRunProgress(db, { userId: "u1", companyId: "c1", completed: true });
    expect(r.status).toBe("ok");
    expect(db._row().version).toBe(3);
    expect(db._row().firstRunCompletedAt).toEqual(already);
    if (r.status === "ok") expect(r.row.version).toBe(3);
  });

  it("no-op short-circuit does not touch updatedAt either", async () => {
    const already = new Date("2020-01-01T00:00:00Z");
    const staleUpdatedAt = new Date("2019-01-01T00:00:00Z");
    const db = fakeDb({
      start: { firstRunCompletedAt: already, firstRunPersona: null, version: 1, updatedAt: staleUpdatedAt },
    });
    await setFirstRunProgress(db, { userId: "u1", companyId: "c1", completed: true });
    expect(db._row().updatedAt).toEqual(staleUpdatedAt);
  });

  it("still writes when completed:true also carries a genuine persona change on an already-complete row", async () => {
    const already = new Date("2020-01-01T00:00:00Z");
    const db = fakeDb({
      start: { firstRunCompletedAt: already, firstRunPersona: "explorer", version: 3 },
    });
    const r = await setFirstRunProgress(db, {
      userId: "u1",
      companyId: "c1",
      completed: true,
      persona: "in_flight",
    });
    expect(r.status).toBe("ok");
    expect(db._row().version).toBe(4);
    expect(db._row().firstRunPersona).toBe("in_flight");
  });

  it("retries after one optimistic conflict, then succeeds", async () => {
    const db = fakeDb();
    db._triggerConflictOnce();
    const r = await setFirstRunProgress(db, { userId: "u1", companyId: "c1", completed: true });
    expect(r.status).toBe("ok");
    expect(db._row().firstRunCompletedAt).toBeInstanceOf(Date);
  });

  it("returns conflict after exhausting retries", async () => {
    const db = fakeDb({ alwaysConflict: true });
    const r = await setFirstRunProgress(db, { userId: "u1", companyId: "c1", completed: true });
    expect(r.status).toBe("conflict");
  });
});
