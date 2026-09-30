// CLI-006 (D2) — the MIG-008 canary preflight.
//
// Acceptance (program-design.md:794): "MIG-008 has reconciled legacy environment
// leases/resources and moved provider-control authority BEFORE the rollout flag can
// transfer the first live execution."
//
// Two properties carry the whole gate (design §2.7-8):
//   1. Closure is COMPUTED, not stored — MIG-008 persists crosswalk records and
//      `assertClosure` is a pure function, so the preflight RE-DERIVES closure
//      read-only rather than trusting a flag. `reconcileCompanyLegacyResources`
//      cannot be reused: it CAS-claims and inserts (it mutates).
//   2. Closure is COMPANY-scoped while the canary flag is ORGANIZATION-scoped, and
//      an Organization may hold many Companies — so the gate must enumerate EVERY
//      Company under the Organization. Checking only the run's Company is a
//      fail-open, and is the first thing an adversarial review should try.
//
// Everything that is not a clean, current, complete reconciliation refuses.

import { describe, expect, it } from "vitest";
import {
  createCanaryPreflight,
  isDistinctFrom,
  isMarkerGenerationStale,
  RECONCILIATION_EVIDENCE_MAX_AGE_SECONDS,
  type CanaryPreflightLeaseInventory,
  type CanaryPreflightPassMarker,
  type CanaryPreflightStore,
} from "../services/canary-preflight.js";
import { CANARY_CREDENTIAL_AUTHORITY } from "../services/canary-mint-authority.js";
import {
  resourceKeyForLease,
  resourceKeyForPlatformDefaultEnv,
  UNGENERATIONED_KEY_GENERATION,
  type LegacyLeaseInput,
  type ReconciliationRecord,
} from "../services/legacy-resource-reconciliation.js";

const ORG = "55555555-5555-4555-8555-555555555555";
const COMPANY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPANY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const KEY_GEN = "secret-1:5";

function lease(overrides: Partial<LegacyLeaseInput> & { id: string; companyId: string }): LegacyLeaseInput {
  return {
    environmentId: null,
    status: "released",
    leasePolicy: "ephemeral",
    provider: "e2b",
    providerLeaseId: null,
    agentId: null,
    commanderConversationId: null,
    executionWorkspaceId: null,
    issueId: null,
    heartbeatRunId: null,
    cleanupStatus: null,
    ...overrides,
  };
}

function record(overrides: Partial<ReconciliationRecord> & { companyId: string; resourceKey: string }): ReconciliationRecord {
  return {
    environmentLeaseId: null,
    environmentId: null,
    resourceType: "ephemeral",
    legacyStatus: "released",
    provider: "e2b",
    providerLeaseId: null,
    disposition: "terminal_cleanup",
    resourceLabelsHash: null,
    keyGeneration: KEY_GEN,
    cleanupOutcome: null,
    reason: "test fixture",
    ...overrides,
  };
}

/**
 * A completed pass, recent and at the current generation — the marker a clean cutover has.
 * `stale` is a STORE-COMPUTED field (the real store evaluates it in SQL against the database
 * clock on both sides), so a fake supplies it directly rather than re-deriving it here.
 */
function freshMarker(overrides: Partial<CanaryPreflightPassMarker> = {}): CanaryPreflightPassMarker {
  return {
    snapshotAt: new Date("2026-09-02T00:00:00.000Z"),
    keyGeneration: KEY_GEN,
    stale: false,
    ageSeconds: 30,
    ...overrides,
  };
}

/**
 * The narrowed inventory a watermark that covers everything produces: every lease is inside
 * it, and the unnarrowed total equals the narrowed count. Tests that need the CHURN case
 * build `{ leases: [], unnarrowedTotal: n }` explicitly.
 */
function narrowed(leases: readonly LegacyLeaseInput[]): CanaryPreflightLeaseInventory {
  return { leases, unnarrowedTotal: leases.length };
}

/** A store where both Companies of the Organization are cleanly reconciled. */
function cleanStore(): CanaryPreflightStore {
  const leases: Record<string, LegacyLeaseInput[]> = {
    [COMPANY_A]: [lease({ id: "1easeaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", companyId: COMPANY_A })],
    [COMPANY_B]: [lease({ id: "1easebbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", companyId: COMPANY_B })],
  };
  const records: Record<string, ReconciliationRecord[]> = {
    [COMPANY_A]: [
      record({
        companyId: COMPANY_A,
        resourceKey: resourceKeyForLease("1easeaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
      }),
    ],
    [COMPANY_B]: [
      record({
        companyId: COMPANY_B,
        resourceKey: resourceKeyForLease("1easebbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
      }),
    ],
  };
  return {
    listOrganizationCompanyIds: async () => [COMPANY_A, COMPANY_B],
    // MIG-010 Unit 2.4b. ★ EVERY FAKE IN THIS FILE ABSORBED THE NEW MEMBER SILENTLY:
    // `server/src/__tests__` is excluded from typecheck (server/tsconfig.json) and vitest sets
    // no `typecheck` option, so a store-interface change reds NOTHING here at compile time
    // (design section 11.4, measured). These were found by grep and by the RUN, not by tsc.
    latestCompletedPass: async () => freshMarker(),
    listLeases: async (_organizationId, companyId, _watermark) =>
      narrowed(leases[companyId] ?? []),
    platformDefaultEnv: async (_organizationId: string, _companyId: string) => null,
    listRecords: async (companyId) => records[companyId] ?? [],
    currentKeyGeneration: async (_organizationId: string, _companyId: string) => KEY_GEN,
  };
}

function withStore(overrides: Partial<CanaryPreflightStore>): CanaryPreflightStore {
  return { ...cleanStore(), ...overrides };
}

describe("CLI-006 D2 — canary preflight (fail-closed, org-wide, recomputed)", () => {
  it("admits an Organization whose every Company is cleanly reconciled at the current key generation", async () => {
    const preflight = createCanaryPreflight({ store: cleanStore() });
    const result = await preflight.check({ organizationId: ORG });
    expect(result.ok).toBe(true);
  });

  // The fail-open the scope mismatch invites.
  it("REFUSES when a SIBLING Company in the Organization is unreconciled", async () => {
    const preflight = createCanaryPreflight({
      store: withStore({
        // Company B has a legacy lease with no crosswalk record.
        listRecords: async (companyId) =>
          companyId === COMPANY_B
            ? []
            : [
                record({
                  companyId: COMPANY_A,
                  resourceKey: resourceKeyForLease("1easeaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
                }),
              ],
      }),
    });
    const result = await preflight.check({ organizationId: ORG });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("reconciliation_incomplete");
    expect(result.companyId).toBe(COMPANY_B);
  });

  it("REFUSES when a resource is recorded `unattributable`", async () => {
    const preflight = createCanaryPreflight({
      store: withStore({
        listRecords: async (companyId) =>
          companyId === COMPANY_A
            ? [
                record({
                  companyId: COMPANY_A,
                  resourceKey: resourceKeyForLease("1easeaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
                  disposition: "unattributable",
                  resourceType: "unattributable",
                }),
              ]
            : [
                record({
                  companyId: COMPANY_B,
                  resourceKey: resourceKeyForLease("1easebbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
                }),
              ],
      }),
    });
    const result = await preflight.check({ organizationId: ORG });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("reconciliation_incomplete");
  });

  it("REFUSES when the platform-default environment has no crosswalk record", async () => {
    const preflight = createCanaryPreflight({
      store: withStore({
        platformDefaultEnv: async (_organizationId, companyId) =>
          companyId === COMPANY_A ? { environmentId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" } : null,
      }),
    });
    const result = await preflight.check({ organizationId: ORG });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("reconciliation_incomplete");
  });

  it("ADMITS when the platform-default environment IS reconciled", async () => {
    const environmentId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const preflight = createCanaryPreflight({
      store: withStore({
        platformDefaultEnv: async (_organizationId, companyId) => (companyId === COMPANY_A ? { environmentId } : null),
        listRecords: async (companyId) =>
          companyId === COMPANY_A
            ? [
                record({
                  companyId: COMPANY_A,
                  resourceKey: resourceKeyForLease("1easeaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
                }),
                record({
                  companyId: COMPANY_A,
                  resourceKey: resourceKeyForPlatformDefaultEnv(environmentId),
                }),
              ]
            : [
                record({
                  companyId: COMPANY_B,
                  resourceKey: resourceKeyForLease("1easebbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
                }),
              ],
      }),
    });
    expect((await preflight.check({ organizationId: ORG })).ok).toBe(true);
  });

  // Credential authority — the second half of the acceptance clause.
  //
  // ★ INVERTED IN PLACE BY MIG-010 UNIT 2.4b, NOT DELETED (DSK-003). Until this unit it read:
  //
  //     it("REFUSES when a record carries a SUPERSEDED key generation", ...)
  //       expect(result.reason).toBe("credential_authority_not_moved");
  //
  // and it passed, because the gate filtered RECORDS by generation. Design section 12 showed
  // that clause was wrong twice over: the crosswalk is append-only, so a re-run could not
  // re-tag a record and ANY rotation after a clean pass bricked the Company permanently; and
  // its `!== null` conjunct meant a NULL-generation record was never counted as superseded at
  // all (E7-F005). The generation now belongs to the MARKER, so a superseded RECORD is
  // history and no longer a verdict.
  it("[section 12, inverted] a record carrying a SUPERSEDED generation no longer refuses — the MARKER decides", async () => {
    const preflight = createCanaryPreflight({
      store: withStore({
        listRecords: async (companyId) =>
          companyId === COMPANY_A
            ? [
                record({
                  companyId: COMPANY_A,
                  resourceKey: resourceKeyForLease("1easeaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
                  keyGeneration: "secret-1:4",
                }),
              ]
            : [
                record({
                  companyId: COMPANY_B,
                  resourceKey: resourceKeyForLease("1easebbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
                }),
              ],
      }),
    });
    // The marker is fresh and at the current generation, so the evidence IS current — which
    // is what "reconciled under the authority in force" actually means.
    expect((await preflight.check({ organizationId: ORG })).ok).toBe(true);
  });

  it("[section 12] REFUSES `reconciliation_stale` when the MARKER's generation is superseded", async () => {
    const preflight = createCanaryPreflight({
      store: withStore({
        latestCompletedPass: async () => freshMarker({ keyGeneration: "secret-1:4" }),
      }),
    });
    const result = await preflight.check({ organizationId: ORG });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    // NOT `credential_authority_not_moved`: authority DID move, and the evidence predates the
    // move. Re-running the pass fixes it, which is exactly what the reason says.
    expect(result.reason).toBe("reconciliation_stale");
    expect(result.detail).toContain("superseded");
  });

  // ★★★ THE FOUR COMBINATIONS design section 13.3 requires pinned, and the SECOND is the one
  // every naive implementation gets wrong: SQL `<>` (or a bare `!==` against a NULL current)
  // lets a sentinel marker escape when the current generation is real. Measured against
  // PostgreSQL 18.1: `<>` matched 2 of 3 rows with a real current and 0 of 3 with a NULL one;
  // `IS DISTINCT FROM` matched 3 of 3 and 2 of 3.
  it("[section 13.3] pins all four (marker, current) generation combinations", () => {
    expect(isMarkerGenerationStale(UNGENERATIONED_KEY_GENERATION, null)).toBe(false);
    expect(isMarkerGenerationStale(UNGENERATIONED_KEY_GENERATION, "S2:1")).toBe(true);
    expect(isMarkerGenerationStale("S1:1", "S2:1")).toBe(true);
    expect(isMarkerGenerationStale("S1:1", "S1:1")).toBe(false);
    // And the primitive underneath, so a future nullable input cannot silently re-open it.
    expect(isDistinctFrom(null, null)).toBe(false);
    expect(isDistinctFrom(null, "S1:1")).toBe(true);
    expect(isDistinctFrom("S1:1", null)).toBe(true);
  });

  it("[section 9.1] REFUSES `reconciliation_stale` when the marker has no completed pass at all", async () => {
    const preflight = createCanaryPreflight({
      store: withStore({ latestCompletedPass: async () => null }),
    });
    const result = await preflight.check({ organizationId: ORG });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("reconciliation_stale");
    expect(result.detail).toContain("no completed legacy reconciliation pass");
  });

  it("[section 9.1] REFUSES `reconciliation_stale` when the evidence is past the freshness bound", async () => {
    const preflight = createCanaryPreflight({
      store: withStore({
        latestCompletedPass: async () =>
          freshMarker({ stale: true, ageSeconds: RECONCILIATION_EVIDENCE_MAX_AGE_SECONDS + 1 }),
      }),
    });
    const result = await preflight.check({ organizationId: ORG });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("reconciliation_stale");
    expect(result.detail).toContain(`${RECONCILIATION_EVIDENCE_MAX_AGE_SECONDS}s bound`);
  });

  it("[section 10.3.4 — the CHURN arm] REFUSES when the pass predates the ENTIRE current fleet", async () => {
    // The fail-open this arm exists to close: an empty narrowed inventory satisfies
    // `assertClosure` VACUOUSLY (it iterates inventoryKeys only), so without the unnarrowed
    // total the gate would ADMIT here — no error, no reason, no log.
    const preflight = createCanaryPreflight({
      store: withStore({
        listLeases: async (_organizationId, companyId) =>
          companyId === COMPANY_A ? { leases: [], unnarrowedTotal: 3 } : narrowed([]),
      }),
    });
    const result = await preflight.check({ organizationId: ORG });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("reconciliation_stale");
    expect(result.detail).toContain("3 legacy lease(s)");
  });

  it("[section 10.3.4] a genuinely lease-free Company is NOT churn — zero narrowed AND zero total ADMITS", async () => {
    // The discriminating half. If the arm were written on the narrowed count alone it would
    // refuse every Company that simply holds no legacy leases, which is a normal, closed state.
    const preflight = createCanaryPreflight({
      store: withStore({
        listLeases: async () => narrowed([]),
        listRecords: async () => [],
      }),
    });
    expect((await preflight.check({ organizationId: ORG })).ok).toBe(true);
  });

  it("REFUSES when provider-control authority has not moved at all (no key generation)", async () => {
    const preflight = createCanaryPreflight({
      store: withStore({ currentKeyGeneration: async (_organizationId: string, _companyId: string) => null }),
    });
    const result = await preflight.check({ organizationId: ORG });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("credential_authority_not_moved");
  });

  it("REFUSES when the Organization resolves to no Companies (nothing was reconciled)", async () => {
    const preflight = createCanaryPreflight({
      store: withStore({ listOrganizationCompanyIds: async () => [] }),
    });
    const result = await preflight.check({ organizationId: ORG });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("no_companies");
  });

  // Fail-closed on unreadability — never "assume reconciled".
  it("REFUSES (never throws) when the store throws", async () => {
    const preflight = createCanaryPreflight({
      store: withStore({
        listLeases: async (_organizationId: string, _companyId: string, _watermark: Date) => {
          throw new Error("db down");
        },
      }),
    });
    const result = await preflight.check({ organizationId: ORG });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("preflight_error");
  });

  it("REFUSES when company enumeration itself throws", async () => {
    const preflight = createCanaryPreflight({
      store: withStore({
        listOrganizationCompanyIds: async () => {
          throw new Error("db down");
        },
      }),
    });
    const result = await preflight.check({ organizationId: ORG });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("preflight_error");
  });

  // ★★★ E7-F004, INVERTED IN PLACE BY MIG-010 UNIT 2.4b — not deleted (DSK-003). Until this
  // unit it read:
  //
  //     it("REFUSES again when a NEW legacy lease appears after a clean reconciliation", ...)
  //       expect(result.reason).toBe("reconciliation_incomplete");
  //
  // and it passed, and it was the defect. The gate re-derived its inventory from LIVE rows, so
  // one lease created a second after the pass re-closed it — on a box taking legacy traffic
  // the gate could never open, permanently, and the old comment above called that
  // "self-healing". It is a permanently-losing race, which is what E7-F004 filed.
  //
  // A post-watermark lease is now OUT of the narrowed inventory. Section 9.1 names the
  // residual honestly: inside the freshness window such a lease IS waved through without a
  // crosswalk record. That is the intended semantics — it is current traffic on the legacy
  // path, not an unreconciled legacy resource — and the window bounds how much of it can
  // accumulate rather than eliminating it.
  it("[E7-F004, inverted] a NEW legacy lease created AFTER the watermark no longer re-closes the gate", async () => {
    const store = cleanStore();
    expect((await createCanaryPreflight({ store }).check({ organizationId: ORG })).ok).toBe(true);

    const withNewLease = createCanaryPreflight({
      store: {
        ...store,
        // The narrowed set is UNCHANGED — the new lease postdates the watermark, so the
        // definer function's FILTER excludes it — while the unnarrowed total grows. That
        // asymmetry is exactly what the one-row contract exists to express.
        listLeases: async (_organizationId, companyId, watermark) =>
          companyId === COMPANY_A
            ? {
                leases: [lease({ id: "1easeaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", companyId: COMPANY_A })],
                unnarrowedTotal: 2,
              }
            : store.listLeases(_organizationId, companyId, watermark),
      },
    });
    expect((await withNewLease.check({ organizationId: ORG })).ok).toBe(true);
  });

  it("[E7-F004] a lease created BEFORE the watermark still re-closes the gate — the narrowing is not a blanket pass", async () => {
    // The anti-vacuity half. If the narrowing were "ignore leases", this would admit too.
    const store = cleanStore();
    const withOldLease = createCanaryPreflight({
      store: {
        ...store,
        listLeases: async (_organizationId, companyId, watermark) =>
          companyId === COMPANY_A
            ? narrowed([
                lease({ id: "1easeaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", companyId: COMPANY_A }),
                lease({ id: "1easeold-nnnn-4nnn-8nnn-nnnnnnnnnnnn", companyId: COMPANY_A }),
              ])
            : store.listLeases(_organizationId, companyId, watermark),
      },
    });
    const result = await withOldLease.check({ organizationId: ORG });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("reconciliation_incomplete");
  });

  // The preflight is read-only: it must not reuse the mutating reconcile pass.
  it("performs NO writes (read-only store surface only)", async () => {
    const calls: string[] = [];
    const store = cleanStore();
    const preflight = createCanaryPreflight({
      store: {
        listOrganizationCompanyIds: async (...a) => {
          calls.push("listOrganizationCompanyIds");
          return store.listOrganizationCompanyIds(...a);
        },
        latestCompletedPass: async (...a) => {
          calls.push("latestCompletedPass");
          return store.latestCompletedPass(...a);
        },
        listLeases: async (...a) => {
          calls.push("listLeases");
          return store.listLeases(...a);
        },
        platformDefaultEnv: async (...a) => {
          calls.push("platformDefaultEnv");
          return store.platformDefaultEnv(...a);
        },
        listRecords: async (...a) => {
          calls.push("listRecords");
          return store.listRecords(...a);
        },
        currentKeyGeneration: async (...a) => {
          calls.push("currentKeyGeneration");
          return store.currentKeyGeneration(...a);
        },
      },
    });
    await preflight.check({ organizationId: ORG });
    // `casClaimPaused` was named here too. Option R removed it from the reconciler's store,
    // so its absence is no longer a fact about the GATE -- it is a fact about nothing. The
    // exact-set assertion below is what carries this test, and it fails on any extra call.
    expect(calls).not.toContain("insertRecordIfAbsent");
    expect(new Set(calls)).toEqual(
      new Set([
        "listOrganizationCompanyIds", "latestCompletedPass", "listLeases",
        "platformDefaultEnv", "listRecords", "currentKeyGeneration",
      ]),
    );
  });
});

// CLI-007 (E7-F001) — the preflight is where the canary's Company mint authority is
// ESTABLISHED. It already verifies the Company holds provider-control authority
// (`currentKeyGeneration !== null`); on `ok` it now EMITS the ownership class the mint
// rides. A refusal emits none — the authority cannot be established, so nothing
// downstream can mint (fail-closed by SHAPE, not by a flag a caller could ignore).
describe("CLI-007 — the preflight establishes the canary's Company mint authority", () => {
  it("emits `credentialAuthority: company_api_key` on OK, after the provider-control-authority check passes", async () => {
    const preflight = createCanaryPreflight({ store: cleanStore() });
    const result = await preflight.check({ organizationId: ORG });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.credentialAuthority).toBe(CANARY_CREDENTIAL_AUTHORITY);
    expect(result.credentialAuthority).toBe("company_api_key");
  });

  // Fail-closed by shape: the authority the mint reads only ever exists on an OK
  // result, so a Company whose provider-control authority has NOT moved cannot leak a
  // usable authority into the mint.
  it("emits NO credentialAuthority when the gate refuses (provider-control authority not moved)", async () => {
    const preflight = createCanaryPreflight({
      store: withStore({ currentKeyGeneration: async (_organizationId: string, _companyId: string) => null }),
    });
    const result = await preflight.check({ organizationId: ORG });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("credential_authority_not_moved");
    expect((result as { credentialAuthority?: unknown }).credentialAuthority).toBeUndefined();
  });
});

// BLOCKER E (E-1) — the gate consumes ONLY `lease.id`.
//
// `canary-preflight-store.ts` now constructs its leases as `{ id } as LegacyLeaseInput`,
// because the definer function that replaced the permission-denied drizzle reads projects
// exactly one lease column. That cast is a real narrowing: if the gate ever reads another
// field it would see `undefined` in PRODUCTION while every fake-store test in this file —
// all of which build fully-populated leases — kept passing. This asserts the narrowing the
// cast asserts.
describe("BLOCKER E — the gate consumes only lease.id", () => {
  it("reaches a policy verdict when leases carry ONLY an id", async () => {
    const preflight = createCanaryPreflight({
      store: {
        listOrganizationCompanyIds: async () => [COMPANY_A],
        latestCompletedPass: async () => freshMarker(),
        listLeases: async (_organizationId: string, _companyId: string, _watermark: Date) => ({
          leases: [{ id: "lease-1" } as never],
          unnarrowedTotal: 1,
        }),
        platformDefaultEnv: async (_organizationId: string, _companyId: string) => null,
        listRecords: async () => [],
        currentKeyGeneration: async (_organizationId: string, _companyId: string) => KEY_GEN,
      },
    });

    const result = await preflight.check({ organizationId: ORG });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // A key generation IS supplied here, so the gate gets past the credential check at
      // canary-preflight.ts:150-156 and reaches closure — the branch that touches lease
      // fields. `preflight_error` here would mean the gate threw while reading the lease.
      expect(result.reason).toBe("reconciliation_incomplete");
    }
  });
});
