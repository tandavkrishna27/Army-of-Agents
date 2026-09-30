import { describe, it, expect, vi } from "vitest";

// Proxy-mock DB — mirrors the project pattern from backfill-crew-origin-kind.test.ts.
// The function under test calls db.update(<table>).set({ ...: 2, updatedAt }).where(...)
// THREE times and awaits each chain, in order:
//   1. discussions.autonomy_level              (per-thread override)
//   2. internal_agent_config.autonomy_level    (Commander dial)
//   3. internal_agent_config.crew_autonomy_level (agent-work dial — D18 split)
function makeReconcileDb(
  discussionsRowCount = 0,
  configRowCount = 0,
  crewConfigRowCount = 0,
) {
  // Build a fresh where-proxy for each call so rowCounts are independent.
  function makeChain(rowCount: number) {
    const whereProxy = {
      then: vi.fn((resolve: (value: { rowCount: number }) => void) => {
        resolve({ rowCount });
        return Promise.resolve({ rowCount });
      }),
    };
    const setProxy = { where: vi.fn().mockReturnValue(whereProxy) };
    return { setProxy, whereProxy };
  }

  let callCount = 0;
  const chains = [
    makeChain(discussionsRowCount),
    makeChain(configRowCount),
    makeChain(crewConfigRowCount),
  ];

  const db: Record<string, unknown> = {
    update: vi.fn().mockImplementation(() => {
      const chain = chains[callCount++ % chains.length];
      return { set: vi.fn().mockReturnValue(chain.setProxy) };
    }),
  };
  // The three clamps run inside ONE db.transaction(...) — the mock hands the
  // callback the same object so the update chains above still drive the test.
  db.transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db));

  return { db };
}

describe("reconcileAutonomyScale", () => {
  it("runs all three clamps inside ONE transaction and returns every row count", async () => {
    const { db } = makeReconcileDb(3, 1, 4);

    const { reconcileAutonomyScale } = await import(
      "../services/internal-agent/aoa-agents/reconcile-autonomy-scale.js"
    );

    const result = await reconcileAutonomyScale(db as any);

    expect(db.update).toHaveBeenCalledTimes(3);
    // F6: the two config dials must not be able to end up half-clamped.
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      discussionsUpdated: 3,
      configUpdated: 1,
      crewConfigUpdated: 4,
    });
  });

  it("SET payload for discussions includes autonomyLevel=2 and updatedAt as Date", async () => {
    const { db } = makeReconcileDb(1, 0);

    // Capture set args per call
    const setCalls: Array<{
      autonomyLevel?: unknown;
      crewAutonomyLevel?: unknown;
      updatedAt?: unknown;
    }> = [];
    const origUpdate = db.update;
    let count = 0;

    const rowCounts = [1, 0, 0];
    db.update = vi.fn().mockImplementation(() => {
      const rc = rowCounts[count++ % rowCounts.length];
      const whereProxy = {
        then: vi.fn((resolve: (v: { rowCount: number }) => void) => {
          resolve({ rowCount: rc });
          return Promise.resolve({ rowCount: rc });
        }),
      };
      const setProxy = {
        where: vi.fn().mockReturnValue(whereProxy),
      };
      const updateProxy = {
        set: vi.fn().mockImplementation((args: unknown) => {
          setCalls.push(
            args as {
              autonomyLevel?: unknown;
              crewAutonomyLevel?: unknown;
              updatedAt?: unknown;
            },
          );
          return setProxy;
        }),
      };
      return updateProxy;
    });
    db.transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db));

    const { reconcileAutonomyScale } = await import(
      "../services/internal-agent/aoa-agents/reconcile-autonomy-scale.js"
    );

    await reconcileAutonomyScale(db as any);

    expect(setCalls.length).toBe(3);
    expect(setCalls[0].autonomyLevel).toBe(2);
    expect(setCalls[0].updatedAt).toBeInstanceOf(Date);

    // D18 discriminator: the two config updates target DIFFERENT columns.
    // Commander's clamp writes `autonomyLevel`; the crew clamp writes
    // `crewAutonomyLevel` and must NOT also write the Commander column
    // (a set() that carried both would silently re-couple the dials).
    expect(setCalls[1].autonomyLevel).toBe(2);
    expect(setCalls[1].crewAutonomyLevel).toBeUndefined();
    expect(setCalls[2].crewAutonomyLevel).toBe(2);
    expect(setCalls[2].autonomyLevel).toBeUndefined();
  });

  it("idempotent: second run with 0 matching rows returns all-zero counts", async () => {
    const { db } = makeReconcileDb(0, 0, 0);

    const { reconcileAutonomyScale } = await import(
      "../services/internal-agent/aoa-agents/reconcile-autonomy-scale.js"
    );

    const result = await reconcileAutonomyScale(db as any);

    expect(result).toEqual({
      discussionsUpdated: 0,
      configUpdated: 0,
      crewConfigUpdated: 0,
    });
  });

  it("resolves without throwing when every statement returns 0 rows", async () => {
    const { db } = makeReconcileDb(0, 0, 0);

    const { reconcileAutonomyScale } = await import(
      "../services/internal-agent/aoa-agents/reconcile-autonomy-scale.js"
    );

    await expect(reconcileAutonomyScale(db as any)).resolves.toEqual({
      discussionsUpdated: 0,
      configUpdated: 0,
      crewConfigUpdated: 0,
    });
  });

  it("handles mixed results: discussions updated, config unchanged", async () => {
    const { db } = makeReconcileDb(5, 0, 0);

    const { reconcileAutonomyScale } = await import(
      "../services/internal-agent/aoa-agents/reconcile-autonomy-scale.js"
    );

    const result = await reconcileAutonomyScale(db as any);

    expect(result.discussionsUpdated).toBe(5);
    expect(result.configUpdated).toBe(0);
  });

  it("handles mixed results: config updated, discussions unchanged", async () => {
    const { db } = makeReconcileDb(0, 2, 0);

    const { reconcileAutonomyScale } = await import(
      "../services/internal-agent/aoa-agents/reconcile-autonomy-scale.js"
    );

    const result = await reconcileAutonomyScale(db as any);

    expect(result.discussionsUpdated).toBe(0);
    expect(result.configUpdated).toBe(2);
  });
});
