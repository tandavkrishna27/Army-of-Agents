// packages/db/src/repositories/tenant/lease-truth.ts
//
// DEP-011 reaper Slice B (B1) — the PURE per-lease liveness classification, kept in
// its OWN drizzle-free module so a cross-platform unit test can import it WITHOUT
// dragging drizzle-orm in (the repo's known `require(esm)` cycle under vitest, see
// CLAUDE.md Test Patterns). `job-control.ts` imports the verdict + row classifier
// from here and wraps them in the `leases ⋈ jobAttempts ⋈ executionTargets` query.
//
// Only dependency: the CLOSED terminal-attempt set from the drizzle-free `job-fence.ts`.

import { TERMINAL_ATTEMPT_STATUSES } from "./job-fence.js";

/**
 * The per-lease liveness verdict the adapter-manager's read-only lease-truth PULL
 * resolves. Classified from DURABLE, MONOTONIC columns ONLY (lease/attempt status +
 * generation) — NEVER a soon-to-expire deadline a renewal could extend:
 *   - `terminal`   — lease.status ∈ {released,expired,revoked} OR the attempt reached a
 *                    TERMINAL_ATTEMPT_STATUSES state. Irreversible.
 *   - `superseded` — the target generation moved PAST the lease's stored (immutable)
 *                    targetGeneration, or the target is `disabled` — the generation-only
 *                    half of `guardActiveFence`'s `target_revoked` cutoff. Monotonic
 *                    (generation only ever increments), so it never flips back to live.
 *   - `live`       — a row exists, is not terminal, and the target is neither disabled
 *                    nor moved past. The fail-SAFE default: any ambiguity (unmatched/
 *                    absent target, null generation) skips here rather than reaping.
 *   - `absent`     — no row for the leaseId in this tenant (unknown / wrong-tenant →
 *                    forced RLS returns zero rows). The AM client maps it to "unknown",
 *                    NEVER orphan.
 *
 * `terminal`/`superseded` are a strict SUBSET of `guardActiveFence`'s death definition —
 * the classifier can never mark dead anything the authority still renews (it only ever
 * skips something the authority already considers dead, deferring that reclaim).
 */
export type LeaseTruthVerdict = "terminal" | "live" | "superseded" | "absent";

/** The DURABLE columns the classifier decides on — the EXPLICIT projection the query
 * selects (B1-F3: no secret column, never `leases.fence`). */
export interface LeaseTruthRow {
  readonly leaseStatus: string;
  readonly leaseTargetGeneration: number | null;
  readonly attemptStatus: string;
  readonly targetDeviceGeneration: number | null;
  readonly targetStatus: string | null;
}

/**
 * The PURE per-row classifier. Positive-confirmed-death: classifies dead ONLY on
 * monotonic status/generation columns and defaults every ambiguity to `live` (skip).
 *
 * `terminal` is checked first (the most direct, unambiguous positive-death signal);
 * both `terminal` and `superseded` map to `orphan` at the AM client, so the ordering
 * is observability, not safety.
 */
export function classifyLeaseTruthRow(row: LeaseTruthRow): LeaseTruthVerdict {
  // terminal — an irreversible lease OR attempt status. `expired` STATUS is terminal
  // (renewLease requires status='active', so an expired lease renews zero rows); a
  // soon-to-expire DEADLINE is deliberately NOT consulted (a renewal could extend it).
  if (
    row.leaseStatus === "released" ||
    row.leaseStatus === "expired" ||
    row.leaseStatus === "revoked" ||
    (TERMINAL_ATTEMPT_STATUSES as readonly string[]).includes(row.attemptStatus)
  ) {
    return "terminal";
  }
  // superseded — the generation-only half of guardActiveFence's `target_revoked` cutoff.
  // ONLY on a MATCHED, non-null target generation: a disabled target, or a live target
  // whose device generation moved PAST the lease's stored (immutable) targetGeneration.
  // `>` not `!==`: generation is monotonic (only increments), so `>` equals the
  // authority's `!==` for real data while staying fail-safe against a data anomaly. An
  // unmatched/absent target (leftJoin miss → null) or a null lease generation is NOT
  // positive death — it falls through to `live` (skip), narrower than the authority.
  if (row.targetStatus === "disabled") return "superseded";
  if (
    row.leaseTargetGeneration !== null &&
    row.targetDeviceGeneration !== null &&
    row.targetDeviceGeneration > row.leaseTargetGeneration
  ) {
    return "superseded";
  }
  return "live";
}
