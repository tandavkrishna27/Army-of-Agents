import { describe, it, expect, vi } from "vitest";

// Proxy-mock DB — follows the project pattern for drizzle-orm ESM tests.
// Returns a lightweight call-chain proxy so the function under test can
// fluently call .update().set().where() without importing drizzle internals.
function makeBackfillDb() {
  const whereProxy = { execute: vi.fn().mockResolvedValue(undefined) };
  const setProxy = { where: vi.fn().mockReturnValue(whereProxy) };
  const updateProxy = { set: vi.fn().mockReturnValue(setProxy) };
  const db = { update: vi.fn().mockReturnValue(updateProxy) };
  return { db, updateProxy, setProxy, whereProxy };
}

describe("backfillCrewTemplateOrigin", () => {
  it("calls db.update(agents).set().where() exactly once", async () => {
    const { db, updateProxy, setProxy, whereProxy } = makeBackfillDb();

    const { backfillCrewTemplateOrigin } = await import(
      "../services/internal-agent/aoa-agents/backfill-template-origin.js"
    );

    await backfillCrewTemplateOrigin(db as any);

    expect(db.update).toHaveBeenCalledTimes(1);
    expect(updateProxy.set).toHaveBeenCalledTimes(1);
    expect(setProxy.where).toHaveBeenCalledTimes(1);
  });

  it("SET payload includes templateOrigin (sql fragment) and updatedAt (Date)", async () => {
    const { db, updateProxy } = makeBackfillDb();

    const { backfillCrewTemplateOrigin } = await import(
      "../services/internal-agent/aoa-agents/backfill-template-origin.js"
    );

    await backfillCrewTemplateOrigin(db as any);

    const setArg = updateProxy.set.mock.calls[0][0] as {
      templateOrigin: unknown;
      updatedAt: unknown;
    };

    // templateOrigin is a drizzle sql`` fragment, not a plain string
    expect(setArg.templateOrigin).toBeDefined();
    expect(setArg.updatedAt).toBeInstanceOf(Date);
  });

  it("resolves without throwing when db resolves undefined", async () => {
    const { db } = makeBackfillDb();

    const { backfillCrewTemplateOrigin } = await import(
      "../services/internal-agent/aoa-agents/backfill-template-origin.js"
    );

    await expect(backfillCrewTemplateOrigin(db as any)).resolves.toBeUndefined();
  });

  // WS6 — Librarian must be covered by the @legacy origin backfill (both new
  // and pre-existing rows), since ensure-librarian.ts / seedCrewAgent stamp
  // no templateOrigin themselves.
  it("CREW_NAMES includes 'Librarian'", async () => {
    const { CREW_NAMES } = await import(
      "../services/internal-agent/aoa-agents/backfill-template-origin.js"
    );
    expect(CREW_NAMES).toContain("Librarian");
  });
});
