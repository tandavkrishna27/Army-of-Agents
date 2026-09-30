import { describe, it, expect, vi } from "vitest";

// Proxy-mock DB — follows the project pattern for drizzle-orm ESM tests.
// The function under test calls db.update(issues).set({ originKind, updatedAt }).where(...)
// and awaits the full chain. We capture what was passed at each step.
function makeBackfillDb(rowCount = 3) {
  const whereProxy = {
    then: vi.fn((resolve: (value: { rowCount: number }) => void) => {
      resolve({ rowCount });
      return Promise.resolve({ rowCount });
    }),
  };
  const setProxy = { where: vi.fn().mockReturnValue(whereProxy) };
  const updateProxy = { set: vi.fn().mockReturnValue(setProxy) };
  const db = { update: vi.fn().mockReturnValue(updateProxy) };
  return { db, updateProxy, setProxy, whereProxy };
}

describe("backfillCrewOriginKind", () => {
  it("calls db.update().set().where() and returns { updated: rowCount }", async () => {
    const { db, updateProxy, setProxy } = makeBackfillDb(5);

    const { backfillCrewOriginKind } = await import(
      "../services/internal-agent/aoa-agents/backfill-crew-origin-kind.js"
    );

    const result = await backfillCrewOriginKind(db as any);

    expect(db.update).toHaveBeenCalledTimes(1);
    expect(updateProxy.set).toHaveBeenCalledTimes(1);
    expect(setProxy.where).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ updated: 5 });
  });

  it("SET payload includes originKind='crew_thread' and updatedAt as Date", async () => {
    const { db, updateProxy } = makeBackfillDb(2);

    const { backfillCrewOriginKind } = await import(
      "../services/internal-agent/aoa-agents/backfill-crew-origin-kind.js"
    );

    await backfillCrewOriginKind(db as any);

    const setArg = updateProxy.set.mock.calls[0][0] as {
      originKind: unknown;
      updatedAt: unknown;
    };

    expect(setArg.originKind).toBe("crew_thread");
    expect(setArg.updatedAt).toBeInstanceOf(Date);
  });

  it("idempotent: second call with 0 matching rows returns { updated: 0 }", async () => {
    const { db } = makeBackfillDb(0);

    const { backfillCrewOriginKind } = await import(
      "../services/internal-agent/aoa-agents/backfill-crew-origin-kind.js"
    );

    const result = await backfillCrewOriginKind(db as any);

    expect(result).toEqual({ updated: 0 });
  });

  it("resolves without throwing when db resolves rowCount=0", async () => {
    const { db } = makeBackfillDb(0);

    const { backfillCrewOriginKind } = await import(
      "../services/internal-agent/aoa-agents/backfill-crew-origin-kind.js"
    );

    await expect(backfillCrewOriginKind(db as any)).resolves.toEqual({
      updated: 0,
    });
  });
});
