// server/src/services/execution-target-revocation-fanout.ts
//
// JOB-007 — the durable, resumable target-revocation fanout worker.
//
// The committed generation cutoff (execution-targets.ts revokeExecutionTarget)
// already DENIES every old-generation governed effect through the fence guard's
// current-generation recheck. This worker is CONVERGENCE only: it walks the durable
// operator records and, SEPARATELY per admitted Organization under `runInTenant`,
// marks matching old-generation leases `revoked`, releases their capacity claim, and
// requests attempt cancellation (reusing the JOB-006 cancellation entrypoint). It
// never re-homes or re-places work — the placement is pinned to the revoked target
// and fallback beyond the immutable placement policy is a non-goal, so revoked work
// is cancelled, not re-woken.
//
// Idempotent + resumable: a crash mid-fanout leaves the record `converging`; the next
// tick re-reads it (status pending/converging) and re-runs every step (each is a
// conditional no-op once applied), so it converges every matching tenant lease
// exactly once no matter how many times it runs.

import { and, asc, eq, inArray, lte, notExists, notInArray, sql } from "drizzle-orm";
import {
  executionTargetRevocations,
  jobAttempts,
  leases,
  TERMINAL_ATTEMPT_STATUSES,
  type Db,
} from "@armyofagents/db";
import { runInTenant } from "../db/tenant-context.js";
import { releaseAttemptCapacity } from "./org-concurrency.js";
import { ensureExecutionTargetCutoff } from "./execution-targets.js";
import type { JobReconciliationService } from "./job-reconciliation.js";

export interface ExecutionTargetRevocationFanoutTickResult {
  records: number;
  organizations: number;
  leasesRevoked: number;
  cancellations: number;
  completed: number;
}

const ZERO_TICK: ExecutionTargetRevocationFanoutTickResult = {
  records: 0, organizations: 0, leasesRevoked: 0, cancellations: 0, completed: 0,
};

export interface ExecutionTargetRevocationFanout {
  tick(): Promise<ExecutionTargetRevocationFanoutTickResult>;
}

export function createExecutionTargetRevocationFanout(input: {
  appDb: Db;
  operatorDb: Db;
  /** Reused for its idempotent `requestCancellation` (no-live-lease → finalize cancelled). */
  reconciliation: Pick<JobReconciliationService, "requestCancellation">;
  /** Admitted Organizations to converge for a PLATFORM target (fans out to all). An
   * organization/owner target converges only its owning Organization. */
  listAdmittedOrganizationIds: () => Promise<string[]>;
  enabled?: boolean;
  recordBatchLimit?: number;
}): ExecutionTargetRevocationFanout {
  const enabled = input.enabled ?? true;
  const recordBatchLimit = Math.max(1, Math.min(128, Math.floor(input.recordBatchLimit ?? 16)));

  /** Converge ONE Organization's stale leases for one revoked target generation. */
  async function convergeOrganization(input2: {
    organizationId: string;
    targetId: string;
    revokedGeneration: number;
  }): Promise<{ leasesRevoked: number; jobs: Array<{ companyId: string; jobId: string }> }> {
    // Phase 1 (in the owning tenant): mark every matching old-generation live lease
    // `revoked`, release its capacity claim (one conditional held->released), and
    // collect the affected (company, job) tuples to cancel.
    //
    // The selection INCLUDES leases already in `revoked` (not just offered/active) so a
    // crash-resumed tick — where a prior tick's Phase 1 committed the lease flip but the
    // process died before Phase 2 requested job cancellation — STILL re-derives the
    // cancellation intent from durable lease state. Without this, the resumed tick would
    // no longer see the already-`revoked` lease, never call requestCancellation, and mark
    // the record `completed` with the job stranded non-terminal forever (the reaper only
    // scans offered/active leases). requestCancellation is idempotent, so re-collecting a
    // job whose cancellation already finalized is a safe no-op. A freshly-flipped lease
    // (offered/active -> revoked) is counted + capacity-released exactly once; an
    // already-`revoked` lease is only re-collected for cancellation (no re-flip, no
    // double-release).
    const marked = await runInTenant(input.appDb, input2.organizationId, async (_repos, tx) => {
      const stale = await tx
        .select({
          id: leases.id,
          companyId: leases.companyId,
          jobId: leases.jobId,
          attemptId: leases.attemptId,
          status: leases.status,
        })
        .from(leases)
        .where(and(
          eq(leases.targetId, input2.targetId),
          lte(leases.targetGeneration, input2.revokedGeneration),
          inArray(leases.status, ["offered", "active", "revoked"]),
        ))
        .for("update", { skipLocked: true });
      const jobs: Array<{ companyId: string; jobId: string }> = [];
      let revoked = 0;
      for (const lease of stale) {
        if (lease.status !== "revoked") {
          const [flipped] = await tx
            .update(leases)
            .set({
              status: "revoked",
              releasedAt: sql`clock_timestamp()`,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(and(eq(leases.id, lease.id), inArray(leases.status, ["offered", "active"])))
            .returning({ id: leases.id });
          if (!flipped) continue;
          revoked += 1;
          if (lease.attemptId) {
            await releaseAttemptCapacity(tx, {
              attemptId: lease.attemptId,
              organizationId: input2.organizationId,
            });
          }
        }
        // Collect the job for cancellation for BOTH the freshly-flipped lease and an
        // already-`revoked` lease resumed after a Phase-2 crash.
        if (lease.companyId && lease.jobId) {
          jobs.push({ companyId: lease.companyId, jobId: lease.jobId });
        }
      }

      // Phase 1b (SAME tx): the lease pass above converges ONLY attempts that still
      // have a live offered/active/revoked lease. It cannot see a LEASE-LESS attempt
      // pinned to the revoked target — precisely the row the MIG-002 reaper mints when
      // it reaps an expired lease and `allocateRetry` copies the revoked target's
      // placement (placementTargetId/placementTargetGeneration) VERBATIM into a NEW
      // `pending`, lease-less attempt, minted `capacityClaimState:'held'` when the
      // reaped attempt was held. That successor can never lease (offerLease pins the
      // stored generation; the resolver returns null for the bumped/disabled target),
      // so guardActiveFence's `target_revoked` never fires, and countHeldAttemptsForOrg
      // — which counts `held` with NO status filter — pins an org slot forever. Nothing
      // else reaps a lease-less nonterminal attempt. Converge those here: terminalize to
      // `cancelled` (mirroring the reaper's cancel terminal), release the held slot with
      // the SAME helper the lease pass uses, and hand the job to the SAME Phase-2
      // cancellation. The `notExists` live-lease filter excludes every attempt the lease
      // pass already handled, so capacity is never double-released. FOR UPDATE SKIP
      // LOCKED gives the same idempotence/crash-safety as the lease pass; a resumed tick
      // no longer sees the now-`cancelled` (terminal) attempt, so each converges once.
      const stranded = await tx
        .select({
          id: jobAttempts.id,
          companyId: jobAttempts.companyId,
          jobId: jobAttempts.jobId,
        })
        .from(jobAttempts)
        .where(and(
          eq(jobAttempts.organizationId, input2.organizationId),
          eq(jobAttempts.placementTargetId, input2.targetId),
          lte(jobAttempts.placementTargetGeneration, input2.revokedGeneration),
          notInArray(jobAttempts.status, [...TERMINAL_ATTEMPT_STATUSES]),
          notExists(
            tx
              .select({ one: sql`1` })
              .from(leases)
              .where(and(
                eq(leases.organizationId, input2.organizationId),
                eq(leases.attemptId, jobAttempts.id),
                inArray(leases.status, ["offered", "active", "revoked"]),
              )),
          ),
        ))
        .for("update", { skipLocked: true });
      for (const attempt of stranded) {
        // Terminalize FIRST under the same nonterminal guard the reaper uses — the
        // conditional makes it a no-op for any attempt a concurrent/resumed pass already
        // terminalized, so the capacity release below runs exactly once per real flip.
        const [terminalized] = await tx
          .update(jobAttempts)
          .set({ status: "cancelled", updatedAt: sql`clock_timestamp()` })
          .where(and(
            eq(jobAttempts.id, attempt.id),
            eq(jobAttempts.organizationId, input2.organizationId),
            notInArray(jobAttempts.status, [...TERMINAL_ATTEMPT_STATUSES]),
          ))
          .returning({ id: jobAttempts.id });
        if (!terminalized) continue;
        // Release the held Organization slot (idempotent 'held' -> 'released'); the same
        // helper the lease pass calls, so the exactly-once release semantics hold.
        await releaseAttemptCapacity(tx, {
          attemptId: attempt.id,
          organizationId: input2.organizationId,
        });
        if (attempt.companyId && attempt.jobId) {
          jobs.push({ companyId: attempt.companyId, jobId: attempt.jobId });
        }
      }
      return { revoked, jobs };
    });
    return { leasesRevoked: marked.revoked, jobs: marked.jobs };
  }

  async function runTick(): Promise<ExecutionTargetRevocationFanoutTickResult> {
    if (!enabled) return { ...ZERO_TICK };
    const result: ExecutionTargetRevocationFanoutTickResult = { ...ZERO_TICK };
    // The fanout driver reads the durable records on the OPERATOR connection.
    const records = await input.operatorDb
      .select()
      .from(executionTargetRevocations)
      .where(inArray(executionTargetRevocations.status, ["pending", "converging"]))
      .orderBy(asc(executionTargetRevocations.createdAt), asc(executionTargetRevocations.id))
      .limit(recordBatchLimit);

    for (const record of records) {
      result.records += 1;
      // Re-ensure the cutoff first (idempotent; recovers a crash between the durable
      // record write and the cutoff commit).
      await ensureExecutionTargetCutoff({
        appDb: input.appDb,
        operatorDb: input.operatorDb,
        targetId: record.targetId,
        organizationId: record.organizationId,
        revokedGeneration: record.revokedGeneration,
      });
      await input.operatorDb
        .update(executionTargetRevocations)
        .set({ status: "converging", updatedAt: sql`clock_timestamp()` })
        .where(eq(executionTargetRevocations.id, record.id));

      const organizationIds = record.organizationId
        ? [record.organizationId]
        : [...new Set(await input.listAdmittedOrganizationIds())].sort();

      let lastCursor = record.scanCursor ?? null;
      const jobsToCancel: Array<{ organizationId: string; companyId: string; jobId: string }> = [];
      for (const organizationId of organizationIds) {
        result.organizations += 1;
        const converged = await convergeOrganization({
          organizationId,
          targetId: record.targetId,
          revokedGeneration: record.revokedGeneration,
        });
        result.leasesRevoked += converged.leasesRevoked;
        for (const job of converged.jobs) {
          jobsToCancel.push({ organizationId, companyId: job.companyId, jobId: job.jobId });
        }
        lastCursor = organizationId;
        await input.operatorDb
          .update(executionTargetRevocations)
          .set({ scanCursor: lastCursor, updatedAt: sql`clock_timestamp()` })
          .where(eq(executionTargetRevocations.id, record.id));
      }

      // Phase 2: request cancellation per affected job (idempotent — the lease is
      // already revoked, so requestCancellation finds no live lease and finalizes the
      // job cancelled directly).
      const seen = new Set<string>();
      for (const job of jobsToCancel) {
        const key = `${job.organizationId}:${job.jobId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        await input.reconciliation.requestCancellation({
          organizationId: job.organizationId,
          companyId: job.companyId,
          jobId: job.jobId,
          reason: "target_revoked",
          graceful: false,
        });
        result.cancellations += 1;
      }

      await input.operatorDb
        .update(executionTargetRevocations)
        .set({ status: "completed", scanCursor: lastCursor, updatedAt: sql`clock_timestamp()` })
        .where(eq(executionTargetRevocations.id, record.id));
      result.completed += 1;
    }
    return result;
  }

  return { tick: runTick };
}
