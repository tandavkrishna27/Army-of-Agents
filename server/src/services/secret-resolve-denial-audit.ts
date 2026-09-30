// server/src/services/secret-resolve-denial-audit.ts
//
// DE-29, audit clause (the wrong-owner-denial conjunct) — the durable record a
// refused execution-secret resolve leaves behind, and the sink that carries it
// out of the tenant transaction it was refused in.
//
// ★ THE ONE CHOKEPOINT. `resolveExecutionSecret`
// (`packages/db/src/repositories/tenant/job-control.ts`) throws
// `SecretResolveRejection(<reason>)` for every refusal the guarded resolve
// takes: the PRE-DECISION handle/job resolution (`unknown_ref_kind`, thrown
// coarsely when the presented handle or its job resolves no row in this
// organization's scope) and every non-admit verdict of the pure owner-routing
// decision `authorizeSecretResolve` (`job-fence.ts`) over the LOCKED
// handle/job/credential rows — sixteen enumerated machine reasons,
// `credential_owner_mismatch` and `owner_binding_incomplete` among them: the
// DE-29 threat proper, "a job requesting another owner's credential".
// ★ THE PRE-DECISION `unknown_ref_kind` ROWS BELONG HERE TOO, deliberately
// (Codex P2 on PR #447, adjudicated): a FOREIGN handle is absent-by-scoping in
// this tenant, so the absent-handle probe is exactly the cross-tenant
// wrong-owner probe DE-29 exists to see, and excluding it would blind the row
// stream to the probe class. The cost, stated rather than hidden: the
// mutator's own vocabulary reuses `unknown_ref_kind` for the pre-decision
// misses AND for the decision's invalid-ref_kind verdict, so a reader cannot
// split those two from the reason alone — that coarseness is the mutator's
// non-disclosure choice, not this recorder's. Until this unit that refusal reached
// the worker as a coarse `malformed` (correctly — the WIRE must not disclose
// which invariant tripped) and left behind ONLY the count-only, id-free
// `metrics.secretRead({outcome:"denied"})` tick that `E0-F013` files against
// DE-29 as forensically indistinguishable from a stale fence. The audit
// UPDATE inside the mutator sits AFTER the throw and never runs on a denial.
// This is the writer for that class: the audit row records the REAL reason —
// distinct codes for distinct branches — while the wire answer stays coarse.
// Non-disclosure is a property of the protocol reply, not of the tenant's own
// audit trail.
//
// ★ WHY A SINK, NOT AN IN-PLACE WRITE. The rejection is thrown inside the
// caller's `runInTenant` transaction and CAUGHT there (`secret-broker.ts`
// converts it to the coarse denied outcome and returns normally), so the
// transaction COMMITS — but `recordSecurityDenial`'s contract still demands a
// pool handle, never the transaction in flight (its FK-violation retry would
// die with 25P02 on any aborted transaction, and a write on the tenant tx
// couples the audit's fate to the transaction's). So the catch captures an
// INTENT and the caller drains it in its existing `.finally` on `appDb`, the
// same shape as `fence-denial-audit.ts`'s capture-inside flow.
//
// ★ ATTRIBUTION. By the time `resolveExecutionSecret` can throw, the fence
// context has fully resolved (`resolveWorkerFenceContext` runs first), so BOTH
// tenant axes and the whole fence identity are in hand — the same
// `FenceDenialIdentity` supertype the fence-guard recorder attributes from.
// WHO is the refused worker (`actorType: "system"`, `actorId: workerId` — a
// machine identity with no `agents`/`auth` row, the DE-06/DE-27 convention);
// WHICH RESOURCE is the presented handle (`entityType: "job_secret_handle"`,
// `entityId` the opaque handle id — the handle id is the caller's own claim
// and discloses nothing: it is recorded in the refused worker's OWN tenant).
//
// ★ PER-REFUSAL, NO COALESCE (E0-F013 Decision 1.2c). ★ IT NEVER THROWS,
// inherited from `recordSecurityDenial` — a failed insert is logged at error
// and swallowed, so the drain cannot alter the resolve outcome.

import type { Db } from "@armyofagents/db";
import { SecretResolveRejection } from "@armyofagents/db";
import type { FenceDenialIdentity } from "./fence-denial-audit.js";
import { recordSecurityDenial } from "./security-denial-audit.js";

/** The reserved `surface` slug → the action `security.denied.secret_resolve`. */
export const SECRET_RESOLVE_DENIAL_SURFACE = "secret_resolve";

/** The crossing whose `audit` clause ("… wrong-owner denials are audited") every
 * row written here serves. */
export const SECRET_RESOLVE_DENIAL_CROSSING = "DE-29";

/**
 * The caller-owned holder for the capture-inside flow: `secret-broker.ts`
 * catches the `SecretResolveRejection` INSIDE its `runInTenant` callback (it
 * converts the refusal to a coarse wire outcome rather than rethrowing), so the
 * refusal is captured where the reason and the fence identity are both in hand
 * and drained on the pool handle after the transaction closes.
 */
export interface SecretResolveDenialSink {
  intent: { reason: string; fence: FenceDenialIdentity; handleId: string } | null;
}

export function createSecretResolveDenialSink(): SecretResolveDenialSink {
  return { intent: null };
}

/**
 * Record the refusal into the sink IF `error` is a `SecretResolveRejection` — a
 * no-op otherwise, so a caller may call it unconditionally from a `catch` that
 * also handles fence and unexpected errors.
 */
export function captureSecretResolveDenial(
  sink: SecretResolveDenialSink,
  fence: FenceDenialIdentity,
  handleId: string,
  error: unknown,
): void {
  if (error instanceof SecretResolveRejection) {
    sink.intent = { reason: error.reason, fence, handleId };
  }
}

/**
 * Write the captured refusal, if any, on a POOL handle. Idempotent (the sink
 * clears as it drains), a no-op when nothing was captured, and never throws —
 * so the caller drains from its existing `.finally`.
 */
export async function drainSecretResolveDenialSink(
  db: Db,
  sink: SecretResolveDenialSink,
  caller: { control: string },
): Promise<string | null> {
  const pending = sink.intent;
  if (!pending) return null;
  sink.intent = null;
  const { fence, reason, handleId } = pending;
  return recordSecurityDenial(db, {
    companyId: fence.companyId,
    organizationId: fence.organizationId,
    crossing: SECRET_RESOLVE_DENIAL_CROSSING,
    surface: SECRET_RESOLVE_DENIAL_SURFACE,
    reason,
    actorType: "system",
    actorId: fence.workerId,
    entityType: "job_secret_handle",
    entityId: handleId,
    control: caller.control,
    details: {
      jobId: fence.jobId,
      attemptId: fence.attemptId,
      leaseId: fence.leaseId,
      targetId: fence.targetId,
      targetGeneration: fence.targetGeneration,
      operation: "secret_resolve",
      organizationId: fence.organizationId,
    },
  });
}
