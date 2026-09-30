// server/src/services/canary-preflight-store.ts
//
// CLI-006 (D2) — drizzle wiring for the canary preflight's read-only store.
//
// Kept OUT of the pure `canary-preflight.ts` acceptance module so its fail-first
// unit tests never load drizzle internals (Test Patterns rule), exactly as MIG-008
// keeps `legacy-resource-reconciliation-store.ts` out of its acceptance module.
//
// It ONCE delegated `listLeases` / `platformDefaultEnv` / `currentKeyGeneration` to
// MIG-008's own `createDrizzleReconciliationStore` rather than re-querying, so the gate
// would see exactly the inventory the reconciler recorded. BLOCKER E (E-1) inverted that
// rationale: the delegation was right about WHAT to read and wrong about WHO reads it.
// That store queries `environment_leases` / `environments` / `runtime_provider_keys` /
// `company_secret_versions` DIRECTLY, while THIS store runs on the NON-OWNER `aoa_app`
// pool, which holds ZERO privileges on all four. Every call raised 42501, the catch at
// `canary-preflight.ts:191-200` folded it into `preflight_error`, and the gate could not
// even say why it was closed.
//
// The three reads now go through an owner-owned SECURITY DEFINER function
// (`canary-preflight-evidence.ts`, migration 0266). The original guarantee is PRESERVED:
// the function reads the same rows with the same predicates. It changes WHO may read
// them, not WHAT is read. A table grant was not an option — `company_secret_versions.material`
// is AES-256-GCM secret material and `environment_leases.metadata` is secret-bearing at rest.
//
// Only two reads are genuinely new, and neither exists on the reconciler's store
// because the reconciler never needs them: it works one Company at a time and
// computes closure over records it is building, not over records already persisted.
//
// The mutating half of the reconciler's store (`casClaimPaused`,
// `insertRecordIfAbsent`) is NOT re-exposed here — `CanaryPreflightStore` has no
// such members, so the gate structurally cannot reconcile as a side effect of being
// consulted.

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { legacyResourceReconciliation } from "@armyofagents/db";
import {
  readCanaryPreflightCompanyIds,
  readCanaryPreflightLeaseInventory,
  readCanaryPreflightScalars,
} from "./canary-preflight-evidence.js";
import type {
  CanaryPreflightLeaseInventory,
  CanaryPreflightPassMarker,
  CanaryPreflightStore,
} from "./canary-preflight.js";
import type {
  LegacyLeaseInput,
  ReconciliationRecord,
} from "./legacy-resource-reconciliation.js";

function rowsOf<T>(result: unknown): T[] {
  // `db.execute` returns an array on some drivers and `{rows}` on others. Both shapes are
  // handled deliberately; do not "simplify" without checking which driver this pool uses.
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as T[];
}

export function createDrizzleCanaryPreflightStore(db: Db): CanaryPreflightStore {
  return {
    // NEW. The canary flag is Organization-scoped while reconciliation closure is
    // Company-scoped, and one Organization may hold many Companies — so the gate
    // must enumerate all of them. Checking only the run's Company would let an
    // Organization be canaried while a sibling Company's legacy leases stay
    // unreconciled (design §2.8).
    // ROUND 7 — through the definer function, not a direct `companies` select. The gate's
    // pool therefore needs no `companies` grant, which is exactly what let EXECUTE move to
    // aoa_operator (it holds no grant on companies or organizations).
    listOrganizationCompanyIds: async (organizationId: string) =>
      readCanaryPreflightCompanyIds(db, organizationId),

    // NEW. The reconciler only ever inserts; nothing needed to READ the persisted
    // crosswalk back until a gate had to recompute closure without mutating.
    listRecords: async (companyId: string): Promise<readonly ReconciliationRecord[]> => {
      const rows = await db
        .select()
        .from(legacyResourceReconciliation)
        .where(and(eq(legacyResourceReconciliation.companyId, companyId)));
      return rows.map((row) => ({
        companyId: row.companyId,
        environmentLeaseId: row.environmentLeaseId,
        environmentId: row.environmentId,
        resourceKey: row.resourceKey,
        resourceType: row.resourceType as ReconciliationRecord["resourceType"],
        legacyStatus: row.legacyStatus,
        provider: row.provider,
        providerLeaseId: row.providerLeaseId,
        disposition: row.disposition as ReconciliationRecord["disposition"],
        resourceLabelsHash: row.resourceLabelsHash,
        keyGeneration: row.keyGeneration,
        cleanupOutcome: row.cleanupOutcome,
        reason: row.reason,
      }));
    },

    // BLOCKER E — these three no longer delegate to the reconciler's drizzle store (see
    // the file header). They read the SAME rows with the SAME predicates, through the
    // owner-owned SECURITY DEFINER function, on the pool that is actually allowed to.
    // MIG-010 Unit 2.4b — the completed-pass marker (migration 0269).
    //
    // ★ A DIRECT TABLE READ, not a definer function, and that is not an inconsistency.
    // `aoa_operator` holds SELECT on `legacy_reconciliation_passes` outright (0269), exactly
    // as it does on the crosswalk that `listRecords` below reads directly. A definer function
    // exists where the operator role holds NO grant — `environment_leases`, `companies`,
    // `runtime_provider_keys`, `company_secret_versions` — and minting one here would add a
    // certified surface for a table the caller may already read.
    //
    // ★★★ FRESHNESS IS DECIDED IN SQL, ON BOTH SIDES. `now()` and `snapshot_at` are both
    // database values; only the BOUND crosses from TypeScript, and a bound is a duration, not
    // an instant, so it carries no clock. Comparing `snapshot_at` against a JavaScript `Date`
    // here would reintroduce the two-clock bug design section 3.3 exists to close (section
    // 11.4 flags this specific implementation as the obvious wrong one).
    //
    // "Latest" is ordered by `completed_at` — literally section 11.4's "latest COMPLETED
    // pass" — with `snapshot_at` and `id` as deterministic tiebreaks so two markers written in
    // the same millisecond cannot make the gate answer differently on consecutive reads.
    latestCompletedPass: async (
      organizationId: string,
      companyId: string,
      maxAgeSeconds: number,
    ): Promise<CanaryPreflightPassMarker | null> => {
      const result = await db.execute(sql`
        SELECT m.snapshot_at,
               m.key_generation,
               (now() - m.snapshot_at) > make_interval(secs => ${maxAgeSeconds}) AS stale,
               EXTRACT(EPOCH FROM (now() - m.snapshot_at))::float8 AS age_seconds
        FROM legacy_reconciliation_passes m
        WHERE m.company_id = ${companyId}::uuid
          AND m.organization_id = ${organizationId}::uuid
        ORDER BY m.completed_at DESC, m.snapshot_at DESC, m.id DESC
        LIMIT 1`);
      const row = rowsOf<{
        snapshot_at: Date | string;
        key_generation: string;
        stale: boolean;
        age_seconds: unknown;
      }>(result)[0];
      // NO MARKER IS NOT AN ERROR — it is "this Company has never been reconciled", which the
      // gate turns into `reconciliation_stale`. Returning null keeps that a policy answer
      // rather than an unfalsifiable `preflight_error`.
      if (!row) return null;
      return {
        snapshotAt: row.snapshot_at instanceof Date ? row.snapshot_at : new Date(row.snapshot_at),
        keyGeneration: row.key_generation,
        stale: row.stale,
        // EXPLICIT conversion. `float8` and `bigint` both arrive as strings from this driver
        // (measured in mig-010-unit-2-4-probes.integration.test.ts), and a bare comparison on
        // a string is the silent bug design section 11.1 names.
        ageSeconds: Number(row.age_seconds),
      };
    },

    listLeases: async (
      organizationId: string,
      companyId: string,
      watermark: Date,
    ): Promise<CanaryPreflightLeaseInventory> => {
      const inventory = await readCanaryPreflightLeaseInventory(
        db,
        organizationId,
        companyId,
        watermark,
      );
      // The gate consumes ONLY `lease.id`: `inventoryKeysForCompany` maps
      // `resourceKeyForLease(lease.id)`, and `resourceKeyForLease` is the identity function.
      // The other twelve fields on LegacyLeaseInput serve the reconciler's classifier, which
      // this gate never runs. `cli-006-canary-preflight.test.ts` pins that narrowing.
      //
      // ★ THE TOTAL IS CARRIED THROUGH, not dropped here. Section 11.4 measured that a caller
      // projecting by name off a widened `RETURNS TABLE` silently loses the new column with no
      // error, so the store returns BOTH facts and the churn arm cannot be lost one edit at a
      // time.
      return {
        leases: inventory.leaseIds.map((id) => ({ id }) as LegacyLeaseInput),
        unnarrowedTotal: inventory.unnarrowedTotal,
      };
    },
    platformDefaultEnv: async (organizationId: string, companyId: string) => {
      const scalars = await readCanaryPreflightScalars(db, organizationId, companyId);
      return scalars.platformDefaultEnvironmentId
        ? { environmentId: scalars.platformDefaultEnvironmentId }
        : null;
    },
    currentKeyGeneration: async (organizationId: string, companyId: string) => {
      const scalars = await readCanaryPreflightScalars(db, organizationId, companyId);
      return scalars.keyGeneration;
    },
  };
}
