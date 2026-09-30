// server/src/services/worker-fence-context.ts
//
// DAT-002 — the shared worker-operation authentication + fence-identity resolution
// used by the artifact transfer-grant and fenced-commit services. It mirrors the
// dual-auth recheck the event-ingest / lease-renewal services already run
// (proof record → CURRENT authority recheck under fresh DB time → active target →
// lease-row resolution of the rich JOB-003 fence tuple) and returns the complete
// `ActiveFenceRequest` identity + the locked lease row.
//
// It does NOT itself gate on the active fence — the caller decides: an artifact
// UPLOAD grant + a COMMIT require a live fence (guard/commit mutator), while a
// DOWNLOAD grant is deliberately tenant-scoped + object-existence only (a committed
// artifact must stay readable after lease loss). Auth failures throw
// `JobLeasingError` (mapped to an HTTP protocol error by the route); only fence /
// verification refusals are surfaced by the caller as a `rejected` outcome.

import type { ActiveFenceRequest, TenantRepositories } from "@armyofagents/db";
import {
  ackAuthorityCurrent,
  JobLeasingError,
  type VerifiedWorkerOperation,
} from "./job-leasing.js";
import { normalizePlacementRegistryTarget } from "./execution-target-resolver.js";
import { workerProofReplayIntent, type WorkerDenialSink } from "./worker-denial-audit.js";

export interface ResolvedFenceContext {
  fenceIdentity: ActiveFenceRequest;
  /** The locked lease's resolved company/job/attempt (not on the wire) for the
   * caller's own tenant checks. */
  companyId: string;
  authorityNow: Date;
  /** DEP-011 Slice 1 (§1.4) — the locked lease's `expires_at`, surfaced so a caller can
   * bound a minted token to the lease it authorizes (`min(now + TTL, leaseDeadline)`).
   * Already validated non-null below (a null `expiresAt` is a `stale_fence` refusal).
   * Additive: artifact-commit / transfer-grant callers simply ignore it. */
  leaseDeadline: Date;
}

/** DAT-006 — the DEVICE-only authority context (no lease, no fence). Proves the worker's
 * device authority is CURRENT (proof replay, authority lock, generation cutoff, active
 * target, profile) and returns the verified target identity — but stops BEFORE the lease
 * resolution, because an orphan is a dead-fence output with no live lease. */
export interface ResolvedDeviceContext {
  organizationId: string;
  targetId: string;
  targetGeneration: number;
  authorityNow: Date;
}

/**
 * Authenticate the worker operation and resolve the presented fence identity from
 * the lease row. Throws `JobLeasingError` on any auth failure:
 *   - `unauthorized`   — replayed/duplicate proof, or missing authority
 *   - `target_revoked` — authority not current / target inactive / profile drift
 *   - `stale_fence`    — no lease matches the presented (leaseId, job, attempt, fence)
 *                        tuple pinned to the CURRENT authority/target
 * A returned context means the worker is authenticated and the fence identity is
 * fully pinned; whether the fence must additionally be ACTIVE is the caller's call.
 *
 * ★ DE-06 + DE-03, audit clauses — `denialSink` (REQUIRED). ALL SIX throw sites
 * below now record into it, and the CALLER drains it on a pool handle once this
 * transaction has unwound. Exactly ONE of the six has an FK-valid company in
 * hand — the post-resolution tuple-integrity branch, where the lease has already
 * inner-joined `job_attempts` on `company_id`. The other five hold a
 * TOKEN-ATTESTED organization and no company, and until `E0-F013` Decision 2 was
 * ruled option (a2) they could not be written at all (`activity_log.company_id`
 * was `NOT NULL`). They now write an organization-attributed, company-null row.
 * The SEVENTH throw — the absent-column split at `:144` — is deliberately NOT
 * recorded: there the company is null BY HYPOTHESIS and there is nothing to
 * attribute beyond what the sibling sites already carry.
 * See `worker-denial-audit.ts`. The parameter is required so a new caller
 * cannot silently inherit an undrained refusal.
 *
 * ★ NEITHER CROSSING CLOSES ON THIS, AND THAT IS STILL TRUE OF THIS MODULE.
 * DE-06's audit clause is a conjunction, and its `object put/get` half was
 * delivered SEPARATELY on 2026-09-10 by `artifact-object-access-audit.ts` (a
 * SUCCESSFUL grant now writes a `security.object_access.*` row), so both
 * conjuncts hold and DE-06 has left `E0-F010`'s cohort — on that unit's work
 * plus this one's, never on this one's alone. DE-06 stays `partial` in the
 * threat register for its separately-absent `authentication` clause
 * (`E0-F012`). **DE-03 is unchanged**: its clause is a conjunction too and only
 * its replay-rejection third is wired.
 * *(Superseded text, kept so the correction is visible: "its `object put/get`
 * half — a SUCCESSFUL grant — still writes nothing".)*
 */
export async function resolveWorkerFenceContext(
  repos: TenantRepositories,
  auth: VerifiedWorkerOperation,
  presented: { leaseId: string; jobId: string; attempt: number; fenceToken: string },
  maxHeartbeatAgeMs: number,
  denialSink: WorkerDenialSink,
): Promise<ResolvedFenceContext> {
  // ★ DE-06/DE-03 — the attribution the five ORGANIZATION-ONLY throws below
  // share. `companyId` is `null` because nothing in scope resolves one: `workers`
  // and `execution_targets` carry `organization_id` only, and the lease — the one
  // row with a `company_id` — is either not looked up yet or is exactly what
  // failed to resolve. Resolving it from the caller-supplied `presented.jobId`
  // was option (c) of the ruling and was NOT taken.
  const orgOnly = (
    reason: "proof_replayed" | "authority_missing" | "authority_not_current"
      | "target_inactive" | "profile_drift" | "lease_unresolved",
    entityType: string,
    entityId: string,
    extra: Record<string, unknown> = {},
  ): void => {
    denialSink.intent = {
      reason,
      companyId: null,
      organizationId: auth.organizationId,
      // The proof-replay throw serves BOTH crossings: it is DE-06's `:75` fence
      // throw AND DE-03's `worker-fence-context.ts:135` `recordProof` site.
      crossings: reason === "proof_replayed" ? ["DE-03", "DE-06"] : ["DE-06"],
      entityType,
      entityId,
      details: {
        workerId: auth.workerId,
        targetId: auth.targetId,
        targetGeneration: auth.targetGeneration,
        deviceThumbprint: auth.deviceThumbprint,
        proofId: auth.proofId,
        // What the worker PRESENTED. All four are the caller's own claim and
        // disclose nothing across the boundary — that is the point: an operator
        // reading this row can see which lease the refused worker reached for.
        presentedLeaseId: presented.leaseId,
        presentedJobId: presented.jobId,
        presentedAttempt: presented.attempt,
        ...extra,
      },
    };
  };

  const databaseNow = await repos.jobControl.currentDatabaseTime();
  await repos.workerEnrollment.cleanupExpiredProofs(databaseNow, 100);
  await repos.jobControl.cleanupExpiredOperationReceipts(databaseNow, 100);
  const proofRecorded = await repos.workerEnrollment.recordProof({
    organizationId: auth.organizationId,
    deviceThumbprint: auth.deviceThumbprint,
    proofId: auth.proofId,
    issuedAt: auth.proofIssuedAt,
    expiresAt: auth.sessionExpiresAt,
  });
  if (!proofRecorded) {
    orgOnly("proof_replayed", "worker_proof", auth.proofId);
    throw new JobLeasingError("unauthorized");
  }

  const authority = await repos.jobControl.lockWorkerLeaseAuthority({
    workerId: auth.workerId,
    targetId: auth.targetId,
  });
  const authorityNow = await repos.jobControl.currentDatabaseTime();
  if (!authority || !ackAuthorityCurrent({
    auth,
    authority,
    workerId: auth.workerId,
    databaseNow: authorityNow,
    maxHeartbeatAgeMs,
    platformPhysicalHeartbeatAt: null,
  })) {
    // ONE site, TWO codes — and therefore two reasons. The wire answer already
    // discriminates them (`unauthorized` vs `target_revoked`); the audit row now
    // does too, so a locked-but-stale authority is not filed as a missing one.
    orgOnly(
      authority ? "authority_not_current" : "authority_missing",
      "execution_target",
      auth.targetId,
    );
    throw new JobLeasingError(authority ? "target_revoked" : "unauthorized");
  }

  const target = await normalizePlacementRegistryTarget(authority.target);
  if (!target || target.status !== "active") {
    orgOnly("target_inactive", "execution_target", auth.targetId, {
      targetStatus: target?.status ?? null,
    });
    throw new JobLeasingError("target_revoked");
  }
  if (!await repos.jobControl.touchWorkerLeaseProfile({
    workerId: auth.workerId,
    targetId: auth.targetId,
    targetGeneration: auth.targetGeneration,
  })) {
    orgOnly("profile_drift", "execution_target", auth.targetId);
    throw new JobLeasingError("target_revoked");
  }

  const context = await repos.jobControl.lockLeaseAckContext({
    organizationId: auth.organizationId,
    workerId: auth.workerId,
    targetId: auth.targetId,
    targetGeneration: auth.targetGeneration,
    profileHash: auth.profileHash,
    leaseId: presented.leaseId,
    jobId: presented.jobId,
    attemptNumber: presented.attempt,
    fence: presented.fenceToken,
  });
  if (!context) {
    // The RESOURCE is the lease the worker presented — unresolved, and named as
    // such. `entity_id` has no FK, so recording an id that matched no row is
    // safe and is the only evidence of what was reached for.
    orgOnly("lease_unresolved", "job_lease", presented.leaseId);
    throw new JobLeasingError("stale_fence");
  }

  // ★ DE-06 — THE TUPLE-INTEGRITY BRANCH, SPLIT INTO ITS TWO KINDS. This was one
  // eleven-disjunct `||`; it is now the same eleven conditions in the same
  // control flow, throwing the same `stale_fence`, in two groups.
  //
  // GROUP 1 — the ABSENT-column disjuncts. These are the pre-JOB-003 kernel
  // shape (`leases.ts:28-44` leaves company/job/attempt/expiry nullable and the
  // `leases_authority_atomic_check` CHECK enforces all-or-nothing), and they are
  // taken FIRST so the recorder below reads a genuine `string` rather than an
  // asserted one. A NON-NULL ASSERTION WOULD BE WRONG HERE: the declared type is
  // `string | null`, and the reason a value is nevertheless present is a property
  // of the JOIN, not of the column — `lockLeaseAckContext` inner-joins
  // `jobAttempts` on `eq(jobAttempts.companyId, leases.companyId)` and
  // `jobAttempts.companyId` is NOT NULL, so a null-company lease never joins and
  // lands on the `!context` throw above. This group is therefore expected to be
  // unreachable in production and is deliberately NOT recorded: if it ever does
  // fire, the company is null and there is nothing FK-valid to attribute to.
  const leaseCompanyId = context.lease.companyId;
  const leaseJobId = context.lease.jobId;
  const leaseAttemptNumber = context.lease.attemptNumber;
  const leaseExpiresAt = context.lease.expiresAt;
  if (!leaseCompanyId || !leaseJobId || !leaseAttemptNumber || !leaseExpiresAt) {
    throw new JobLeasingError("stale_fence");
  }

  // GROUP 2 — the MISMATCH disjuncts: a lease that resolved against the presented
  // tuple but disagrees with the CURRENT authority/target. `company_id` is joined
  // and FK-valid by the time control is here, so this is the one refusal in this
  // function that can be attributed. Collected rather than short-circuited so the
  // record can name WHICH conjunct fired — the worker still sees only the coarse,
  // non-disclosing `stale_fence`.
  const mismatched: string[] = [];
  if (leaseJobId !== presented.jobId) mismatched.push("job_id");
  if (leaseAttemptNumber !== presented.attempt) mismatched.push("attempt_number");
  if (context.lease.targetAuthorityKey !== authority.worker.targetAuthorityKey) {
    mismatched.push("target_authority_key");
  }
  if (context.lease.targetId !== target.targetId) mismatched.push("target_id");
  if (context.lease.targetGeneration !== target.targetGeneration) {
    mismatched.push("target_generation");
  }
  if (context.lease.profileHash !== auth.profileHash) mismatched.push("profile_hash");
  if (context.lease.providerConstraintHash !== target.providerConstraintHash) {
    mismatched.push("provider_constraint_hash");
  }
  if (mismatched.length > 0) {
    denialSink.intent = {
      reason: "fence_tuple_mismatch",
      companyId: leaseCompanyId,
      organizationId: auth.organizationId,
      crossings: ["DE-06"],
      entityType: "job_lease",
      entityId: context.lease.id,
      mismatched,
      details: {
        // What the worker PRESENTED, and the job/attempt the lease actually
        // carries. Both are inside the lease's own tenant, so neither discloses
        // anything across the boundary.
        presentedJobId: presented.jobId,
        presentedAttempt: presented.attempt,
        presentedLeaseId: presented.leaseId,
        leaseJobId,
        leaseAttemptNumber,
        targetId: target.targetId,
        targetGeneration: target.targetGeneration,
      },
    };
    throw new JobLeasingError("stale_fence");
  }

  const fenceIdentity: ActiveFenceRequest = {
    organizationId: auth.organizationId,
    companyId: leaseCompanyId,
    jobId: leaseJobId,
    attemptId: context.lease.attemptId,
    attemptNumber: leaseAttemptNumber,
    leaseId: context.lease.id,
    workerId: auth.workerId,
    targetId: target.targetId,
    targetAuthorityKey: authority.worker.targetAuthorityKey,
    targetGeneration: target.targetGeneration,
    profileHash: auth.profileHash,
    providerConstraintHash: target.providerConstraintHash,
    fence: presented.fenceToken,
  };
  return { fenceIdentity, companyId: leaseCompanyId, authorityNow, leaseDeadline: leaseExpiresAt };
}

/**
 * DAT-006 — authenticate a DEVICE-scoped worker operation WITHOUT a lease/fence. It runs
 * the same CURRENT-authority recheck `resolveWorkerFenceContext` runs (proof record →
 * authority lock under a fresh DB clock → active target → profile touch) but STOPS before
 * `lockLeaseAckContext`: an orphan quarantine has no live lease, so there is nothing to
 * resolve a fence tuple against. Throws `JobLeasingError` on any auth failure —
 * `unauthorized` (replayed/duplicate proof, missing authority) or `target_revoked`
 * (authority not current / target inactive / profile drift / bumped generation). It NEVER
 * throws `stale_fence` (there is no fence): staleness is precisely why an orphan is
 * quarantined, so it can never be a refusal here.
 *
 * ★ DE-03, audit clause — `denialSink` (REQUIRED). ONLY the `recordProof` refusal
 * records into it: that is the site DE-03 enumerates as
 * `worker-fence-context.ts:321`. The THREE authority throws below it write
 * NOTHING — they are the same shape as the fence resolver's siblings, but they
 * are not in DE-03's enumeration and not on DE-06's artifact-broker path, so this
 * unit neither wired nor claimed them. The parameter is required so a third
 * caller cannot silently inherit an undrained refusal.
 */
export async function resolveWorkerDeviceContext(
  repos: TenantRepositories,
  auth: VerifiedWorkerOperation,
  maxHeartbeatAgeMs: number,
  denialSink: WorkerDenialSink,
): Promise<ResolvedDeviceContext> {
  const databaseNow = await repos.jobControl.currentDatabaseTime();
  await repos.workerEnrollment.cleanupExpiredProofs(databaseNow, 100);
  await repos.jobControl.cleanupExpiredOperationReceipts(databaseNow, 100);
  const proofRecorded = await repos.workerEnrollment.recordProof({
    organizationId: auth.organizationId,
    deviceThumbprint: auth.deviceThumbprint,
    proofId: auth.proofId,
    issuedAt: auth.proofIssuedAt,
    expiresAt: auth.sessionExpiresAt,
  });
  if (!proofRecorded) {
    // ★ DE-03 — `worker-fence-context.ts:321` in the crossing's enumeration: the
    // SECOND `recordProof` refusal in this file. Only this throw is wired here;
    // the three AUTHORITY throws below are the same shape as the fence
    // resolver's siblings but are NOT in DE-03's enumeration and are NOT part of
    // DE-06's artifact-broker path, so they still write nothing and this unit
    // does not claim them.
    denialSink.intent = workerProofReplayIntent(auth);
    throw new JobLeasingError("unauthorized");
  }

  const authority = await repos.jobControl.lockWorkerLeaseAuthority({
    workerId: auth.workerId,
    targetId: auth.targetId,
  });
  const authorityNow = await repos.jobControl.currentDatabaseTime();
  if (!authority || !ackAuthorityCurrent({
    auth,
    authority,
    workerId: auth.workerId,
    databaseNow: authorityNow,
    maxHeartbeatAgeMs,
    platformPhysicalHeartbeatAt: null,
  })) throw new JobLeasingError(authority ? "target_revoked" : "unauthorized");

  const target = await normalizePlacementRegistryTarget(authority.target);
  if (!target || target.status !== "active") throw new JobLeasingError("target_revoked");
  if (!await repos.jobControl.touchWorkerLeaseProfile({
    workerId: auth.workerId,
    targetId: auth.targetId,
    targetGeneration: auth.targetGeneration,
  })) throw new JobLeasingError("target_revoked");

  return {
    organizationId: auth.organizationId,
    targetId: target.targetId,
    targetGeneration: target.targetGeneration,
    authorityNow,
  };
}
