/**
 * artifact-sweep-trigger.ts — DAT-011. When to LOOK for orphans, never what qualifies.
 *
 * ★ WHY EVENT-DRIVEN AND NOT SCHEDULED. A periodic sweep must run per organization —
 * `runInTenant` scopes every query and forced RLS filters on the tenant GUC — so a global
 * sweeper would have to ENUMERATE ORGANIZATIONS. The tenant repository boundary deliberately
 * has no unscoped reader ("a raw cross-tenant helper would sidestep the tenant context and
 * forced RLS", enforced by `tenant-repository-surface.test.ts`), and punching a hole in the
 * tenancy model for HOUSEKEEPING is a bad trade. A commit event already arrives inside the
 * right tenant context, so the trigger needs no enumeration at all.
 *
 * ★★ THIS MODULE DECIDES *WHEN TO LOOK*, NEVER *WHAT IS ELIGIBLE*. `isSweepEligible` remains
 * the single authority, and it is unchanged: strictly after `expiresAt`. In particular a
 * `stale_fence` refusal does NOT make its own object sweepable — the grant stays redeemable
 * until expiry, so a retry could still re-PUT to that key. Keeping the two separate is what
 * stops a trigger from quietly widening a deletion rule.
 *
 * ★★★ THE NEGATIVE PROPERTY THE DESIGN TURNS ON: a sweep must NEVER change a commit outcome.
 * It is best-effort and every error is swallowed. A failed sweep is litter left for next
 * time; a failed commit is lost work.
 *
 * RESIDUAL, stated rather than discovered later: an organization whose LAST artifact activity
 * produced an orphan keeps it until that organization commits again. Bounded to one org's
 * most recent orphan, and strictly better than nothing being collected ever. Triggering on
 * SUCCESSFUL commits too — not only refusals — is what keeps it to "the last orphan" rather
 * than "every orphan after the last refusal".
 */

import type { SweepReport } from "./artifact-orphan-sweeper.js";

/** Pure: has enough time passed since this organization was last swept? */
export function shouldRunSweep(input: {
  lastRunAt: Date | undefined;
  now: Date;
  intervalMs: number;
}): boolean {
  if (!input.lastRunAt) return true;
  // Strictly greater: at exactly `interval` the slot has not yet elapsed. Chosen for the same
  // reason the eligibility boundary is strict — a boundary that is ambiguous in code becomes
  // ambiguous in argument later.
  return input.now.getTime() - input.lastRunAt.getTime() > input.intervalMs;
}

export interface SweepTriggerDeps {
  runSweep(organizationId: string, now: Date): Promise<SweepReport>;
  now(): Date;
  intervalMs: number;
  onError(error: unknown, organizationId: string): void;
}

export interface SweepTrigger {
  /** Fire-and-forget. Returns immediately and never throws — for the commit path. */
  trigger(organizationId: string): void;
  /** Awaitable form, for tests and for callers that genuinely want to wait. */
  triggerAndWait(organizationId: string): Promise<void>;
}

export function createSweepTrigger(deps: SweepTriggerDeps): SweepTrigger {
  // Per-ORGANIZATION, not global: a busy org must not starve a quiet one of its sweep.
  // In memory on purpose — a restart simply re-arms every org, which is harmless.
  const lastRun = new Map<string, Date>();

  async function triggerAndWait(organizationId: string): Promise<void> {
    const now = deps.now();
    if (!shouldRunSweep({ lastRunAt: lastRun.get(organizationId), now, intervalMs: deps.intervalMs })) {
      return;
    }
    try {
      await deps.runSweep(organizationId, now);
      // ★ The slot is consumed only on SUCCESS. If it were stamped before the run, one
      // transient storage error would silence sweeping for that org for a whole interval —
      // and invisibly, because the sweep is best-effort by design.
      lastRun.set(organizationId, now);
    } catch (error) {
      deps.onError(error, organizationId);
    }
  }

  return {
    triggerAndWait,
    trigger(organizationId: string): void {
      // `void` the promise deliberately: the commit path must not await housekeeping, and
      // triggerAndWait already swallows every error, so there is nothing to reject.
      void triggerAndWait(organizationId);
    },
  };
}
