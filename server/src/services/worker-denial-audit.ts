// server/src/services/worker-denial-audit.ts
//
// DE-03 + DE-06, audit clauses — the durable record a worker-authentication or
// fence-resolution refusal leaves behind, and the sink that carries it out of
// the tenant transaction the throw unwinds.
//
// ★ WHAT MOVED, AND WHY THE FILE WAS RENAMED. This was
// `worker-fence-denial-audit.ts` and served exactly ONE throw site — the
// post-resolution tuple-integrity branch in `resolveWorkerFenceContext`, the
// only refusal in that function that had an FK-valid company in hand. Every
// other refusal in the worker-authentication family holds a token-attested
// ORGANIZATION and no company, and `activity_log.company_id` was `NOT NULL`, so
// they could not be written at all. `E0-F013` Decision 2 was ruled option (a2)
// and shipped (migration `0274_activity_log_denial_sink.sql`): `company_id` is
// nullable inside the reserved `security.denied.` namespace, a nullable
// `organization_id` sits beside it, and a partial CHECK keeps the NOT NULL
// guarantee for every product writer. THE STORAGE BLOCKER IS GONE, so this
// module now serves the organization-only refusals too and the "fence" in its
// old name had stopped being true.
//
// ★ WHAT IT DOES NOT DO — read this before citing it as a closure.
//   * DE-06 is a CONJUNCTION: "object put/get AND rejected-key attempts are
//     audited". That conjunct is untouched HERE and this module still does not
//     close DE-06 — but ★ it is no longer OPEN: on 2026-09-10
//     `artifact-object-access-audit.ts` began recording a SUCCESSFUL upload or
//     download grant as an attributable `security.object_access.*` row, so both
//     conjuncts of the audit clause hold and DE-06 has left `E0-F010`'s cohort.
//     Clause (a) — the "scoped service identity" authentication half,
//     `E0-F012` — is untouched by BOTH units, which is why DE-06's register row
//     stays `partial`.
//     *(Superseded text, kept so the correction is visible: "A SUCCESSFUL
//     download grant still presigns, parses and returns from
//     `artifact-transfer-grant.ts` writing NOTHING, at the tree's only
//     production `presignGet` call site … so DE-06 does not close".)*
//   * DE-03 is a CONJUNCTION too: "enrollment, session issue, and
//     replay-rejection are audited". Only the replay-rejection conjunct is
//     wired here. Enrollment and session issue write nothing.
//   * TWO of the nine `recordProof` refusal sites stay DOUBLY NULL and are
//     deliberately NOT wired: `worker-enrollment.ts:315`
//     (`authoritativeOrganizationId` is `string | null`) and
//     `middleware/worker-session-auth.ts` `verifyCurrent`'s `if (!recorded) fail()`,
//     whose platform branch (`claims.organizationId === null`) passes an
//     explicit `null` for a platform-scope worker. A row with neither axis is a
//     different decision from a row with one, and this unit does not take it.
//   * ONE MORE of the nine — `job-leasing.ts:1023` (lease ack) — HOLDS an
//     organization and is still NOT wired, so this module serves SIX of DE-03's
//     seven organization-attested sites, not all seven. Its refusal throws out of
//     `runInTenant`, and the FROZEN JOB-003 ack-flow contract
//     (`job-leasing-contract.test.ts`, `exactAckReturnDominance`) closes every
//     drain point outside the transaction: it requires a return whose parent IS
//     the ack method body and whose expression unwraps to the `runInTenant` call,
//     and its `unwrap` strips only `await`, parens, `as` and `!`. Wiring it needs
//     an AMENDMENT to that contract. The proving file PINS the site as recording
//     nothing rather than dropping it from the count. ★ 2026-09-14: that
//     amendment is RULED ADOPTED in hardened form (Option B,
//     docs/replatform/DECISION-REQUEST-job003-ack-drain.md); the site stays
//     unwired until the build unit lands.
//   * `resolveWorkerDeviceContext`'s AUTHORITY throws (missing authority,
//     inactive target, profile drift) are NOT wired. Only its `recordProof`
//     refusal is, because that is the site DE-03 enumerates. Its siblings are
//     the same shape as the fence resolver's and would be a straightforward
//     follow-on; they are named here rather than left to be discovered.
//
// ★ WHY A SINK RATHER THAN A DIRECT CALL. Every refusal here is a THROW out of
// `runInTenant`, so writing the row where it is decided would (a) borrow a
// second pool connection while the tenant transaction still holds the first —
// the self-deadlock `artifact-denial-audit.ts` documents — and (b) be rolled
// back with the transaction that is unwinding. So the refusing branch records
// its INTENT into a caller-owned holder, the throw propagates unchanged, and the
// caller drains the holder on the POOL handle after the transaction has closed.
//
// ★ WHAT A DRAIN COSTS THE REFUSAL PATH: nothing it can observe.
// `recordSecurityDenial` never throws, and every drain runs in a `finally`, so a
// broken recorder cannot convert a refusal into a 500 and cannot suppress the
// `JobLeasingError` the caller is about to see.
//
// ★ THE ORGANIZATION IS TOKEN-ATTESTED, NEVER OFF THE WIRE. Every
// `organizationId` written here comes from `VerifiedWorkerOperation`, i.e. out of
// the HMAC-verified, control-plane-minted session artefact
// (`middleware/worker-operation-proof.ts:47-60`), or out of a row read in the
// refusing transaction. That is the whole difference between ruled option (a2)
// and rejected option (c): a caller-supplied value would let a prober choose
// which tenant absorbs the record of its own refusal.

import type { Db } from "@armyofagents/db";
import { recordSecurityDenial } from "./security-denial-audit.js";

/** The reserved `surface` slug → `security.denied.worker_fence_resolution`. */
export const WORKER_FENCE_DENIAL_SURFACE = "worker_fence_resolution";
/** The reserved `surface` slug → `security.denied.worker_proof_replay`. */
export const WORKER_PROOF_DENIAL_SURFACE = "worker_proof_replay";
/** The reserved `surface` slug → `security.denied.worker_poll_authority` —
 * the POLL/ACK admission-authority refusals (DE-18's admission arm), distinct
 * from the fence-resolution surface because a poll presents no fence. */
export const WORKER_POLL_AUTHORITY_DENIAL_SURFACE = "worker_poll_authority";

/**
 * The reason vocabulary. Each code corresponds to exactly ONE branch in a
 * refusing control, so a reader can tell a replayed credential from a revoked
 * target from a lease that never resolved. The worker's wire answer is the
 * unchanged coarse `unauthorized` / `target_revoked` / `stale_fence` in every
 * case — the discrimination lives only in the audit row.
 *
 * `proof_replayed`        — `recordProof` returned false: the (device thumbprint,
 *                           proof id) pair was already spent. THE DE-03 code.
 * `authority_missing`     — no worker/lease authority row locked at all.
 * `authority_not_current` — an authority locked, but `ackAuthorityCurrent`
 *                           refused it under fresh database time.
 * `target_inactive`       — the placement target is absent or not `active`.
 * `profile_drift`         — `touchWorkerLeaseProfile` refused: the presented
 *                           target generation / profile no longer matches.
 * `lease_unresolved`      — `lockLeaseAckContext` matched no row for the
 *                           presented (lease, job, attempt, fence) tuple.
 * `fence_tuple_mismatch`  — the lease RESOLVED and was then rejected on a
 *                           residual conjunct the lookup does not cover
 *                           (`target_authority_key`, `provider_constraint_hash`,
 *                           or one of the defence-in-depth re-checks). This is
 *                           the ONE reason here that carries a company.
 *
 * `poll_generation_superseded` and `poll_authority_stale` are the TWO
 * classifications of the ONE poll admission-authority reject branch in
 * `job-leasing.ts:poll` — distinct from the fence-resolution siblings above (a
 * poll presents no fence), split by the classifier
 * (`pollAuthorityCurrencyIntent`, job-leasing.ts) on the ACTUAL failed
 * conjunct(s) of the 19-conjunct `authorityCurrent` composite, never the
 * composite boolean. An AUTHORITATIVE worker/target generation cutoff is
 * DE-18's "generation changes … at worker admission" → `poll_generation_superseded`,
 * DE-18. Every other authority-currency failure (stale heartbeat, membership
 * loss, status/credential drift, disabled target, request-identity mismatch) →
 * `poll_authority_stale`, filed under DE-04's worker-authority-currency arm
 * (register amendment 2026-09-13). The two post-authority data-integrity
 * refusals stay unrecorded — not an authority-currency failure, no clause to
 * serve. `details.failed` names the conjuncts that fired; the wire answer stays
 * the coarse `target_revoked`.
 */
export const WORKER_DENIAL_REASONS = [
  "proof_replayed",
  "authority_missing",
  "authority_not_current",
  "target_inactive",
  "profile_drift",
  "lease_unresolved",
  "fence_tuple_mismatch",
  "poll_generation_superseded",
  "poll_authority_stale",
  // The ACK admission-authority split, the same shape as the poll pair above and on the same
  // surface — a control-ACK's `ackAuthorityCurrent` recheck refuses `target_revoked` when the
  // worker's authority has drifted, classified per failed conjunct: an authoritative
  // worker/target generation cutoff is DE-18's `ack_generation_superseded`, every other
  // authority-currency failure is DE-04's `ack_authority_stale`. `details.operation`
  // (`control_command_ack`) distinguishes it from the poll rows on the shared surface.
  "ack_generation_superseded",
  "ack_authority_stale",
] as const;

export type WorkerDenialReason = (typeof WORKER_DENIAL_REASONS)[number];

/**
 * Surface is DERIVED from the reason, never passed in, so two sites recording
 * the same branch cannot land in two different namespaces and a query for
 * DE-03's replay rejections is one `action` predicate rather than a union.
 */
export const WORKER_DENIAL_SURFACE_BY_REASON: Record<WorkerDenialReason, string> = {
  proof_replayed: WORKER_PROOF_DENIAL_SURFACE,
  authority_missing: WORKER_FENCE_DENIAL_SURFACE,
  authority_not_current: WORKER_FENCE_DENIAL_SURFACE,
  target_inactive: WORKER_FENCE_DENIAL_SURFACE,
  profile_drift: WORKER_FENCE_DENIAL_SURFACE,
  lease_unresolved: WORKER_FENCE_DENIAL_SURFACE,
  fence_tuple_mismatch: WORKER_FENCE_DENIAL_SURFACE,
  poll_generation_superseded: WORKER_POLL_AUTHORITY_DENIAL_SURFACE,
  poll_authority_stale: WORKER_POLL_AUTHORITY_DENIAL_SURFACE,
  ack_generation_superseded: WORKER_POLL_AUTHORITY_DENIAL_SURFACE,
  ack_authority_stale: WORKER_POLL_AUTHORITY_DENIAL_SURFACE,
};

/**
 * What the refusing branch records for its caller to write once the tenant
 * transaction has unwound.
 *
 * `companyId` is `null` at every site except `fence_tuple_mismatch`: `workers`
 * and `execution_targets` carry `organization_id` only, and the lease — the one
 * row that carries `company_id` — is either not yet looked up or is precisely
 * what failed to resolve. A `null` here is a claim that NOTHING IN SCOPE
 * RESOLVES A COMPANY, never that it was inconvenient to thread. Resolving one
 * from the caller-supplied `jobId` was option (c) of the ruling and was NOT
 * taken: it would let a prober pick which of its own tenants absorbs the record.
 */
export interface WorkerDenialIntent {
  reason: WorkerDenialReason;
  /** The COMPANY axis, or `null` where the refusing control holds none. */
  companyId: string | null;
  /** The ORGANIZATION axis. Token-attested or DB-resolved; never off the wire. */
  organizationId: string;
  /** The crossing ids whose `audit` clause this row serves; `[0]` is primary.
   * Two sites serve BOTH DE-03 and DE-06 — the proof-replay throws that sit
   * inside the fence/device resolvers — and a row that named only one of them
   * would under-report one crossing's coverage. */
  crossings: string[];
  /** WHICH RESOURCE was refused. `job_lease` for the fence tuple, `worker_proof`
   * for a replay, `execution_target` for an authority/target/profile refusal. */
  entityType: string;
  entityId: string;
  /** The residual conjuncts that disagreed, for `fence_tuple_mismatch` only. */
  mismatched?: string[];
  details: Record<string, unknown>;
}

/** The caller-owned holder. A one-field object rather than a bare `let`: a `let`
 * narrows from its initializer and would read back as `never` at the drain. */
export interface WorkerDenialSink {
  intent: WorkerDenialIntent | null;
}

export function createWorkerDenialSink(): WorkerDenialSink {
  return { intent: null };
}

/**
 * The DE-03 replay-rejection intent, shared by every WIRED `recordProof` refusal
 * so six sites cannot drift into six shapes. The parameter is structural rather
 * than `VerifiedWorkerOperation` on purpose: that type lives behind
 * `job-leasing.ts`, which imports this module, and naming it here would close an
 * import cycle.
 *
 * `companyId` is null: `recordProof` refuses on the (device thumbprint, proof id)
 * unique constraint alone, before any lease — the only row carrying a company —
 * has been looked at.
 *
 * The RESOURCE is the PROOF ID, not the worker: what was refused is one spent
 * credential, and recording it is what lets an operator correlate a replay burst
 * across operations. `entity_id` carries no FK, so an id that matches no live row
 * is safe to record.
 */
/**
 * The POLL admission-arm intent for `job-leasing.ts:poll`'s authority-currency
 * `target_revoked` refusal. Built by the caller's classifier
 * `pollAuthorityCurrencyIntent`, which derives reason + crossing from the failed
 * conjunct(s): authoritative generation cutoff ⇒ `poll_generation_superseded`
 * (DE-18), any other authority-currency failure ⇒ `poll_authority_stale`
 * (DE-04's worker-authority-currency arm) (Codex P2 x4 on PR #448; DE-04 arm
 * 2026-09-13). `companyId` is null: no lease has resolved at a poll, and
 * `workers`/`execution_targets` carry `organization_id` only.
 */
export function pollAuthorityDenialIntent(
  reason: "poll_generation_superseded" | "poll_authority_stale",
  crossing: string,
  auth: {
    organizationId: string;
    workerId: string;
    targetId: string;
    targetGeneration: number;
    deviceThumbprint: string;
  },
  failed?: string[],
): WorkerDenialIntent {
  return {
    reason,
    companyId: null,
    organizationId: auth.organizationId,
    crossings: [crossing],
    entityType: "execution_target",
    entityId: auth.targetId,
    details: {
      workerId: auth.workerId,
      targetId: auth.targetId,
      targetGeneration: auth.targetGeneration,
      deviceThumbprint: auth.deviceThumbprint,
      ...(failed && failed.length > 0 ? { failed } : {}),
    },
  };
}

/**
 * The ACK admission-arm intent for `job-control-ack.ts`'s `ackAuthorityCurrent` reject — the ack
 * analogue of {@link pollAuthorityDenialIntent}, and identical in shape (org-only attribution, the
 * superseded target as the resource, `details.failed` naming the conjuncts). Built by the caller's
 * classifier `ackAuthorityCurrencyIntent`: an authoritative generation cutoff ⇒
 * `ack_generation_superseded` (DE-18), any other authority-currency failure ⇒ `ack_authority_stale`
 * (DE-04's worker-authority-currency arm). `companyId` is null: the reject fires BEFORE the lease
 * ack-context is resolved, and `workers`/`execution_targets` carry `organization_id` only.
 */
export function ackAuthorityDenialIntent(
  reason: "ack_generation_superseded" | "ack_authority_stale",
  crossing: string,
  auth: {
    organizationId: string;
    workerId: string;
    targetId: string;
    targetGeneration: number;
    deviceThumbprint: string;
  },
  failed?: string[],
): WorkerDenialIntent {
  return {
    reason,
    companyId: null,
    organizationId: auth.organizationId,
    crossings: [crossing],
    entityType: "execution_target",
    entityId: auth.targetId,
    details: {
      workerId: auth.workerId,
      targetId: auth.targetId,
      targetGeneration: auth.targetGeneration,
      deviceThumbprint: auth.deviceThumbprint,
      ...(failed && failed.length > 0 ? { failed } : {}),
    },
  };
}

export function workerProofReplayIntent(auth: {
  organizationId: string;
  workerId: string;
  targetId: string;
  targetGeneration: number;
  deviceThumbprint: string;
  proofId: string;
}): WorkerDenialIntent {
  return {
    reason: "proof_replayed",
    companyId: null,
    organizationId: auth.organizationId,
    crossings: ["DE-03"],
    entityType: "worker_proof",
    entityId: auth.proofId,
    details: {
      workerId: auth.workerId,
      targetId: auth.targetId,
      targetGeneration: auth.targetGeneration,
      deviceThumbprint: auth.deviceThumbprint,
      proofId: auth.proofId,
    },
  };
}

/**
 * Write the pending intent, if any, on a POOL-level handle. Idempotent per
 * refusal because the sink is cleared as it drains, and a no-op when nothing was
 * recorded — so a caller may (and should) drain from a `finally`.
 */
export async function drainWorkerDenial(
  db: Db,
  sink: WorkerDenialSink,
  caller: {
    /** `path/to/file.ts:symbol` — what lets an operator go from a row to a line. */
    control: string;
    /** The refused worker. `actor_id` is plain text with no FK, which is what
     * makes a machine identity with no `agents`/`auth` row usable directly. */
    workerId: string;
    /** The operation the worker was attempting, e.g. "artifact_commit". */
    operation: string;
  },
): Promise<string | null> {
  const pending = sink.intent;
  if (!pending) return null;
  sink.intent = null;
  return recordSecurityDenial(db, {
    companyId: pending.companyId,
    organizationId: pending.organizationId,
    crossing: pending.crossings[0] ?? "DE-03",
    surface: WORKER_DENIAL_SURFACE_BY_REASON[pending.reason],
    reason: pending.reason,
    // A worker is a machine identity in the execution plane: it has no row in
    // `agents` and no row in `auth`, so neither the `agent` nor the `user` actor
    // kind would be truthful.
    actorType: "system",
    entityType: pending.entityType,
    entityId: pending.entityId,
    actorId: caller.workerId,
    control: caller.control,
    details: {
      ...pending.details,
      operation: caller.operation,
      organizationId: pending.organizationId,
      workerId: caller.workerId,
      crossings: pending.crossings,
      ...(pending.mismatched ? { mismatched: pending.mismatched } : {}),
    },
  });
}
