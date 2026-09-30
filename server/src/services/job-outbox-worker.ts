import { randomUUID } from "node:crypto";
import type { Db } from "@armyofagents/db";
import { runInTenant } from "../db/tenant-context.js";
import type { JobReadyScheduler, JobReadySignal } from "./job-ready-scheduler.js";
import { NOOP_JOB_CONTROL_METRICS, type JobControlMetrics } from "./job-control-metrics.js";

export interface AdmittedOrganizationPageInput {
  afterOrganizationId: string | null;
  limit: number;
  statementTimeoutMs: number;
}

export interface JobOutboxTickResult {
  organizations: number;
  claimed: number;
  delivered: number;
  cleaned: number;
}

type ClaimedRow = { id: string; organizationId: string; targetId: string; attemptId: string };

// Thrown by the per-statement budget wrapper when the immutable tick deadline is reached, so the
// enclosing tenant transaction rolls back without issuing SET LOCAL or the following statement.
class DeadlineReached extends Error {}

function isStatementTimeout(error: unknown): boolean {
  // Drizzle may wrap the driver error, so the 57014 statement-timeout code can sit on the error
  // or anywhere in its cause chain.
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth += 1) {
    if ((current as { code?: unknown }).code === "57014") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function createJobOutboxWorker(input: {
  appDb: Db;
  scheduler: JobReadyScheduler;
  listAdmittedOrganizationIds: (input: AdmittedOrganizationPageInput) => Promise<string[]>;
  publishHint?: (signal: JobReadySignal) => Promise<void>;
  visibilityTimeoutMs?: number;
  maxOrganizationShards?: number;
  maxRowsPerShard?: number;
  tickBudgetMs?: number;
  monotonicNow?: () => number;
  metrics?: JobControlMetrics;
  cleanupLimit?: number;
  cleanupCardinalityLimit?: number;
}) {
  const maxOrganizations = Math.max(1, Math.min(32, Math.floor(input.maxOrganizationShards ?? 32)));
  const maxRows = Math.max(1, Math.min(128, Math.floor(input.maxRowsPerShard ?? 32)));
  const visibilityTimeoutMs = Math.max(1, Math.floor(input.visibilityTimeoutMs ?? 30_000));
  const tickBudgetMs = Math.max(1, Math.min(750, Math.floor(input.tickBudgetMs ?? 750)));
  const cleanupLimit = Math.max(1, Math.floor(input.cleanupLimit ?? 256));
  const cleanupCardinalityLimit = Math.max(1, Math.floor(input.cleanupCardinalityLimit ?? 4_096));
  const monotonicNow = input.monotonicNow ?? (() => performance.now());
  const metrics = input.metrics ?? NOOP_JOB_CONTROL_METRICS;
  const publish = input.publishHint ?? (async (signal: JobReadySignal) => {
    if (!input.scheduler.signal(signal)) throw new Error("job_ready_scheduler_full");
  });
  type PendingClaim = {
    claimToken: string;
    rows: Array<{ id: string; organizationId: string; targetId: string }>;
  };
  // Retain only the current bounded rotation window. This permits prompt
  // same-process retry after publication rejection; eviction or process loss
  // is harmless because the durable visibility-timeout claim remains canonical.
  const pendingClaims = new Map<string, PendingClaim>();
  let cursor: string | null = null;
  let inFlight: Promise<JobOutboxTickResult> | null = null;

  function remainingBudget(deadline: number): number {
    return Math.max(0, Math.floor(deadline - monotonicNow()));
  }

  async function listPage(
    afterOrganizationId: string | null,
    limit: number,
    deadline: number,
  ): Promise<string[] | null> {
    const remaining = remainingBudget(deadline);
    if (remaining < 1) return null;
    const rows = await input.listAdmittedOrganizationIds({
      afterOrganizationId,
      limit,
      statementTimeoutMs: remaining,
    });
    return [...new Set(rows)]
      .sort()
      .filter((organizationId) => (
        afterOrganizationId === null || organizationId > afterOrganizationId
      ))
      .slice(0, limit);
  }

  async function admittedWindow(deadline: number): Promise<string[]> {
    const startCursor = cursor;
    const tail = await listPage(startCursor, maxOrganizations, deadline);
    if (tail === null) return [];
    if (startCursor === null || tail.length >= maxOrganizations) return tail;

    const remainingSlots = maxOrganizations - tail.length;
    const head = await listPage(null, remainingSlots, deadline);
    if (head === null) return tail;
    const seen = new Set(tail);
    return [...tail, ...head.filter((organizationId) => !seen.has(organizationId))]
      .slice(0, maxOrganizations);
  }

  async function runTick(): Promise<JobOutboxTickResult> {
    const tickStart = monotonicNow();
    // One immutable deadline for the whole tick. Every database statement re-budgets its own
    // statement timeout from this deadline; a timeout never resets it and an earlier statement's
    // timeout is never reused for a later one.
    const deadline = tickStart + tickBudgetMs;
    const organizationIds = await admittedWindow(deadline);
    let organizationsVisited = 0;
    let claimedCount = 0;
    let deliveredCount = 0;
    let cleanedCount = 0;

    const recordCleanup = (cleanup: {
      deleted: number;
      cardinalityObserved: number;
      cardinalitySaturated: boolean;
    }): void => {
      cleanedCount += cleanup.deleted;
      metrics.certificateCleanup({
        count: cleanup.deleted,
        cardinalityObserved: cleanup.cardinalityObserved,
        cardinalitySaturated: cleanup.cardinalitySaturated,
      });
    };

    for (const organizationId of organizationIds) {
      if (remainingBudget(deadline) < 1) break;

      // Cursor progress records launch admission, not successful publication.
      // A slow or full shard therefore cannot pin the fair rotation.
      cursor = organizationId;
      organizationsVisited += 1;
      const pending = pendingClaims.get(organizationId);
      if (pending) claimedCount += pending.rows.length;
      const claimToken = pending?.claimToken ?? randomUUID();

      let rows: PendingClaim["rows"];
      if (pending) {
        // Cleanup for a pending-delivery shard runs in its single delivery transaction below.
        rows = pending.rows;
      } else {
        // New shard: the admission transaction cleans once, then claims, and commits so a later
        // publication rejection or delivery timeout leaves the durable claim in place.
        try {
          const admission = await runInTenant(input.appDb, organizationId, async (repos) => {
            const budgetNextStatement = async (): Promise<void> => {
              const remaining = remainingBudget(deadline);
              if (remaining < 1) throw new DeadlineReached();
              await repos.jobControl.setLocalStatementTimeout(remaining);
            };
            const cleanup = await repos.jobControl.cleanupLeaseRejectionCertificates({
              limit: cleanupLimit,
              cardinalityLimit: cleanupCardinalityLimit,
              beforeStatement: async () => { await budgetNextStatement(); },
            });
            await budgetNextStatement();
            const claimTime = await repos.jobControl.currentDatabaseTime();
            await budgetNextStatement();
            const claimed = await repos.jobControl.claimReadyOutbox({
              claimToken,
              now: claimTime,
              staleBefore: new Date(claimTime.getTime() - visibilityTimeoutMs),
              limit: maxRows,
            }) as ClaimedRow[];
            return { cleanup, claimed };
          });
          recordCleanup(admission.cleanup);
          claimedCount += admission.claimed.length;
          rows = admission.claimed.map(({ id, organizationId: rowOrganizationId, targetId }) => ({
            id,
            organizationId: rowOrganizationId,
            targetId,
          }));
          if (rows.length === 0) continue;
          // Cache before publishing so a rejected/late publication leaves the claim retryable.
          if (pendingClaims.size >= maxOrganizations) {
            const oldest = pendingClaims.keys().next().value as string | undefined;
            if (oldest !== undefined && oldest !== organizationId) pendingClaims.delete(oldest);
          }
          pendingClaims.set(organizationId, { claimToken, rows });
        } catch (error) {
          if (error instanceof DeadlineReached) break;
          if (isStatementTimeout(error)) continue;
          throw error;
        }
      }

      // The non-database publisher runs outside the transaction so a rejection cannot roll back
      // the committed claim; remaining time is recomputed before each publisher and the delivery.
      let allPublished = rows.length > 0;
      for (const row of rows) {
        if (remainingBudget(deadline) < 1) {
          allPublished = false;
          break;
        }
        await publish({ organizationId: row.organizationId, targetId: row.targetId });
      }
      if (!allPublished) continue;
      if (remainingBudget(deadline) < 1) continue;

      // Delivery transaction. A pending shard's once-per-shard cleanup runs here; a statement
      // timeout during delivery — after the signal was published — surfaces rather than skips.
      let deliverAttempted = false;
      try {
        const outcome = await runInTenant(input.appDb, organizationId, async (repos) => {
          const budgetNextStatement = async (): Promise<void> => {
            const remaining = remainingBudget(deadline);
            if (remaining < 1) throw new DeadlineReached();
            await repos.jobControl.setLocalStatementTimeout(remaining);
          };
          const cleanup = pending
            ? await repos.jobControl.cleanupLeaseRejectionCertificates({
                limit: cleanupLimit,
                cardinalityLimit: cleanupCardinalityLimit,
                beforeStatement: async () => { await budgetNextStatement(); },
              })
            : null;
          await budgetNextStatement();
          deliverAttempted = true;
          const delivered = await repos.jobControl.deliverReadyOutbox({
            claimToken,
            ids: rows.map((row) => row.id),
          });
          return { cleanup, delivered };
        });
        if (outcome.cleanup) recordCleanup(outcome.cleanup);
        deliveredCount += outcome.delivered;
        pendingClaims.delete(organizationId);
      } catch (error) {
        if (error instanceof DeadlineReached) break;
        if (isStatementTimeout(error) && !deliverAttempted) continue;
        throw error;
      }
    }

    const result: JobOutboxTickResult = {
      organizations: organizationsVisited,
      claimed: claimedCount,
      delivered: deliveredCount,
      cleaned: cleanedCount,
    };
    const elapsedMs = Math.max(0, Math.floor(monotonicNow() - tickStart));
    metrics.outboxTick({
      budgetMs: tickBudgetMs,
      elapsedMs,
      overshootMs: Math.max(0, elapsedMs - tickBudgetMs),
      organizations: result.organizations,
      claimed: result.claimed,
      delivered: result.delivered,
      cleaned: result.cleaned,
    });
    return result;
  }

  return {
    tick(): Promise<JobOutboxTickResult> {
      if (inFlight) return inFlight;
      const current = runTick();
      inFlight = current;
      current.finally(() => {
        if (inFlight === current) inFlight = null;
      }).catch(() => {
        // The caller observes the original rejection. This handles only the
        // promise returned by finally so it cannot become an unhandled branch.
      });
      return current;
    },
  };
}
