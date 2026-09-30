/**
 * Transactional PER-TARGET outbox for issue-comment agent wakeups (PR #291
 * round-16). A direct mirror of `mention-outbox.ts` (discussion mentions), but
 * with ONE ROW PER TARGET so completion is tracked per-agent.
 *
 * `enqueueCommentWakeupOutbox` is called INSIDE the comment-insert transaction
 * (addComment), so a committed comment always has its pending wakeup rows —
 * closing the crash-loses-summon residual (round-16 #1): unlike the old
 * comment-wide `wakeups_enqueued_at` marker, a crash can't leave a "done" marker
 * with no summon, because the durable rows ARE the summon and the worker drains
 * them after any crash. `drainCommentWakeupOutbox` is the worker tick: it claims
 * pending / stale-'processing' rows one at a time with FOR UPDATE SKIP LOCKED,
 * dispatches each wakeup EXACTLY ONCE, and marks 'done' or schedules a backoff
 * retry. Because each target is its own row, a partial multi-agent failure
 * retries ONLY the failed target — succeeded targets stay 'done' and are never
 * re-dispatched (no double-wake, round-16 #2).
 */

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { commentWakeupOutbox, agentWakeupRequests } from "@armyofagents/db";
import { logger } from "../middleware/logger.js";

const LOG_CTX = { service: "comment-wakeup-outbox" } as const;

/** One wakeup target: the agent to wake + the fully-built heartbeat.wakeup config. */
export type CommentWakeupTarget = { agentId: string; wakeup: unknown };

export interface CommentWakeupRow {
  id: string;
  companyId: string;
  issueId: string;
  commentId: string;
  targetAgentId: string;
  wakeup: unknown;
  attempts: number;
  claimToken: string;
}

/** Dispatch one row's wakeup. Injectable for tests; the default resolves the
 *  target's kind and routes aoa → enqueueAoaMentionWakeup, org → heartbeat.wakeup. */
export type RunWakeupFn = (db: Db, row: CommentWakeupRow) => Promise<void>;

/**
 * Rows still 'processing' past this window are treated as crash-orphaned and may
 * be reclaimed. Comment wakeups are a fast row insert (no long CLI run like the
 * mention outbox's controller participation), so a short window is safe.
 */
const STALE_PROCESSING_MINUTES = 5;
const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_BATCH_SIZE = 20;

/**
 * Enqueue one outbox row PER TARGET, idempotently. Keyed on the partial unique
 * index (comment_id, target_agent_id) via onConflictDoNothing, so re-enqueueing
 * the SAME comment's targets — the fresh insert AND a keyed-retry that re-builds
 * them after a crash — resolves to exactly ONE row per agent. That gives the two
 * round-16 guarantees together: per-target exactly-once (a partial failure the
 * worker retries never re-inserts a succeeded target → no double-wake), and
 * crash recovery (a request that died before enqueueing is recovered by the
 * keyed retry re-enqueueing, since the retry finds the comment and re-builds +
 * re-enqueues the same targets harmlessly).
 */
export async function enqueueCommentWakeupOutbox(
  db: Db,
  row: {
    companyId: string;
    issueId: string;
    commentId: string;
    targets: CommentWakeupTarget[];
    // Round-18 #2/#3: when the wakeup references post-insert side effects
    // (attachment rows / reopen-interrupt control effects committed AFTER the
    // comment tx), enqueue NOT-YET-DRAINABLE with ready_at = now()+grace. The
    // route flips it to drainable once those effects are durable; the grace is the
    // crash backstop. null/omitted = immediately drainable.
    readyAt?: Date | null;
  },
): Promise<void> {
  if (row.targets.length === 0) return;
  await db
    .insert(commentWakeupOutbox)
    .values(
      row.targets.map((target) => ({
        companyId: row.companyId,
        issueId: row.issueId,
        commentId: row.commentId,
        targetAgentId: target.agentId,
        wakeup: target.wakeup as Record<string, unknown>,
        readyAt: row.readyAt ?? null,
      })),
    )
    .onConflictDoNothing({
      target: [commentWakeupOutbox.commentId, commentWakeupOutbox.targetAgentId],
    });
}

/** Grace window before a DEFERRED wakeup row auto-becomes drainable if the route
 *  crashed before flipping it ready (round-18 #2/#3 crash backstop). */
export const COMMENT_WAKEUP_DEFER_GRACE_MS = 120_000;

/** Flip a comment's DEFERRED wakeup rows to immediately drainable — called by the
 *  route once the post-insert side effects (attachment rows, control effects) are
 *  durable. Sets ready_at = now() on the comment's still-pending rows. */
export async function markCommentWakeupsReady(db: Db, commentId: string): Promise<void> {
  await db
    .update(commentWakeupOutbox)
    .set({ readyAt: new Date(), updatedAt: new Date() })
    .where(and(eq(commentWakeupOutbox.commentId, commentId), eq(commentWakeupOutbox.status, "pending")));
}

/**
 * A stable idempotency key for a single outbox row's downstream wakeup. Tagged
 * onto the agent_wakeup_requests row (aoa) OR the heartbeat wakeupRequest row so a
 * re-dispatch of the SAME outbox row is deduped at the DB layer (round-17 #2,
 * partial unique index `…comment_wakeup_idempotency_uq`). The row id is stable
 * across the worker's crash/reclaim/re-drain, so the second dispatch is a no-op.
 */
function wakeupIdempotencyKey(rowId: string): string {
  return `comment-wakeup:${rowId}`;
}

/**
 * Default dispatch — IDEMPOTENT CONSUMER (round-17 #2, round-18 #1). The worker is
 * at-least-once (it can crash after dispatching but before marking the row done,
 * then re-drain), and the downstream heartbeat/aoa wakeup is NOT itself idempotent.
 * So:
 *   1) tag every dispatch with a stable idempotency key derived from the outbox
 *      row id, and
 *   2) BEFORE dispatching, skip if an agent_wakeup_requests row already carries
 *      that key — a cheap short-circuit for the common sequential re-drive; the
 *      partial unique index is the hard backstop for the rare concurrent stale-
 *      reclaim race (the losing insert conflicts → the row retries → this check
 *      then skips).
 *
 * Round-18 #1: this skip is a valid COMPLETION check because BOTH downstream
 * dispatches persist the keyed agent_wakeup_requests row ATOMICALLY with their
 * delivery: the aoa path is a single insert (row exists ⟺ the crew summon is
 * queued for the AoA dispatcher), and heartbeat.wakeup now creates the request +
 * its run + the link in ONE transaction (round-18 #1), so a keyed request row
 * always has its run. Thus "a row with this key exists" genuinely means the prior
 * dispatch completed (delivered, coalesced, or intentionally skipped) — never a
 * torn write that would drop the summon.
 *
 * Kind is resolved AT DRAIN time (round-14 #1: a failed lookup retries, never
 * default-routes aoa → heartbeat). Lazy imports keep the heavy trees off the
 * worker's module-load path.
 */
const defaultRunWakeup: RunWakeupFn = async (db, row) => {
  const idempotencyKey = wakeupIdempotencyKey(row.id);

  const already = await db
    .select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .where(and(eq(agentWakeupRequests.companyId, row.companyId), eq(agentWakeupRequests.idempotencyKey, idempotencyKey)))
    .limit(1);
  if (already.length > 0) return; // prior dispatch completed (atomic) → no-op

  const { issueService } = await import("./issues.js");
  const kinds = await issueService(db).resolveAgentKinds([row.targetAgentId]);
  if (kinds.get(row.targetAgentId) === "aoa") {
    const w = (row.wakeup ?? {}) as { source?: string | null; reason?: string | null; payload?: unknown };
    await issueService(db).enqueueAoaMentionWakeup(row.companyId, row.targetAgentId, {
      source: w.source,
      reason: w.reason,
      payload: w.payload,
      idempotencyKey,
    });
    return;
  }
  const { heartbeatService } = await import("./heartbeat.js");
  await heartbeatService(db).wakeup(
    row.targetAgentId,
    { ...((row.wakeup ?? {}) as Record<string, unknown>), idempotencyKey } as Parameters<
      ReturnType<typeof heartbeatService>["wakeup"]
    >[1],
  );
};

export interface DrainCommentWakeupOpts {
  batchSize?: number;
  maxAttempts?: number;
  /** Injectable for tests; defaults to kind-resolving heartbeat/aoa dispatch. */
  runWakeup?: RunWakeupFn;
}

export interface DrainCommentWakeupResult {
  processed: number;
  failed: number;
}

function backoffMs(attempts: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.max(0, attempts - 1));
}

/** Atomically claim EXACTLY ONE eligible row (pending+due OR stale-'processing'),
 *  marking it 'processing' with a fresh token in the same round-trip. Mirrors the
 *  mention outbox's round-10 #1 claim-one-before-execute. */
async function claimOneRow(db: Db): Promise<CommentWakeupRow | null> {
  const result = await db.execute(
    sql.raw(`
      WITH claimed AS (
        SELECT id FROM comment_wakeup_outbox
        WHERE (status = 'pending'
               AND (next_retry_at IS NULL OR next_retry_at <= now())
               -- Round-18 #2/#3 deferred→ready gate: a row that references
               -- post-insert side effects is not drainable until its ready_at
               -- elapses (flipped to now() by the route once those effects are
               -- durable; else it auto-readies after the grace window — the
               -- crash backstop).
               AND (ready_at IS NULL OR ready_at <= now()))
           OR (status = 'processing' AND updated_at < now() - interval '${STALE_PROCESSING_MINUTES} minutes')
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE comment_wakeup_outbox
      SET status = 'processing', updated_at = now(), claim_token = gen_random_uuid()
      WHERE id IN (SELECT id FROM claimed)
      RETURNING
        id,
        company_id AS "companyId",
        issue_id AS "issueId",
        comment_id AS "commentId",
        target_agent_id AS "targetAgentId",
        wakeup,
        attempts,
        claim_token AS "claimToken"
    `),
  );
  const rawRows = Array.isArray(result) ? result : ((result as { rows?: unknown[] })?.rows ?? []);
  const r = rawRows[0] as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    id: String(r.id),
    companyId: String(r.companyId),
    issueId: String(r.issueId),
    commentId: String(r.commentId),
    targetAgentId: String(r.targetAgentId),
    wakeup: typeof r.wakeup === "string" ? JSON.parse(r.wakeup) : r.wakeup,
    attempts: Number(r.attempts ?? 0),
    claimToken: String(r.claimToken),
  };
}

export async function drainCommentWakeupOutbox(
  db: Db,
  opts: DrainCommentWakeupOpts = {},
): Promise<DrainCommentWakeupResult> {
  const maxRows = Math.max(1, Math.floor(opts.batchSize ?? DEFAULT_BATCH_SIZE));
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const runWakeup = opts.runWakeup ?? defaultRunWakeup;

  let processed = 0;
  let failed = 0;

  for (let i = 0; i < maxRows; i++) {
    const row = await claimOneRow(db);
    if (!row) break;

    try {
      await runWakeup(db, row);
      // Owner-guarded terminal write: only mark done if we still own the claim,
      // so a reclaimed original worker can't clobber the new owner.
      await db
        .update(commentWakeupOutbox)
        .set({ status: "done", updatedAt: new Date() })
        .where(and(eq(commentWakeupOutbox.id, row.id), eq(commentWakeupOutbox.claimToken, row.claimToken)));
      processed += 1;
    } catch (err) {
      const attempts = row.attempts + 1;
      const terminal = attempts >= maxAttempts;
      await db
        .update(commentWakeupOutbox)
        .set({
          status: terminal ? "failed" : "pending",
          attempts,
          error: String((err as { message?: string })?.message ?? err).slice(0, 500),
          nextRetryAt: terminal ? null : new Date(Date.now() + backoffMs(attempts)),
          updatedAt: new Date(),
        })
        .where(and(eq(commentWakeupOutbox.id, row.id), eq(commentWakeupOutbox.claimToken, row.claimToken)));
      failed += 1;
      logger.warn({ ...LOG_CTX, err, outboxId: row.id, attempts, terminal }, "comment wakeup outbox row failed");
    }
  }

  return { processed, failed };
}
