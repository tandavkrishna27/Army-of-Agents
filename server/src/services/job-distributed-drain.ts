// server/src/services/job-distributed-drain.ts
//
// CLI-005 (D4) — the flag-disable drain: the per-org active-attempt iterator that,
// on disable/rollback, cancels every non-terminal distributed attempt so no active
// attempt is left executing (or executable) after the rollout is turned off.
//
// It reuses the org enumerator (`listAdmittedOrganizationIds`, index.ts) and, per org,
// enumerates the non-terminal attempts and cancels each ONE-BY-ONE through the
// fence-revoking `requestCancellation` (JOB-006). It is NOT a bulk UPDATE: a late worker
// result for a revoked fence is rejected `stale_fence` by the guarded mutators.
//
// Rollback safety (Invariant 6/7, MIG-009): before draining an org it resolves EVERY
// Company under the Organization and consults the per-Company `assertRollbackSafe` for
// each — if an authoritative-cost receipt is still pending for ANY Company (including a
// SIBLING of the one an attempt belongs to), that org's whole drain step is REFUSED
// (skipped), so a committed charge can never be erased by the disable pass. The gate is
// per-Company because an Organization holds many Companies and the receipt authority the
// bridges own is Company-keyed; an org-keyed gate would either miss a sibling Company's
// pending receipt (fail-open) or, against the real bridges, resolve no Company→Org edge
// for an org id and throw for every org (fail-closed — a dead cancel-nothing lever).
//
// ★ The gate is currently FORWARD-LOOKING. The live budget-cost bridge writes the
// `authoritative_cost` receipt with status `applied` ATOMICALLY with the charge (one tenant
// transaction), so no durable `pending` authoritative-cost window exists in production today —
// `assertRollbackSafe`'s pending-count is always 0 and never throws on the real path. The
// IMMEDIATE production value of the per-Company grain fix is therefore eliminating the
// org-keyed DEAD LEVER (the pre-fix drain, wired, would throw at Company→Org resolution and
// cancel nothing on every run); today a committed charge is un-erasable by charge atomicity +
// the fact that `requestCancellation` only UPDATEs status (never deletes a cost_events row or
// its receipt). The gate becomes load-bearing the moment a two-phase pending→applied
// authoritative-cost projection is introduced — and it is proven correct against a seeded
// pending receipt in the integration test.
//
// Given the static flag model, disable is env+restart-driven with this explicit drain
// pass at teardown/admin trigger (a runtime toggle that drains without a bounce is a
// documented follow-up).

import type {
  CancellationOutcome,
  CancellationStatus,
} from "@armyofagents/db";

/** One non-terminal distributed attempt to cancel, keyed by its job identity. */
export interface DistributedExecutionActiveAttempt {
  readonly organizationId: string;
  readonly companyId: string;
  readonly jobId: string;
}

export interface DistributedExecutionDrainDeps {
  /** Page through admitted organizations (reuses index.ts:listAdmittedOrganizationIds). */
  listAdmittedOrganizationIds(input: {
    afterOrganizationId: string | null;
    limit: number;
    statementTimeoutMs: number;
  }): Promise<string[]>;
  /** Resolve every Company under ONE Organization (reuses the canary-preflight primitive).
   * The rollback gate asserts safety per Company, so an org that resolves to zero Companies
   * has no attempts to drain and records a clean no-op. */
  listOrganizationCompanyIds(organizationId: string): Promise<readonly string[]>;
  /** Enumerate the non-terminal attempts for ONE org (the missing per-org iterator). */
  listActiveAttempts(organizationId: string): Promise<DistributedExecutionActiveAttempt[]>;
  /** Fence-revoking graceful cancel of ONE job (JOB-006 requestCancellation). Deliberately
   * narrower than the repo's `RequestCancellationInput`: the wiring adapter (REL-005) must
   * supply a STABLE `commandId` derived from the jobId (mirroring the budget bridge's
   * `commandId: input.fence.jobId`) plus `now`, so a drain re-run dedups to ONE cancel
   * command per job — a per-call random id would queue duplicate cancels and break the
   * idempotent re-run this drain relies on. */
  requestCancellation(input: {
    organizationId: string;
    companyId: string;
    jobId: string;
    reason: string;
    graceful: boolean;
  }): Promise<CancellationOutcome>;
  /** Refuse (throw) the drain while an authoritative-cost receipt is pending for THIS
   * Company. Keyed by Company, matching every concrete bridge implementation. */
  assertRollbackSafe(companyId: string): Promise<void>;
}

export interface DistributedExecutionDrainResult {
  readonly organizationsScanned: number;
  readonly cancelled: number;
  readonly skippedOrganizations: string[];
  readonly perOrganization: Array<{
    readonly organizationId: string;
    readonly skipped: boolean;
    readonly reason?: string;
    readonly cancelled: number;
  }>;
}

export interface DistributedExecutionDrain {
  drainAll(options?: {
    pageSize?: number;
    statementTimeoutMs?: number;
    reason?: string;
  }): Promise<DistributedExecutionDrainResult>;
}

/** A cancellation request that reached a requested/cancelled state counts as drained.
 * `not_found` / `job_terminal` are already-terminal → nothing to drain. */
const DRAINED_STATUSES: ReadonlySet<CancellationStatus> = new Set<CancellationStatus>([
  "queued",
  "already_requested",
  "cancelled",
  "no_active_lease",
]);

const DEFAULT_PAGE_SIZE = 32;
const DEFAULT_STATEMENT_TIMEOUT_MS = 750;
const DEFAULT_REASON = "distributed_execution_disabled";

export function createDistributedExecutionDrain(
  deps: DistributedExecutionDrainDeps,
): DistributedExecutionDrain {
  return {
    async drainAll(options = {}) {
      const pageSize = Math.max(1, Math.min(32, Math.floor(options.pageSize ?? DEFAULT_PAGE_SIZE)));
      const statementTimeoutMs = Math.max(
        1,
        Math.min(750, Math.floor(options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS)),
      );
      const reason = options.reason ?? DEFAULT_REASON;

      let afterOrganizationId: string | null = null;
      let organizationsScanned = 0;
      let cancelled = 0;
      const skippedOrganizations: string[] = [];
      const perOrganization: DistributedExecutionDrainResult["perOrganization"] = [];

      for (;;) {
        const organizationIds = await deps.listAdmittedOrganizationIds({
          afterOrganizationId,
          limit: pageSize,
          statementTimeoutMs,
        });
        if (organizationIds.length === 0) break;

        for (const organizationId of organizationIds) {
          organizationsScanned += 1;

          // Rollback-safety gate (MIG-009), per Company. FIRST resolve the org's Company
          // set — if it cannot be read we cannot prove rollback safety, so we fail CLOSED
          // (skip, never drain an org whose Company set is unknown). A separate guard from
          // the assert loop so an unreadable Company set never falls through into a drain.
          let companyIds: readonly string[];
          try {
            companyIds = await deps.listOrganizationCompanyIds(organizationId);
          } catch {
            skippedOrganizations.push(organizationId);
            perOrganization.push({
              organizationId,
              skipped: true,
              reason: "enumerate_companies_error",
              cancelled: 0,
            });
            continue;
          }

          // THEN assert rollback-safety for EVERY Company. A pending authoritative-cost
          // receipt on ANY Company — including a sibling of the one an attempt belongs to —
          // refuses the WHOLE org: do NOT enumerate or cancel any of its attempts.
          try {
            for (const companyId of companyIds) {
              await deps.assertRollbackSafe(companyId);
            }
          } catch {
            skippedOrganizations.push(organizationId);
            perOrganization.push({
              organizationId,
              skipped: true,
              reason: "rollback_pending",
              cancelled: 0,
            });
            continue;
          }

          // Enumeration + per-attempt cancellation are wrapped so a single transient
          // failure (statement timeout, tenant-resolution error) skips that attempt/org
          // and the sweep CONTINUES to the rest — it never aborts mid-fleet. Mirrors the
          // assertRollbackSafe skip-and-continue above. requestCancellation is idempotent,
          // so a later drain re-run resumes past already-terminal attempts.
          let attempts: DistributedExecutionActiveAttempt[];
          try {
            attempts = await deps.listActiveAttempts(organizationId);
          } catch {
            // Skip-and-continue, recorded in BOTH lists like the rollback/enumerate-companies
            // skips above, so a re-run trigger keying off `skippedOrganizations` sees this org.
            skippedOrganizations.push(organizationId);
            perOrganization.push({ organizationId, skipped: true, reason: "enumerate_error", cancelled: 0 });
            continue;
          }
          let orgCancelled = 0;
          for (const attempt of attempts) {
            try {
              const outcome = await deps.requestCancellation({
                organizationId: attempt.organizationId,
                companyId: attempt.companyId,
                jobId: attempt.jobId,
                reason,
                graceful: true,
              });
              if (DRAINED_STATUSES.has(outcome.status)) {
                orgCancelled += 1;
                cancelled += 1;
              }
            } catch {
              // This attempt could not be cancelled now (transient) — leave it for the next
              // drain pass and continue; a surviving non-leasable attempt causes no effect.
            }
          }
          perOrganization.push({ organizationId, skipped: false, cancelled: orgCancelled });
        }

        // Advance the cursor; termination is an EMPTY page (not a short page), so a
        // full final page still triggers one more empty-returning probe.
        afterOrganizationId = organizationIds[organizationIds.length - 1]!;
      }

      return { organizationsScanned, cancelled, skippedOrganizations, perOrganization };
    },
  };
}
