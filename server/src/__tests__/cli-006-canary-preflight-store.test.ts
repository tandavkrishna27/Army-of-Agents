// CLI-006 (D2) — the canary preflight store reads its three privileged evidence
// scalars through the SECURITY DEFINER wrapper, NOT through MIG-008's drizzle store.
//
// This file originally asserted the opposite: that `listLeases` / `platformDefaultEnv` /
// `currentKeyGeneration` were the SAME function references as
// `createDrizzleReconciliationStore`'s, so a fork could never silently read a different
// inventory. That rationale was right about WHAT to read and wrong about WHO reads it.
//
// BLOCKER E (E-1): the reconciler's store queries `environment_leases` / `environments` /
// `runtime_provider_keys` / `company_secret_versions` DIRECTLY, while the preflight store
// runs on the NON-OWNER `aoa_app` pool, which holds ZERO privileges on all four. Every
// delegated call raised 42501, `canary-preflight.ts:191-200` folded it into
// `preflight_error`, and the gate answered "I could not read" — a refusal indistinguishable
// from a policy decision. Reference identity with the reconciler's store is now the WRONG
// invariant; the reads go through migration 0266's owner-owned definer function instead.
//
// The anti-drift guarantee survives in a different form: the definer functions read the
// SAME rows with the SAME predicates, and the tests below pin that each member is sourced
// from the wrapper rather than re-querying anything itself.
//
// ROUND 6 — there are now TWO functions and NO shared state. A single function returning one
// row per lease forced a choice between two defects: the two scalar-only members hydrating the
// whole lease inventory to read one scalar, or a single-flight coalescing them. That
// single-flight was store-global and keyed only by company, so two OVERLAPPING `check()` calls
// shared one snapshot and a lease committed between them was invisible to the second — the
// fail-open `canary-preflight.ts:30-33` refuses to cache in order to prevent. Splitting the
// function dissolves the choice instead of scoping it, so the tests below pin INDEPENDENCE
// (every call reads) rather than coalescing.

import { beforeEach, describe, expect, it, vi } from "vitest";

const listLeases = vi.fn();
const platformDefaultEnv = vi.fn();
const currentKeyGeneration = vi.fn();
const insertRecordIfAbsent = vi.fn();

// `casClaimPaused` was a fourth member here. Option R (MIG-010 Unit 2.3) removed it from
// `LegacyReconciliationStore`, so keeping it in this fake would model a seam that no
// longer exists -- and would make the absence assertion below pass for the wrong reason.
vi.mock("../services/legacy-resource-reconciliation-store.js", () => ({
  createDrizzleReconciliationStore: () => ({
    listLeases,
    platformDefaultEnv,
    currentKeyGeneration,
    insertRecordIfAbsent,
  }),
}));

const readCanaryPreflightCompanyIds = vi.fn();
const readCanaryPreflightLeaseInventory = vi.fn();
const readCanaryPreflightScalars = vi.fn();
// ROUND 7 — the factory must export all THREE. Omitting one fails the whole file at import,
// not a single test, because vitest's missing-export throw fires on first use of the module.
vi.mock("../services/canary-preflight-evidence.js", () => ({
  readCanaryPreflightCompanyIds: (...args: unknown[]) => readCanaryPreflightCompanyIds(...args),
  readCanaryPreflightLeaseInventory: (...args: unknown[]) => readCanaryPreflightLeaseInventory(...args),
  readCanaryPreflightScalars: (...args: unknown[]) => readCanaryPreflightScalars(...args),
}));

vi.mock("@armyofagents/db", () => {
  const table = new Proxy({}, { get: (_t, p) => Symbol(String(p)) });
  return { companies: table, legacyResourceReconciliation: table };
});

vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ and: a }),
  eq: (...a: unknown[]) => ({ eq: a }),
  // MIG-010 Unit 2.4b — the marker read is a direct tagged `db.execute` call, so the `sql` tag needs a
  // no-op stand-in. It returns the interpolated values so a future assertion could inspect them.
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    { raw: (v: unknown) => v },
  ),
}));

const execute = vi.fn();

const { createDrizzleCanaryPreflightStore } = await import("../services/canary-preflight-store.js");

describe("CLI-006 — canary preflight store reads through the definer function", () => {
  const db = { execute } as never;
  const store = createDrizzleCanaryPreflightStore(db);

  /** The watermark every narrowed read now carries (migration 0269's snapshot instant). */
  const WATERMARK = new Date("2026-09-02T00:00:00.000Z");

  beforeEach(() => {
    readCanaryPreflightCompanyIds.mockReset();
    readCanaryPreflightLeaseInventory.mockReset();
    readCanaryPreflightScalars.mockReset();
    execute.mockReset();
  });

  it.each([
    ["listLeases", () => listLeases],
    ["platformDefaultEnv", () => platformDefaultEnv],
    ["currentKeyGeneration", () => currentKeyGeneration],
  ])("no longer delegates `%s` to MIG-008's drizzle store", (name, forbidden) => {
    // The reconciler's store is permission-denied on this pool; reusing its members by
    // reference is exactly the defect BLOCKER E names.
    expect(typeof store[name as "listLeases"], name).toBe("function");
    expect(store[name as "listLeases"], name).not.toBe(forbidden());
  });

  it("sources `listLeases` from the leases function, narrowed to lease ids AND carrying the total", async () => {
    readCanaryPreflightLeaseInventory.mockResolvedValue({
      leaseIds: ["lease-1", "lease-2"],
      unnarrowedTotal: 5,
    });

    await expect(store.listLeases("org-1", "co-1", WATERMARK)).resolves.toEqual({
      leases: [{ id: "lease-1" }, { id: "lease-2" }],
      // ★ THE TOTAL SURVIVES THE STORE. Design section 11.4 measured that a caller projecting
      // by name off a widened `RETURNS TABLE` loses the new column SILENTLY, with no error, so
      // the churn arm can be lost one edit at a time. This is the assertion that stops it.
      unnarrowedTotal: 5,
    });
    // ★ AND THE WATERMARK REACHES THE READ. The definer function's third parameter is REQUIRED
    // with no DEFAULT (migration 0270), so a store that dropped it would fail loudly -- but a
    // store that passed the WRONG value would not, which is what this pins.
    expect(readCanaryPreflightLeaseInventory).toHaveBeenCalledWith(db, "org-1", "co-1", WATERMARK);
  });

  it("sources `latestCompletedPass` from the marker table, and null means NO pass rather than an error", async () => {
    // MIG-010 Unit 2.4b. A direct read: `aoa_operator` holds SELECT on
    // `legacy_reconciliation_passes` outright (0269), as it does on the crosswalk, so there is
    // no definer function to mock -- the query goes through `db.execute`.
    execute.mockResolvedValueOnce([]);
    await expect(store.latestCompletedPass("org-1", "co-1", 3600)).resolves.toBeNull();

    execute.mockResolvedValueOnce([
      {
        snapshot_at: WATERMARK,
        key_generation: "sec-1:2",
        stale: false,
        // The driver hands back float8 as a STRING, measured in
        // mig-010-unit-2-4-probes.integration.test.ts. The store must convert EXPLICITLY.
        age_seconds: "42.5",
      },
    ]);
    await expect(store.latestCompletedPass("org-1", "co-1", 3600)).resolves.toEqual({
      snapshotAt: WATERMARK,
      keyGeneration: "sec-1:2",
      stale: false,
      ageSeconds: 42.5,
    });
  });

  it.each([
    [null, null],
    ["env-1", { environmentId: "env-1" }],
  ])("maps platform-default env %s through the scalars function", async (id, expected) => {
    readCanaryPreflightScalars.mockResolvedValue({
      platformDefaultEnvironmentId: id,
      keyGeneration: null,
    });

    await expect(store.platformDefaultEnv("org-1", "co-1")).resolves.toEqual(expected);
    expect(readCanaryPreflightScalars).toHaveBeenCalledWith(db, "org-1", "co-1");
  });

  it("sources `currentKeyGeneration` from the scalars function", async () => {
    readCanaryPreflightScalars.mockResolvedValue({
      platformDefaultEnvironmentId: null,
      keyGeneration: "sec-1:3",
    });

    await expect(store.currentKeyGeneration("org-1", "co-1")).resolves.toBe("sec-1:3");
    expect(readCanaryPreflightScalars).toHaveBeenCalledWith(db, "org-1", "co-1");
  });

  // ROUND 6. The gate fires all three members in ONE `Promise.all`
  // (`canary-preflight.ts:139-145`). The contract that matters is INDEPENDENCE: this gate is
  // "deliberately NOT cached" (`canary-preflight.ts:30-33`) because a stale `true` outliving a
  // newly-unreconciled resource is the fail-open the module exists to close. A store-global
  // single-flight broke that for OVERLAPPING checks; two functions with no shared state cannot.
  it("reads independently on every call — no coalescing, even within one burst", async () => {
    readCanaryPreflightLeaseInventory.mockResolvedValue({
      leaseIds: ["lease-1"],
      unnarrowedTotal: 1,
    });
    readCanaryPreflightScalars.mockResolvedValue({
      platformDefaultEnvironmentId: "env-1",
      keyGeneration: "sec-1:2",
    });

    const [leases, platformDefault, keyGeneration] = await Promise.all([
      store.listLeases("org-1", "co-1", WATERMARK),
      store.platformDefaultEnv("org-1", "co-1"),
      store.currentKeyGeneration("org-1", "co-1"),
    ]);

    expect(leases.leases).toEqual([{ id: "lease-1" }]);
    expect(platformDefault).toEqual({ environmentId: "env-1" });
    expect(keyGeneration).toBe("sec-1:2");
    // Two scalar members, two scalar reads: nothing is shared or replayed.
    expect(readCanaryPreflightScalars).toHaveBeenCalledTimes(2);
  });

  it("never lets a scalar read touch the lease inventory", async () => {
    // The point of the split. `environment_leases` is scanned by `listLeases` and by nothing
    // else — which is what the pre-BLOCKER-E code did, and what a comment here once claimed
    // while three reads were in fact scanning it.
    readCanaryPreflightScalars.mockResolvedValue({
      platformDefaultEnvironmentId: null,
      keyGeneration: null,
    });

    await Promise.all([store.platformDefaultEnv("org-1", "co-1"), store.currentKeyGeneration("org-1", "co-1")]);

    expect(readCanaryPreflightLeaseInventory).not.toHaveBeenCalled();
  });

  it("does not share state between overlapping reads for the same company", async () => {
    // The round-6 defect: a store-global in-flight map keyed by company let a SECOND, later
    // `check()` reuse the FIRST check's snapshot, so a lease committed in between was
    // invisible to it. With no shared state, every overlapping call reads for itself.
    let resolveFirst: ((v: unknown) => void) | undefined;
    readCanaryPreflightLeaseInventory
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
      .mockResolvedValueOnce({ leaseIds: ["lease-late"], unnarrowedTotal: 1 });

    const first = store.listLeases("org-1", "co-1", WATERMARK);
    const second = store.listLeases("org-1", "co-1", WATERMARK);
    resolveFirst?.({ leaseIds: [], unnarrowedTotal: 0 });

    expect((await first).leases).toEqual([]);
    expect((await second).leases).toEqual([{ id: "lease-late" }]);
    expect(readCanaryPreflightLeaseInventory).toHaveBeenCalledTimes(2);
  });

  // The gate is READ-ONLY by construction: it must not even be able to reconcile
  // as a side effect of being consulted.
  //
  // ★ THIS LIST SHRANK FROM TWO TO ONE, AND THAT IS THE HONEST DIRECTION. It read
  // `["casClaimPaused", "insertRecordIfAbsent"]`. Option R deleted `casClaimPaused` from
  // `LegacyReconciliationStore` outright, so asserting the gate does not expose it became
  // vacuously true -- a check that nothing runs. `insertRecordIfAbsent` still exists on the
  // reconciler's store, so this assertion still discriminates: it fails if the gate ever
  // re-acquires the mutating half.
  it("does NOT expose the mutating member `insertRecordIfAbsent`", () => {
    expect((store as Record<string, unknown>).insertRecordIfAbsent).toBeUndefined();
    // And the member it is asserted against is REAL on the reconciler's own store, so this
    // is not an assertion about a name nothing defines.
    expect(typeof insertRecordIfAbsent).toBe("function");
  });

  it("adds the reads MIG-008's store does not have", () => {
    expect(typeof store.listOrganizationCompanyIds).toBe("function");
    expect(typeof store.listRecords).toBe("function");
    // MIG-010 Unit 2.4b — the marker read. The reconciler WRITES markers; only the gate
    // reads the latest one back.
    expect(typeof store.latestCompletedPass).toBe("function");
  });
});
