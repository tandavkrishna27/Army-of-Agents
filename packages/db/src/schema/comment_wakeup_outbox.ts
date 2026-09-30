import { pgTable, uuid, text, timestamp, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Transactional PER-TARGET outbox for issue-comment agent wakeups (PR #291
 * round-16).
 *
 * Comment wakeups (assignee "commented"/"reopened", request-changes,
 * @mention summons) are NOT idempotent — heartbeat.wakeup / enqueueAoaMentionWakeup
 * each insert a fresh agent_wakeup_requests row with no dedup key — and they
 * previously ran post-commit behind a single comment-WIDE `wakeups_enqueued_at`
 * marker + CAS. That marker had two unfixable-without-an-outbox residuals:
 *   (1) a crash between the marker commit and the durable enqueue left the marker
 *       set with no summon, and — unlike discussion_mention_outbox — there was no
 *       worker to recover it, so the wakeup was lost forever (round-16 finding #1);
 *   (2) the marker was comment-WIDE, so a partial multi-agent failure released it
 *       and a retry re-dispatched EVERY target, double-waking the agents whose
 *       first enqueue had succeeded (round-16 finding #2).
 *
 * This mirrors discussion_mention_outbox exactly, but with ONE ROW PER TARGET so
 * completion is tracked per-agent: the route builds the wakeup set and enqueues
 * one row per target INSIDE the comment-insert transaction (addComment), so a
 * committed comment always carries its pending wakeup rows. A background worker
 * claims pending rows with FOR UPDATE SKIP LOCKED (single-claim across workers +
 * crash reclaim via a stale claim window), dispatches each row's wakeup exactly
 * once (heartbeat.wakeup or enqueueAoaMentionWakeup per `targetKind`), and marks
 * it 'done' — so a succeeded target is never re-dispatched (no double-wake) while
 * a failed target retries with backoff on its OWN row. FKs are omitted (like
 * discussion_mention_outbox / embedding_queue): the worker resolves the target at
 * app level and a missing one simply fails the row rather than cascading.
 */
export const commentWakeupOutbox = pgTable(
  "comment_wakeup_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    issueId: uuid("issue_id").notNull(),
    commentId: uuid("comment_id").notNull(),
    targetAgentId: uuid("target_agent_id").notNull(),
    // The fully-built heartbeat.wakeup options object. The worker resolves the
    // target agent's kind AT DRAIN time (round-14 #1: never default-route on a
    // failed lookup — an unresolved kind just retries the row) and dispatches
    // accordingly: kind='aoa' → enqueueAoaMentionWakeup with the { source, reason,
    // payload } subset (crew agents run via the AoA dispatcher); otherwise
    // heartbeat.wakeup with the full object (org agents).
    wakeup: jsonb("wakeup").notNull(),
    // 'pending' | 'processing' | 'done' | 'failed'
    status: text("status").notNull().default("pending"),
    // Owner-lease token for a 'processing' claim (mirrors discussion_mention_outbox
    // round-9 #1): a reclaimed row gets a new token, so the original worker's
    // heartbeat + terminal write become no-ops — no double wake, no clobber.
    claimToken: uuid("claim_token"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    // null = eligible immediately; set by the worker for backoff retry scheduling.
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    // Deferred→ready gate (PR #291 round-18 #2/#3). The row is enqueued IN the
    // comment-insert transaction (round-17), but the wakeup can reference
    // post-insert side effects — the attachment rows and the reopen/interrupt
    // control effects are committed AFTER the comment tx. So a wakeup that depends
    // on them is enqueued with ready_at set to now()+grace: the worker's claim
    // query EXCLUDES rows whose ready_at is still in the future, so the agent is
    // not woken before the data it references exists. The route flips ready_at to
    // now() once those side effects are durable (immediately drainable). If the
    // process crashes before the flip, the grace window is the crash BACKSTOP —
    // the row becomes drainable when ready_at elapses and dispatches with whatever
    // landed (durability preserved). null = immediately drainable (a comment with
    // no attachments and no control effects).
    readyAt: timestamp("ready_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Worker's pick-next-eligible query:
    // WHERE status='pending' AND (next_retry_at IS NULL OR next_retry_at <= now())
    pendingDueIdx: index("comment_wakeup_outbox_pending_due_idx").on(table.status, table.nextRetryAt),
    // Per-target idempotency: exactly one row per (comment, agent). Makes the
    // enqueue re-safe — a fresh insert and a keyed-retry re-enqueue on the same
    // comment resolve to ONE row per agent (onConflictDoNothing), so a partial
    // failure retried by the worker never double-wakes a succeeded target
    // (round-16 #2) and a crash before the enqueue is recovered by the keyed
    // retry re-enqueueing (round-16 #1) — without ever duplicating a target.
    targetUniqueIdx: uniqueIndex("comment_wakeup_outbox_comment_target_uniq").on(
      table.commentId,
      table.targetAgentId,
    ),
  }),
);
