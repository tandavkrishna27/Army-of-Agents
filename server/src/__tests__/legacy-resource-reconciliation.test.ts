import { describe, expect, it } from "vitest";
import {
  classifyLease,
  computeResourceLabelsHash,
  resourceKeyForLease,
  resourceKeyForPlatformDefaultEnv,
  buildLeaseRecord,
  buildPlatformDefaultEnvRecord,
  assertClosure,
  reconcileCompanyLegacyResources,
  reconcileOrganizationLegacyResources,
  type LegacyLeaseInput,
  type LegacyReconciliationStore,
  type ReconciliationPassMarker,
  UNGENERATIONED_KEY_GENERATION,
  markerKeyGeneration,
} from "../services/legacy-resource-reconciliation.js";

const ORG = "org-1";

const baseLease = (over: Partial<LegacyLeaseInput> = {}): LegacyLeaseInput => ({
  id: "lease-1",
  companyId: "co-1",
  environmentId: "env-1",
  status: "active",
  leasePolicy: "ephemeral",
  provider: "e2b",
  providerLeaseId: "sbx-1",
  agentId: null,
  commanderConversationId: null,
  executionWorkspaceId: null,
  issueId: null,
  heartbeatRunId: null,
  cleanupStatus: null,
  ...over,
});

describe("MIG-008 classifyLease — all 5 types + failed-cleanup", () => {
  it("classifies an ephemeral one-shot/crew lease", () => {
    const c = classifyLease(baseLease({ leasePolicy: "ephemeral" }));
    expect(c.resourceType).toBe("ephemeral");
  });

  it("classifies a warm ORG agent lease (paused, agentId)", () => {
    const c = classifyLease(
      baseLease({ leasePolicy: "reuse_by_agent", status: "paused", agentId: "agent-1" }),
    );
    expect(c.resourceType).toBe("warm_org");
  });

  it("classifies a warm Commander lease (paused, commanderConversationId)", () => {
    const c = classifyLease(
      baseLease({
        leasePolicy: "reuse_by_agent",
        status: "paused",
        commanderConversationId: "conv-1",
      }),
    );
    expect(c.resourceType).toBe("warm_commander");
  });

  it("classifies a workspace/preview ref lease", () => {
    const c = classifyLease(
      baseLease({ leasePolicy: "reuse_by_workspace", executionWorkspaceId: "ws-1" }),
    );
    expect(c.resourceType).toBe("workspace_ref");
  });

  it("routes cleanupStatus='failed' terminal rows to CLI-004 delegation", () => {
    const c = classifyLease(baseLease({ status: "failed", cleanupStatus: "failed" }));
    expect(c.disposition).toBe("terminal_cleanup");
    expect(c.cleanupOutcome).toBe("delegated_cli004");
  });

  it("surfaces an unclassifiable owner shape as unattributable (never dropped)", () => {
    const c = classifyLease(
      baseLease({ leasePolicy: "reuse_by_environment", agentId: null, executionWorkspaceId: null }),
    );
    expect(c.disposition).toBe("unattributable");
  });
});

describe("MIG-008 Invariant #2 — active effect authority never → fence", () => {
  it("maps a live active lease to a drain record with NO synthesized fence", () => {
    const lease = baseLease({ status: "active", providerLeaseId: "sbx-live" });
    const c = classifyLease(lease);
    expect(c.hasLiveHandle).toBe(true);
    expect(c.disposition).toBe("mapped");
    const record = buildLeaseRecord(lease, c, { keyGeneration: "secret-x:3" });
    // Only a partial-attribution hash — never a leasable ResourceLabels fence object.
    expect(typeof record.resourceLabelsHash).toBe("string");
    expect(record).not.toHaveProperty("fence");
    expect(record).not.toHaveProperty("resourceLabels");
    expect(record.disposition).toBe("mapped");
  });

  it("hashes owner FKs deterministically (attribution only)", () => {
    const lease = baseLease({ agentId: "a-1", providerLeaseId: "sbx-9" });
    expect(computeResourceLabelsHash(lease)).toBe(computeResourceLabelsHash(lease));
    expect(computeResourceLabelsHash(lease)).not.toBe(
      computeResourceLabelsHash(baseLease({ agentId: "a-2", providerLeaseId: "sbx-9" })),
    );
  });

  it("terminal rows with no live handle get a terminal_cleanup record", () => {
    const c = classifyLease(baseLease({ status: "released", providerLeaseId: null }));
    expect(c.hasLiveHandle).toBe(false);
    expect(c.disposition).toBe("terminal_cleanup");
    expect(c.cleanupOutcome).toBe("no_handle");
  });
});

describe("MIG-008 resource keys + platform-default env record", () => {
  it("keys a lease record by its lease id (idempotency key)", () => {
    expect(resourceKeyForLease("lease-abc")).toBe("lease-abc");
  });

  it("keys the platform-default env resource distinctly (uuidv5 id never reminted)", () => {
    expect(resourceKeyForPlatformDefaultEnv("env-xyz")).toBe("platform-default-env:env-xyz");
  });

  it("builds a platform-default env record without persisting any key material", () => {
    const record = buildPlatformDefaultEnvRecord({
      companyId: "co-1",
      environmentId: "env-xyz",
      keyGeneration: "secret-x:2",
    });
    expect(record.resourceType).toBe("platform_default_env");
    expect(record.resourceKey).toBe("platform-default-env:env-xyz");
    expect(record.disposition).toBe("mapped");
    // No key material anywhere on the record.
    expect(JSON.stringify(record)).not.toMatch(/apiKey|resolvedApiKey|E2B_API_KEY/i);
    expect(record.keyGeneration).toBe("secret-x:2");
  });
});

describe("MIG-008 closure gate — one record per resource, zero unmapped", () => {
  it("passes when every inventoried resource has exactly one record", () => {
    const result = assertClosure({
      inventoryKeys: ["lease-1", "lease-2", "platform-default-env:env-1"],
      records: [
        { resourceKey: "lease-1", disposition: "mapped" },
        { resourceKey: "lease-2", disposition: "terminal_cleanup" },
        { resourceKey: "platform-default-env:env-1", disposition: "mapped" },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.unmapped).toEqual([]);
    expect(result.unattributable).toEqual([]);
  });

  it("reports an unmapped resource at closure (never silently dropped)", () => {
    const result = assertClosure({
      inventoryKeys: ["lease-1", "lease-2"],
      records: [{ resourceKey: "lease-1", disposition: "mapped" }],
    });
    expect(result.ok).toBe(false);
    expect(result.unmapped).toEqual(["lease-2"]);
  });

  it("surfaces unattributable dispositions (reported, not tolerated silently)", () => {
    const result = assertClosure({
      inventoryKeys: ["lease-1"],
      records: [{ resourceKey: "lease-1", disposition: "unattributable" }],
    });
    expect(result.ok).toBe(false);
    expect(result.unattributable).toEqual(["lease-1"]);
  });

  it("flags a duplicate record for a resource (append-only idempotency broken)", () => {
    const result = assertClosure({
      inventoryKeys: ["lease-1"],
      records: [
        { resourceKey: "lease-1", disposition: "mapped" },
        { resourceKey: "lease-1", disposition: "terminal_cleanup" },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.duplicates).toEqual(["lease-1"]);
  });
});

// --- reconciler pass with an injected store seam (no drizzle internals) -------

/** Fixed so the marker assertions can compare exactly rather than within a window. */
const FAKE_SNAPSHOT_AT = new Date("2026-09-02T00:00:00.000Z");

function makeStore(
  leases: LegacyLeaseInput[],
  opts: {
    platformDefaultEnvId?: string | null;
    keyGeneration?: string | null;
    companyIds?: readonly string[];
  } = {},
): LegacyReconciliationStore & {
  inserted: Array<{ resourceKey: string; disposition: string }>;
  markers: ReconciliationPassMarker[];
} {
  const inserted: Array<{ resourceKey: string; disposition: string }> = [];
  const markers: ReconciliationPassMarker[] = [];
  const seen = new Set<string>();
  return {
    inserted,
    markers,
    listOrganizationCompanyIds: async () => opts.companyIds ?? ["co-1"],
    listLeases: async () => leases,
    platformDefaultEnv: async () =>
      opts.platformDefaultEnvId ? { environmentId: opts.platformDefaultEnvId } : null,
    currentKeyGeneration: async () => opts.keyGeneration ?? null,
    // `casClaimPaused` was here (with a `pausedClaim` knob to make it lose). Option R
    // removed the member from `LegacyReconciliationStore` entirely, so a fake that still
    // offered it would be modelling a seam that no longer exists.
    insertRecordIfAbsent: async (record) => {
      if (seen.has(record.resourceKey)) return false;
      seen.add(record.resourceKey);
      inserted.push({ resourceKey: record.resourceKey, disposition: record.disposition });
      return true;
    },
    // MIG-010 Unit 2.4. ★ `server/src/__tests__` is EXCLUDED from typecheck
    // (server/tsconfig.json) and vitest sets no `typecheck` option, so a store-interface
    // change reds NOTHING here — this fake was found by grep, not by the compiler
    // (design §11.4, measured). A fixed instant keeps the pass's ordering assertions
    // deterministic; `markers` is what the marker tests below read.
    readSnapshotInstant: async () => FAKE_SNAPSHOT_AT,
    recordCompletedPass: async (marker) => {
      markers.push(marker);
    },
  };
}

describe("MIG-008 reconciler pass", () => {
  it("emits exactly one record per inventoried resource + platform-default env, closure passes", async () => {
    const leases = [
      baseLease({ id: "l-a", status: "active", providerLeaseId: "sbx-a" }),
      baseLease({ id: "l-b", status: "released", providerLeaseId: null }),
    ];
    const store = makeStore(leases, { platformDefaultEnvId: "env-1" });
    const result = await reconcileCompanyLegacyResources(ORG, "co-1", { store });
    expect(result.closure.ok).toBe(true);
    expect(store.inserted.map((r) => r.resourceKey).sort()).toEqual(
      ["l-a", "l-b", "platform-default-env:env-1"].sort(),
    );
  });

  // ★ OPTION R (MIG-010 Unit 2.3) INVERTED THIS PAIR. There were two cases here — "the CAS
  // is lost, record nothing, report skippedResumed" and "the CAS is won, record it
  // terminally". Both described a compare-and-swap that no longer exists: it was an UPDATE
  // on `environment_leases`, and `aoa_operator` holds no write grant there, so the pass
  // could not run at all while it was in the code path.
  //
  // The replacement asserts the property that REPLACED them, rather than deleting a pair of
  // failures: a paused row is now always inventoried and always recorded, as `mapped`.
  it("records a paused row as `mapped` — always, with no CAS to lose", async () => {
    const paused = baseLease({
      id: "l-paused",
      status: "paused",
      leasePolicy: "reuse_by_agent",
      agentId: "agent-1",
      providerLeaseId: "sbx-p",
    });
    const store = makeStore([paused], { keyGeneration: "secret-x:1" });
    const result = await reconcileCompanyLegacyResources(ORG, "co-1", { store });

    const rec = store.inserted.find((r) => r.resourceKey === "l-paused");
    // It is RECORDED (the old lost-CAS branch recorded nothing at all) ...
    expect(rec).toBeDefined();
    // ... and `mapped`, not `terminal_cleanup`: the pass observes a resumable snapshot, it
    // does not assert terminality on it.
    expect(rec?.disposition).toBe("mapped");
    // And because every lease is now recorded, closure holds over the same inventory —
    // which is E-3's second asymmetry (a lost CAS leaving an unrecorded row the gate still
    // counts) closed by construction.
    expect(result.closure.ok).toBe(true);
    expect(result.closure.unmapped).toEqual([]);
  });

  it("keeps the OBSERVED status on a paused record, and carries the distinction in `reason`", () => {
    // A `mapped` paused row must not read as an active one. The honest status stays on the
    // record; `reason` is where the difference lives.
    const paused = baseLease({
      id: "l-paused",
      status: "paused",
      leasePolicy: "reuse_by_agent",
      agentId: "agent-1",
      providerLeaseId: "sbx-p",
    });
    const record = buildLeaseRecord(paused, classifyLease(paused), { keyGeneration: null });
    expect(record.legacyStatus).toBe("paused");
    expect(record.disposition).toBe("mapped");
    expect(record.reason).toContain("paused warm snapshot");
    // NOT the terminal handoff it used to claim, and not CLI-004's either.
    expect(record.reason).not.toContain("CLI-004");
    expect(record.cleanupOutcome).toBeNull();
    // A `mapped` record carries the attribution hash — and only that; never a fence.
    expect(typeof record.resourceLabelsHash).toBe("string");
  });

  it("is idempotent: a second reconcile inserts no duplicate records", async () => {
    const leases = [baseLease({ id: "l-a", status: "active", providerLeaseId: "sbx-a" })];
    const store = makeStore(leases, { platformDefaultEnvId: "env-1" });
    await reconcileCompanyLegacyResources(ORG, "co-1", { store });
    const firstCount = store.inserted.length;
    await reconcileCompanyLegacyResources(ORG, "co-1", { store });
    expect(store.inserted.length).toBe(firstCount);
  });

  it("surfaces an unattributable row in the closure report (never dropped)", async () => {
    const weird = baseLease({
      id: "l-weird",
      status: "active",
      leasePolicy: "reuse_by_environment",
      agentId: null,
      executionWorkspaceId: null,
      commanderConversationId: null,
    });
    const store = makeStore([weird], { platformDefaultEnvId: null });
    const result = await reconcileCompanyLegacyResources(ORG, "co-1", { store });
    expect(result.closure.unattributable).toContain("l-weird");
    expect(result.closure.ok).toBe(false);
  });
});

// --- the ORGANIZATION fold (MIG-010 Unit 2.3) --------------------------------
//
// The pass became org-scoped because every read now goes through an organization-bound
// SECURITY DEFINER function and `0267` ships no company->org reverse lookup (design §4.2,
// F1). These pin the fold itself: the unit of closure is still the company, the unit of
// VERDICT is the organization.

describe("MIG-010 reconcileOrganizationLegacyResources — the org fold", () => {
  it("folds every company under the organization, and closes only when ALL do", async () => {
    const store = makeStore([baseLease({ id: "l-a", status: "active", providerLeaseId: "sbx-a" })], {
      companyIds: ["co-1", "co-2", "co-3"],
    });
    const result = await reconcileOrganizationLegacyResources(ORG, { store });

    expect(result.organizationId).toBe(ORG);
    expect(result.companies.map((c) => c.companyId)).toEqual(["co-1", "co-2", "co-3"]);
    expect(result.ok).toBe(true);
  });

  it("one unattributable company closes the WHOLE organization", async () => {
    // The sibling-company fail-open the gate's org scope exists to prevent: a clean company
    // must not carry a dirty one across the line.
    const weird = baseLease({
      id: "l-weird",
      status: "active",
      leasePolicy: "reuse_by_environment",
      agentId: null,
      executionWorkspaceId: null,
      commanderConversationId: null,
    });
    const store = makeStore([weird], { companyIds: ["co-1", "co-2"] });
    const result = await reconcileOrganizationLegacyResources(ORG, { store });

    expect(result.ok).toBe(false);
    expect(result.unattributableKeys).toContain("l-weird");
    // It does NOT short-circuit: an operator wants the whole picture, not the first company
    // alphabetically. Both companies were visited.
    expect(result.companies).toHaveLength(2);
  });

  it("an organization with NO companies is NOT closed", async () => {
    // ★ THE VACUOUS-CLOSURE ARM. `assertClosure` returns ok over an empty inventory, so a
    // fold written as `every(...)` alone answers `ok: true` for an organization that
    // reconciled nothing at all — the same shape as the withdrawn watermark's empty-inventory
    // fail-open (design §10.1(b)). The gate refuses this as `no_companies`; so does the pass.
    const store = makeStore([], { companyIds: [] });
    const result = await reconcileOrganizationLegacyResources(ORG, { store });

    expect(result.companies).toEqual([]);
    expect(result.ok).toBe(false);
  });
});
