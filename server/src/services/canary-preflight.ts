// server/src/services/canary-preflight.ts
//
// CLI-006 (D2) — the MIG-008 preflight that gates the FIRST live transfer of
// execution ownership for a canary Organization.
//
// Acceptance (program-design.md:794): "MIG-008 has reconciled legacy environment
// leases/resources and moved provider-control authority before the rollout flag can
// transfer the first live execution."
//
// Two facts about MIG-008 shape this module (design §2.7-8):
//
//  1. **Closure is computed, not stored.** MIG-008 persists append-only crosswalk
//     RECORDS; `assertClosure` is a pure function over inventory + records, and
//     `reconcileCompanyLegacyResources` computes closure over the records it builds
//     during a MUTATING pass (it CAS-claims paused rows and inserts). A gate cannot
//     reuse that pass. So this module RE-DERIVES closure read-only, reusing MIG-008's
//     own `assertClosure` authority rather than defining a second notion of
//     "reconciled". That also makes the gate self-healing in the safe direction: a
//     legacy lease appearing after reconciliation re-closes it.
//
//  2. **Closure is Company-scoped; the canary flag is Organization-scoped.** One
//     Organization may hold many Companies (`companies.organizationId`). Checking
//     only the run's Company would let an Organization be canaried while a sibling
//     Company's legacy leases/resources stay unreconciled — a fail-open against the
//     acceptance clause. This gate enumerates EVERY Company under the Organization
//     and requires all of them to close.
//
// Everything that is not a clean, current, complete reconciliation REFUSES, and a
// refusal is never an exception: `check` resolves to a reason the caller folds into
// the single ownership decision (`resolveRunExecutionOwner`), whose fail-safe
// direction is always "legacy executes" (Invariant 2).
//
// Deliberately NOT cached. Canary volume is low by definition, and a cache whose
// stale `true` outlived a newly-unreconciled resource would reintroduce exactly the
// fail-open this module exists to close.

import {
  assertClosure,
  resourceKeyForLease,
  resourceKeyForPlatformDefaultEnv,
  type LegacyLeaseInput,
  type ReconciliationRecord,
} from "./legacy-resource-reconciliation.js";
import { CANARY_CREDENTIAL_AUTHORITY } from "./canary-mint-authority.js";
import { UNGENERATIONED_KEY_GENERATION } from "./legacy-resource-reconciliation.js";

/**
 * ★ THE FRESHNESS BOUND (design §9.1). Reconciliation evidence has a maximum age; past it the
 * gate refuses `reconciliation_stale` and the operator re-runs the pass.
 *
 * WHY A CONSTANT IS HONEST HERE. It is a guard rail, not the mechanism. The mechanism is that
 * the operator runs the pass as PART of the cutover action — same CLI session, minutes before
 * the flip — so a stale watermark should never occur in the intended flow at all. The constant
 * exists to make the UNINTENDED flow fail closed rather than silently open, and re-running the
 * pass is cheap and idempotent, so a tight bound costs an operator one command.
 *
 * §9.1 rejected the alternatives explicitly: "no live lease may postdate the watermark" is
 * E-3 wearing a hat (any legacy traffic during the decision reshuts the gate — the exact wall
 * this unit removes), and a churn RATIO is an invented metric with a threshold nobody can
 * defend. An arbitrary constant honestly labelled beats a derived one that looks principled.
 * Precedent for a chosen-and-documented policy constant: `HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT`
 * (CLAUDE.md, D5).
 *
 * ★ NOT an `AOA_*` environment variable, deliberately: a new undocumented `AOA_*` in
 * `server/src` reds `brand-check`, and a value this load-bearing should be reviewed in a diff
 * rather than set per box.
 *
 * ★ NAME THE RESIDUAL (§9.1). INSIDE this window, a post-watermark live legacy lease IS waved
 * through without a crosswalk record. That is the intended semantics — it is current traffic
 * on the legacy path, not an unreconciled legacy resource — but it is a real widening versus
 * refusing on every lease, and the window bounds how much of it can accumulate rather than
 * eliminating it.
 */
export const RECONCILIATION_EVIDENCE_MAX_AGE_SECONDS = 60 * 60;

/**
 * SQL `IS DISTINCT FROM`, in TypeScript, with NULL treated as a VALUE rather than as unknown.
 *
 * ★ WHY THIS EXISTS AT ALL (design §13, measured against PostgreSQL 18.1). `key_generation` is
 * nullable on both sides of the comparison this gate makes, and BOTH natural implementations
 * get it wrong: SQL `<>` with current `'S2:1'` matched 2 of 3 rows — the NULL marker escaped —
 * and with current NULL matched 0 of 3, so every marker escaped. `IS DISTINCT FROM` matched
 * 3 of 3 and 2 of 3. Correct.
 *
 * The marker column is `NOT NULL` with an `'ungenerationed'` sentinel, so the NULL is already
 * unrepresentable there. This is the braces to that belt: a future nullable input cannot
 * silently re-open the hole.
 */
export function isDistinctFrom(left: string | null, right: string | null): boolean {
  if (left === null && right === null) return false;
  return left !== right;
}

/**
 * Is the marker's provider-control generation stale against the CURRENT one?
 *
 * §12: the gate compares the MARKER's generation, not each record's. The crosswalk is
 * append-only (`onConflictDoNothing` on `(company_id, resource_key)`), so a re-run cannot
 * re-tag an existing record — which meant a key rotation at ANY distance after a clean pass
 * bricked the company permanently, with no remedy in code. Comparing the marker instead makes
 * a rotation ordinary, recoverable staleness: re-run, and the new marker carries the new
 * generation while the records, which are facts about RESOURCES, are correctly left alone.
 *
 * Both sides are folded onto the sentinel first, so "this company has never had a generation"
 * compares EQUAL to a marker written when it had none — that is the §13.3 combination every
 * naive implementation gets wrong in one direction or the other.
 */
export function isMarkerGenerationStale(
  markerKeyGeneration: string,
  currentKeyGeneration: string | null,
): boolean {
  return isDistinctFrom(
    markerKeyGeneration ?? UNGENERATIONED_KEY_GENERATION,
    currentKeyGeneration ?? UNGENERATIONED_KEY_GENERATION,
  );
}

/**
 * The latest COMPLETED reconciliation pass for one Company (migration 0269's marker).
 *
 * ★ `stale` AND `ageSeconds` ARE COMPUTED IN SQL, against the database clock on BOTH sides.
 * §11.4: the obvious implementation — compare the marker to a JavaScript `Date` — reintroduces
 * the exact two-clock bug §3.3 exists to close. Only the BOUND crosses the boundary, and a
 * bound is a duration, not an instant, so it carries no clock with it.
 */
export interface CanaryPreflightPassMarker {
  /** The watermark: the DB-clock instant the pass narrowed its inventory to. */
  readonly snapshotAt: Date;
  /** Never null — the marker column is NOT NULL with an `'ungenerationed'` sentinel. */
  readonly keyGeneration: string;
  /** `now() - snapshot_at > bound`, evaluated by PostgreSQL. */
  readonly stale: boolean;
  /** `EXTRACT(EPOCH FROM (now() - snapshot_at))`, for the refusal detail. */
  readonly ageSeconds: number;
}

/** One Company's lease inventory, narrowed to a watermark, plus the unnarrowed total. */
export interface CanaryPreflightLeaseInventory {
  readonly leases: readonly LegacyLeaseInput[];
  /**
   * Every lease the Company holds, watermark or no watermark.
   *
   * ★ THE CHURN GUARD LIVES ON THIS FIELD, and it is the whole reason the definer function
   * returns ONE ROW rather than a row per match (§11.1, measured): a `RETURNS TABLE` of the
   * matches returns ZERO rows when the narrowed set is empty, so the total is unobservable
   * EXACTLY in the case it exists to detect. Without it, an ancient watermark empties the
   * inventory, `assertClosure` is satisfied vacuously, and the gate ADMITS an unreconciled
   * fleet — silently, with no error, no reason and no log (§10.1(b)).
   */
  readonly unnarrowedTotal: number;
}

/**
 * The READ-ONLY slice of MIG-008 state this gate needs. It deliberately excludes
 * `casClaimPaused` / `insertRecordIfAbsent` — the mutating half of
 * `LegacyReconciliationStore` — so the gate structurally cannot reconcile as a
 * side effect of being consulted.
 */
export interface CanaryPreflightStore {
  /** Every Company under the Organization (the org-wide scope, design §2.8). */
  listOrganizationCompanyIds(organizationId: string): Promise<readonly string[]>;
  /**
   * MIG-010 Unit 2.4b — the latest COMPLETED reconciliation pass for the Company, or null when
   * none exists. Read FIRST, and a null refuses BEFORE any lease read: the definer function
   * takes a REQUIRED watermark with no DEFAULT, so calling it without one is not a thing this
   * gate can do (design section 10.3 point 3). That keeps the loud-failure arm unreachable and
   * `preflight_error` off the reachable path.
   */
  latestCompletedPass(
    organizationId: string,
    companyId: string,
    maxAgeSeconds: number,
  ): Promise<CanaryPreflightPassMarker | null>;
  /**
   * The Company's `environment_leases` rows AT OR BEFORE the watermark, plus the unnarrowed
   * total. The watermark is what closes E7-F004: without it the gate re-derives its inventory
   * from LIVE rows, so a lease created after the pass is an unmapped key and the gate can never
   * open on a box taking legacy traffic.
   */
  listLeases(
    organizationId: string,
    companyId: string,
    watermark: Date,
  ): Promise<CanaryPreflightLeaseInventory>;
  /** The materialized platform-default env row id, or null when none exists. */
  platformDefaultEnv(organizationId: string, companyId: string): Promise<{ environmentId: string } | null>;
  /** The PERSISTED crosswalk records for the Company (MIG-008's durable evidence). */
  listRecords(companyId: string): Promise<readonly ReconciliationRecord[]>;
  /** The current per-Company key generation (MIG-008 D3 attribution tag), or null. */
  currentKeyGeneration(organizationId: string, companyId: string): Promise<string | null>;
}

export type CanaryPreflightRefusalReason =
  /** The Organization resolves to no Companies — nothing was ever reconciled. */
  | "no_companies"
  /** A Company has an unmapped, duplicated, or unattributable legacy resource. */
  | "reconciliation_incomplete"
  /** Provider-control authority has not moved, or a record predates the move. */
  | "credential_authority_not_moved"
  /**
   * MIG-010 Unit 2.4b. The reconciliation EVIDENCE is missing, too old, or was gathered under
   * a superseded provider-control authority — three ways of saying "re-run the pass". Distinct
   * from `reconciliation_incomplete`, which says a resource is genuinely unaccounted for, and
   * from `credential_authority_not_moved`, which says authority never moved at all.
   *
   * ★ ADDING THIS REDS NOTHING. There is no exhaustive switch on the reason anywhere —
   * `run-execution-owner.ts:256` just interpolates it into a string (verified) — so the type
   * system will not force any site to learn about it and will not catch a refusal condition
   * left unwritten. `cli-006-canary-preflight.test.ts` pins the reason SET for that reason.
   */
  | "reconciliation_stale"
  /** The gate could not read its own evidence. Fail closed, never assume. */
  | "preflight_error";

export type CanaryPreflightResult =
  | {
      readonly ok: true;
      readonly companyIds: readonly string[];
      /**
       * CLI-007 (E7-F001) — the Company ownership authority a canary rides at the DAT-008
       * mint, EMITTED here because this is where it is verified (`currentKeyGeneration`
       * moved, below). Present ONLY on `ok`; a refusal carries none, so a canary whose
       * provider-control authority has not moved cannot present a usable authority to the
       * mint (fail-closed by shape). See `canary-mint-authority.ts`.
       */
      readonly credentialAuthority: typeof CANARY_CREDENTIAL_AUTHORITY;
    }
  | {
      readonly ok: false;
      readonly reason: CanaryPreflightRefusalReason;
      /** The Company that closed the gate, when attributable. */
      readonly companyId: string | null;
      readonly detail: string;
    };

export interface CanaryPreflight {
  check(input: { organizationId: string }): Promise<CanaryPreflightResult>;
}

function refuse(
  reason: CanaryPreflightRefusalReason,
  companyId: string | null,
  detail: string,
): CanaryPreflightResult {
  return { ok: false, reason, companyId, detail };
}

/**
 * Re-derive the inventory a MIG-008 reconcile pass would have recorded for one
 * Company, read-only. Every lease the Company currently holds is in scope: the
 * reconcile pass records a disposition for each (live rows are `mapped`, paused
 * rows are claimed and recorded, terminal rows are `terminal_cleanup`), so a lease
 * with no persisted record means the pass has not covered it.
 */
function inventoryKeysForCompany(
  leases: readonly LegacyLeaseInput[],
  platformDefault: { environmentId: string } | null,
): string[] {
  const keys = leases.map((lease) => resourceKeyForLease(lease.id));
  if (platformDefault) keys.push(resourceKeyForPlatformDefaultEnv(platformDefault.environmentId));
  return keys;
}

export function createCanaryPreflight(deps: { store: CanaryPreflightStore }): CanaryPreflight {
  const { store } = deps;

  return {
    async check({ organizationId }) {
      try {
        const companyIds = await store.listOrganizationCompanyIds(organizationId);
        if (companyIds.length === 0) {
          return refuse(
            "no_companies",
            null,
            `Organization ${organizationId} resolves to no Companies; there is no reconciliation evidence to gate on`,
          );
        }

        for (const companyId of companyIds) {
          // (0) THE EVIDENCE ITSELF, read BEFORE anything it qualifies. A missing or expired
          // marker is not a closure question and not an authority question — it is "there is
          // no evidence to reason about", and it must refuse before the lease read because
          // that read REQUIRES a watermark (no DEFAULT, no 2-arg overload: migration 0270).
          const marker = await store.latestCompletedPass(
            organizationId,
            companyId,
            RECONCILIATION_EVIDENCE_MAX_AGE_SECONDS,
          );
          if (marker === null) {
            return refuse(
              "reconciliation_stale",
              companyId,
              `Company ${companyId} has no completed legacy reconciliation pass; ` +
                `run the reconciliation pass for this Organization and retry`,
            );
          }
          if (marker.stale) {
            return refuse(
              "reconciliation_stale",
              companyId,
              `Company ${companyId} reconciliation evidence is ${Math.round(marker.ageSeconds)}s old, ` +
                `past the ${RECONCILIATION_EVIDENCE_MAX_AGE_SECONDS}s bound; re-run the reconciliation pass`,
            );
          }

          const [inventory, platformDefault, records, keyGeneration] = await Promise.all([
            store.listLeases(organizationId, companyId, marker.snapshotAt),
            store.platformDefaultEnv(organizationId, companyId),
            store.listRecords(companyId),
            store.currentKeyGeneration(organizationId, companyId),
          ]);

          // (b) Provider-control authority. A Company with no current generation has
          // not had authority moved at all.
          //
          // ★ THIS ARM IS UNCHANGED, DELIBERATELY (design section 13.3). "No current generation
          // at all" is a different question from staleness and remains correct as it stands.
          if (keyGeneration === null) {
            return refuse(
              "credential_authority_not_moved",
              companyId,
              `Company ${companyId} has no current provider-control key generation`,
            );
          }

          // (c) ★★★ THE GENERATION COMPARISON MOVED TO THE MARKER (section 12). It used to
          // filter RECORDS:
          //   `records.filter((r) => r.keyGeneration !== null && r.keyGeneration !== current)`
          // and that was wrong twice over.
          //
          //   * PERMANENCE. The crosswalk is append-only and `insertRecordIfAbsent` is
          //     `onConflictDoNothing`, so a re-run CANNOT re-tag an existing record. Any
          //     provider-key rotation after a clean pass — by a second, a day or a month —
          //     therefore bricked that Company permanently, with no remedy in code and nothing
          //     saying so. Comparing the MARKER makes it recoverable: re-run, get a new marker.
          //   * E7-F005. The `!== null` conjunct meant a NULL-generation record was never
          //     counted as superseded, so a Company reconciled with no BYO key and then GIVEN
          //     one passed this clause VACUOUSLY — precisely the Company whose provider-control
          //     authority demonstrably moved after its evidence was gathered.
          //
          // The marker column is NOT NULL with an `ungenerationed` sentinel and the comparison
          // is `IS DISTINCT FROM`, so neither half can come back (section 13.3).
          //
          // The records keep their own `key_generation`: it is history, and rewriting shipped
          // semantics is not required to fix this. It simply stops being what the gate reads.
          if (isMarkerGenerationStale(marker.keyGeneration, keyGeneration)) {
            return refuse(
              "reconciliation_stale",
              companyId,
              `Company ${companyId} reconciliation evidence was gathered under a superseded ` +
                // The generation is `<secretId>:<version>`, i.e. a company_secrets ROW ID, and
                // this detail reaches logs through run-execution-owner.ts — a different sink
                // from the definer surface. Neither value is named.
                `provider-control key generation; re-run the reconciliation pass`,
            );
          }

          // (d) ★ THE CHURN ARM, which exists only because the read returns ONE ROW ALWAYS.
          // A narrowed inventory that is empty while the Company genuinely holds leases means
          // the pass predates the entire current fleet. Without this, `assertClosure` would be
          // satisfied VACUOUSLY over the empty inventory and the gate would ADMIT — no error,
          // no reason, no log (section 10.1(b)). The freshness bound above bounds TIME; this
          // bounds CHURN, and they catch different things: a fleet can turn over completely
          // inside the window.
          if (inventory.leases.length === 0 && inventory.unnarrowedTotal > 0) {
            return refuse(
              "reconciliation_stale",
              companyId,
              `Company ${companyId} holds ${inventory.unnarrowedTotal} legacy lease(s), none of which ` +
                `predate the reconciliation snapshot; the pass predates the entire current fleet`,
            );
          }

          // (a) Reconciliation closure, recomputed with MIG-008's own authority.
          const closure = assertClosure({
            inventoryKeys: inventoryKeysForCompany(inventory.leases, platformDefault),
            records: records.map((record) => ({
              resourceKey: record.resourceKey,
              disposition: record.disposition,
            })),
          });
          if (!closure.ok) {
            return refuse(
              "reconciliation_incomplete",
              companyId,
              `Company ${companyId} legacy reconciliation is not closed ` +
                `(unmapped=${closure.unmapped.length}, duplicates=${closure.duplicates.length}, ` +
                `unattributable=${closure.unattributable.length})`,
            );
          }
        }

        // Every Company under the Organization has closed reconciliation at a current
        // provider-control key generation — so the canary rides the Company key.
        return { ok: true, companyIds, credentialAuthority: CANARY_CREDENTIAL_AUTHORITY };
      } catch (error) {
        // Fail closed on unreadability — an unreadable gate is a closed gate.
        return refuse(
          "preflight_error",
          null,
          `canary preflight could not read its evidence: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
  };
}
