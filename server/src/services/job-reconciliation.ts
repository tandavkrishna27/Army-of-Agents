// server/src/services/job-reconciliation.ts
//
// JOB-006 — the reaper/reconciliation service + the durable cancellation entrypoint.
//
// This is SERVER authority (operator/system), not a worker-fenced path. It runs the
// two convergence transactions inside `runInTenant`:
//
//   * requestCancellation — marks the requested state and queues ONE monotonically-
//     sequenced E1 cancel command bound to the current lease fence (idempotent per
//     lease). The worker learns of it on renew and through the control-ACK path.
//
//   * reapOrganization — the reaper. Under the authoritative job/attempt/lease locks
//     it PERMANENTLY revokes each expired lease's fence and converges the work to
//     exactly one of: a NEW retry attempt (attempt N+1 + its attempt-ready outbox
//     row, immutable backoff), a terminal result (succeeded/cancelled finalized), or
//     a dead-letter (retry exhausted). Bounded batch; every step is idempotent so a
//     duplicate sweep is a no-op and two concurrent creators still produce one N+1
//     attempt + one ready row (the tenant repository's job-lock + unique constraints).
//
// A late result from a disconnected worker can NEVER overwrite the winner: its fence
// is revoked, so the guarded mutators reject it as stale_fence. Reviving an expired
// fence is a non-goal — retry always mints a NEW attempt/fence (CAV-003).
//
// Ordering (cancel/expire/retry winner) inline comments live in the tenant repository
// (`repositories/tenant/job-control.ts`), the sole locker of the authoritative rows.

import { randomUUID } from "node:crypto";
import type {
  CancellationOutcome,
  Db,
  ReapExpiredLeasesResult,
} from "@armyofagents/db";
// Passive table descriptor from the always-loaded db barrel — importing it does NOT pull
// the (dormant) DEP-009 admission service/route into any module graph; it only names the
// counter table the retention sweep prunes.
import { workerAdmissionRateLimits } from "@armyofagents/db";
import { lt, sql } from "drizzle-orm";
import { runInTenant } from "../db/tenant-context.js";

// LOW (DEP-009) retention: the shared admission rate-limit counter mints one row per
// (org, 60s window). Old windows are inert (no lifecycle depends on them) but would grow
// unbounded. Prune windows older than this on the org's periodic reconciliation tick.
export const ADMISSION_RATE_WINDOW_RETENTION = sql`interval '1 hour'`;

/**
 * Best-effort retention sweep of `worker_admission_rate_limits` for ONE org, in its OWN
 * tenant transaction so a sweep error can never poison/roll back the reap. Under aoa_app
 * the org-scoped RLS policy restricts the DELETE to this org's rows; the retention window
 * (1h) is far beyond the 60s counter window, so no live counter is ever pruned. No-ops when
 * the flag is off (the table only accumulates rows on the flag-on worker-control path).
 */
async function sweepAdmissionRateWindows(appDb: Db, organizationId: string): Promise<void> {
  await runInTenant(appDb, organizationId, async (_repos, tx) => {
    await tx
      .delete(workerAdmissionRateLimits)
      .where(lt(workerAdmissionRateLimits.windowStart, sql`now() - ${ADMISSION_RATE_WINDOW_RETENTION}`));
  });
}

/** Server retry backoff policy. The reaper writes an immutable per-attempt backoff
 * (exponential: base * 2^(N-1), capped at max) so retry N+1 is not dispatched before
 * it. Both bounds are configurable; the defaults are conservative. */
export const DEFAULT_RETRY_BASE_BACKOFF_MS = 5_000;
export const DEFAULT_RETRY_MAX_BACKOFF_MS = 300_000;
/** Bounded reaper batch per organization tick (mirrors the outbox worker's bound). */
export const DEFAULT_REAP_BATCH_LIMIT = 32;

export interface RequestCancellationServiceInput {
  organizationId: string;
  companyId: string;
  jobId: string;
  reason: string;
  graceful: boolean;
  /** Optional stable command id for an idempotent retry of the SAME cancellation. */
  commandId?: string;
}

export interface JobReconciliationService {
  requestCancellation(input: RequestCancellationServiceInput): Promise<CancellationOutcome>;
  reapOrganization(
    organizationId: string,
    options?: { limit?: number },
  ): Promise<ReapExpiredLeasesResult>;
}

export function createJobReconciliationService(input: {
  appDb: Db;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  reapBatchLimit?: number;
}): JobReconciliationService {
  const baseBackoffMs = Math.max(0, Math.floor(input.baseBackoffMs ?? DEFAULT_RETRY_BASE_BACKOFF_MS));
  const maxBackoffMs = Math.max(
    baseBackoffMs,
    Math.floor(input.maxBackoffMs ?? DEFAULT_RETRY_MAX_BACKOFF_MS),
  );
  const reapBatchLimit = Math.max(1, Math.min(128, Math.floor(input.reapBatchLimit ?? DEFAULT_REAP_BATCH_LIMIT)));

  return {
    async requestCancellation(cancelInput) {
      return runInTenant(input.appDb, cancelInput.organizationId, async (repos) => {
        const now = await repos.jobControl.currentDatabaseTime();
        return repos.jobControl.requestCancellation({
          organizationId: cancelInput.organizationId,
          companyId: cancelInput.companyId,
          jobId: cancelInput.jobId,
          reason: cancelInput.reason,
          graceful: cancelInput.graceful,
          commandId: cancelInput.commandId ?? randomUUID(),
          now,
        });
      });
    },

    async reapOrganization(organizationId, options) {
      const limit = Math.max(1, Math.min(128, Math.floor(options?.limit ?? reapBatchLimit)));
      const result = await runInTenant(input.appDb, organizationId, async (repos) => {
        // A FRESH database clock anchors the immutable backoff (never JavaScript time).
        const now = await repos.jobControl.currentDatabaseTime();
        return repos.jobControl.reapExpiredLeases({
          organizationId,
          now,
          limit,
          baseBackoffMs,
          maxBackoffMs,
        });
      });
      // LOW (DEP-009): best-effort admission-rate-window retention sweep on this org's
      // periodic tick. Its OWN txn + swallowed error so it never fails/rolls back the reap.
      await sweepAdmissionRateWindows(input.appDb, organizationId).catch(() => {});
      return result;
    },
  };
}
