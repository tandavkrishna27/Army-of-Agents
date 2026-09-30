// server/src/services/fence-denial-audit.ts
//
// DE-04 + DE-18, audit clauses — the durable record a GOVERNED-FENCE refusal
// leaves behind, and the drain that carries it out of the tenant transaction the
// throw unwinds. ONE unit for two crossings, because they share ONE chokepoint.
//
// ★ THE ONE CHOKEPOINT. `guardActiveFence`
// (`packages/db/src/repositories/tenant/job-control.ts`, the JOB-004 governed-fence
// guard) is the single gate every governed mutator runs BEFORE it touches a governed
// row. It throws `JobFenceError` with one of three closed codes:
//   `stale_fence`     — no lease row matches the complete identity+fence tuple, or the
//                       lease is non-active / freshly expired against the in-SQL clock.
//   `attempt_terminal`— the attempt is already terminal (a late claim on finished work).
//   `target_revoked`  — the target's LIVE device_generation is null / differs from the
//                       lease's pinned generation, or the target is disabled — the
//                       generation cutoff.
// Until this unit those refusals reached the caller as a protocol error with NO row,
// no metric and no log line (`E0-F010` for DE-04, `E0-F013` for DE-18): a stale worker
// racing a live one and a replaced target-generation resurrecting were INDISTINGUISHABLE
// FROM TRAFFIC THAT NEVER HAPPENED. This is the writer for that class.
//
// ★ TWO CROSSINGS, ONE SURFACE, REASON-KEYED. The refusal CODE decides which crossing's
// `audit` clause a row serves — exactly the DE-27 `over_cap`/`capacity` shape (distinct
// reason arms of one surface):
//   `stale_fence` / `attempt_terminal` → DE-04 ("claim, fence-generation, and
//                    stale-claim rejection are audited").
//   `target_revoked`                   → DE-18 (the fence arm of "generation changes are
//                    audited": a replaced target generation cannot claim, and now the
//                    refusal is recorded).
// Both write the single action `security.denied.fence_guard`, so "how many governed-fence
// refusals did this tenant take" is one `action` predicate and the two mechanisms are
// still told apart by `reason` and by the `crossing` in `details`.
//
// ★ WHY A DRAIN, NOT AN IN-TRANSACTION WRITE. Every one of the ~16 governed mutators runs
// inside a tenant transaction (`runInTenant`); the repository is built over that `tx`
// (`createJobControlRepository(tx)`), and a `JobFenceError` UNWINDS it. A denial written on
// that transaction is rolled back with it, and `recordSecurityDenial`'s FK-violation retry
// (a replayed token from a torn-down organization) would fail with 25P02 on the aborted
// transaction and be swallowed. So the refusal is recorded on a POOL handle AFTER the
// tenant transaction has closed — `security-denial-audit.ts`'s header names DE-04 among the
// crossings that force this: "The fence denials will." `db` MUST be `input.appDb`, never the
// transaction that is about to reject.
//
// ★ PER-REFUSAL, NO COALESCE. One row per fence refusal, each with its own `actorId`,
// `entityId` and `details`, matching the founder-ruled reading of the deny-path audit clause
// (E0-F013 Decision 1.2c, DE-27): "each REFUSAL is durably recorded". A per-window COALESCE
// was rejected there because it drops the refusals the clause requires be recorded. Several
// governed mutators sit on loopable worker paths (lease renewal, event ingest, service
// health), so a stale/revoked worker can emit a row per attempt; write-amplification is
// bounded by the worker poll rate limit and `activity_log` retention — a pattern-wide
// property of the whole deny-path class, tracked separately (E0-F018), not a deviation here.
//
// ★ ATTRIBUTION. Unlike the DE-03 worker-authentication sites (organization only), a
// governed-fence request carries BOTH tenant axes — `organizationId` AND `companyId` are
// non-null on the `ActiveFenceRequest`/fence identity every mutator is handed — so a
// fully company-scoped row is written for every refusal. The tenant is NOT the WHO: the
// refused WORKER is, on `actorId`. A worker is a machine identity in the execution plane
// with no `agents` row and no `auth` row, so `actorType` is the truthful `"system"` and
// `actorId` is the worker id directly (`actor_id` is plain text with no FK — the same DE-06 /
// DE-27 convention). The ids are token-attested or DB-consistent, never off the wire: the
// organization is the `runInTenant` GUC the worker's HMAC-verified session established, and
// the company/lease/job/attempt ids come from the locked lease the mutator resolved. A
// cross-tenant probe therefore files its refusal under its OWN tenant (E0-F013 Decision 3 Q1).
//
// ★ IT NEVER THROWS, inherited from `recordSecurityDenial`. A failure to record must not
// convert a fence refusal into a 500 (that would hand a caller an oracle and make the audit
// path a DoS lever on the refusal path). A failed insert is logged at error and swallowed. So
// callers drain from a `finally`/`catch`-then-rethrow and the drain cannot alter the outcome.

import type { Db } from "@armyofagents/db";
import { JobFenceError, type JobFenceErrorCode } from "@armyofagents/db";
import { recordSecurityDenial } from "./security-denial-audit.js";

/** The reserved `surface` slug → the action `security.denied.fence_guard`. */
export const FENCE_GUARD_DENIAL_SURFACE = "fence_guard";

/** The reason vocabulary — exactly the closed `JobFenceErrorCode` set, so a reader can tell
 * a stale/expired claim from a terminal-attempt claim from a revoked target generation. */
export const FENCE_GUARD_DENIAL_REASONS = [
  "stale_fence",
  "attempt_terminal",
  "target_revoked",
] as const satisfies readonly JobFenceErrorCode[];

/**
 * Which crossing's `audit` clause each refusal code serves. `target_revoked` is the
 * generation-cutoff and belongs to DE-18 ("generation changes"); `stale_fence` and
 * `attempt_terminal` are the claim/stale-claim rejections and belong to DE-04. The map is
 * total over `JobFenceErrorCode`, so a future code cannot silently default to the wrong row.
 */
export const FENCE_GUARD_CROSSING_BY_REASON: Record<JobFenceErrorCode, string> = {
  stale_fence: "DE-04",
  attempt_terminal: "DE-04",
  target_revoked: "DE-18",
};

/**
 * The subset of a fence request/identity this recorder attributes from. Every fence
 * identity in the tree — the `ActiveFenceRequest` a mutator is handed, `input.fence` on the
 * governance bridges, `ctx.fenceIdentity` from `resolveWorkerFenceContext`, and the
 * `fenceIdentity` assembled in the event/ack paths — is a structural supertype of this, so
 * any of them satisfies it without a cast.
 */
export interface FenceDenialIdentity {
  /** The tenant, ORGANIZATION axis — the `runInTenant` GUC the worker session established. */
  organizationId: string;
  /** The tenant, COMPANY axis — from the locked lease, never the wire. */
  companyId: string;
  /** WHO — the refused worker. `actor_id` is plain text with no FK, so a machine identity
   * with no `agents`/`auth` row is usable directly. */
  workerId: string;
  /** WHICH RESOURCE — the lease whose fence was refused. */
  leaseId: string;
  jobId: string;
  attemptId: string;
  /** The placement target and the generation the refusal turned on (for `target_revoked`
   * legibility, and harmless context for the others). */
  targetId: string;
  targetGeneration: number;
}

/** Where a caller records this row, as `path/to/file.ts:symbol` (the control that refused)
 * and the worker operation it was refused during, e.g. "lease_renew". */
export interface FenceGuardDenialCaller {
  control: string;
  operation: string;
}

/**
 * Record ONE governed-fence refusal durably and attributably, keyed to the crossing its
 * `reason` code serves. `db` MUST be a pool handle (see the header). Returns the row id, or
 * `null` when nothing could be written (logged at error by `recordSecurityDenial`). Never
 * throws.
 */
export async function recordFenceGuardDenial(
  db: Db,
  input: { code: JobFenceErrorCode; fence: FenceDenialIdentity; caller: FenceGuardDenialCaller },
): Promise<string | null> {
  const { code, fence, caller } = input;
  return recordSecurityDenial(db, {
    // Both tenant axes are present on a fence identity — a governed-fence refusal always
    // resolves a company (the locked lease carries it), so this is never null here.
    companyId: fence.companyId,
    organizationId: fence.organizationId,
    crossing: FENCE_GUARD_CROSSING_BY_REASON[code],
    surface: FENCE_GUARD_DENIAL_SURFACE,
    reason: code,
    // A worker has no `agents` row and no `auth` row; the truthful actor kind is `system`
    // and the id is the worker id directly. The tenant is NOT the actor — it rides
    // `organizationId`/`companyId`, not `actorId`.
    actorType: "system",
    actorId: fence.workerId,
    entityType: "job_lease",
    entityId: fence.leaseId,
    control: caller.control,
    details: {
      jobId: fence.jobId,
      attemptId: fence.attemptId,
      targetId: fence.targetId,
      targetGeneration: fence.targetGeneration,
      operation: caller.operation,
      organizationId: fence.organizationId,
    },
  });
}

/**
 * Drain a governed-fence refusal a caller has just caught. A NO-OP unless `caughtError` is a
 * `JobFenceError` — so a caller may (and should) wrap its `runInTenant` in a
 * `try { … } catch (err) { await drainFenceGuardDenial(appDb, fence, err, …); throw err; }`
 * (or a `.finally`), and every non-fence rejection passes straight through unrecorded and
 * unchanged. Returns the row id, `null` when nothing was written, and never throws.
 *
 * `fence` is the identity the caller passed to the refusing mutator (`input.fence`,
 * `ctx.fenceIdentity`, or the assembled `fenceIdentity`). It is captured where the mutator is
 * called — the fence resolves before `guardActiveFence` can throw a `JobFenceError` — so by
 * the time a `JobFenceError` reaches the caller the identity is always in hand.
 */
export async function drainFenceGuardDenial(
  db: Db,
  fence: FenceDenialIdentity,
  caughtError: unknown,
  caller: FenceGuardDenialCaller,
): Promise<string | null> {
  if (!(caughtError instanceof JobFenceError)) return null;
  return recordFenceGuardDenial(db, { code: caughtError.code, fence, caller });
}

/**
 * The caller-owned holder for the CAPTURE-INSIDE flow. Several owners catch the fence
 * `JobFenceError` INSIDE the `runInTenant` callback — job-events converts it to a cumulative
 * ACK status (invariant #8), job-control-ack REMAPS it to a `JobLeasingError` — so by the
 * time the transaction has unwound the original `JobFenceError` is gone and an outer
 * `catch` can no longer type it. Those owners capture the refusal at the inner catch, where
 * the code and the fence identity are both in hand, and drain the holder on the pool handle
 * after the transaction closes. A one-field object rather than a bare `let`: TypeScript
 * narrows a `let` from its `null` initializer and would read it back as `never` at the drain.
 */
export interface FenceGuardDenialSink {
  intent: { code: JobFenceErrorCode; fence: FenceDenialIdentity } | null;
}

export function createFenceGuardDenialSink(): FenceGuardDenialSink {
  return { intent: null };
}

/**
 * Record the refusal into the sink IF `error` is a `JobFenceError` — a no-op otherwise, so a
 * caller may call it unconditionally from a `catch` that also handles non-fence errors.
 */
export function captureFenceGuardDenial(
  sink: FenceGuardDenialSink,
  fence: FenceDenialIdentity,
  error: unknown,
): void {
  if (error instanceof JobFenceError) sink.intent = { code: error.code, fence };
}

/**
 * Write the captured refusal, if any, on a POOL handle. Idempotent (the sink clears as it
 * drains) and a no-op when nothing was captured — so a caller may (and should) drain from a
 * `finally`. Never throws.
 */
export async function drainFenceGuardDenialSink(
  db: Db,
  sink: FenceGuardDenialSink,
  caller: FenceGuardDenialCaller,
): Promise<string | null> {
  const pending = sink.intent;
  if (!pending) return null;
  sink.intent = null;
  return recordFenceGuardDenial(db, { code: pending.code, fence: pending.fence, caller });
}
