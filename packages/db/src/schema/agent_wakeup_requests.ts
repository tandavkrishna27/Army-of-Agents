import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, jsonb, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const agentWakeupRequests = pgTable(
  "agent_wakeup_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    triggerDetail: text("trigger_detail"),
    reason: text("reason"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    status: text("status").notNull().default("queued"),
    coalescedCount: integer("coalesced_count").notNull().default(0),
    requestedByActorType: text("requested_by_actor_type"),
    requestedByActorId: text("requested_by_actor_id"),
    idempotencyKey: text("idempotency_key"),
    // Optional hard dedup key for cross-process coalescing of queued wakeups.
    // Populated by services (e.g. thread-events Adjutant debounce) as
    // `${agentId}:${threadId}:queued` paired with `.onConflictDoNothing()` so
    // duplicate inserts are rejected at the DB layer via the partial unique
    // index below — historical (claimed/finished/failed) rows sharing the
    // same dedupKey are unaffected.
    dedupKey: text("dedup_key"),
    runId: uuid("run_id"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimToken: uuid("claim_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentStatusIdx: index("agent_wakeup_requests_company_agent_status_idx").on(
      table.companyId,
      table.agentId,
      table.status,
    ),
    companyRequestedIdx: index("agent_wakeup_requests_company_requested_idx").on(
      table.companyId,
      table.requestedAt,
    ),
    agentRequestedIdx: index("agent_wakeup_requests_agent_requested_idx").on(table.agentId, table.requestedAt),
    processingLeaseIdx: index("agent_wakeup_requests_processing_lease_idx").on(
      table.status,
      table.leaseExpiresAt,
    ),
    companyIdempotencyKeyUq: uniqueIndex("agent_wakeup_requests_company_idempotency_key_uq")
      .on(table.companyId, table.idempotencyKey)
      .where(sql`idempotency_key is not null and reason in ('max_turn_continuation_retry', 'issue_monitor_due', 'finish_successful_run_handoff', 'work_question_continuation')`),
    // Partial unique index for hard cross-process dedup of *queued* wakeups.
    // Only fires while a row is still queued; once it transitions to
    // claimed/finished/failed the dedupKey may legitimately recur for the
    // next queued wakeup. NULL dedupKey rows are excluded entirely.
    dedupKeyQueuedUq: uniqueIndex("agent_wakeup_requests_dedup_key_queued_uq")
      .on(table.dedupKey)
      .where(sql`status = 'queued' AND dedup_key IS NOT NULL`),
    // PR #291 round-17 #2: idempotent-consumer key for the comment_wakeup_outbox
    // worker. It tags each dispatch with idempotency_key = 'comment-wakeup:<outbox
    // row id>'; this STATUS-AGNOSTIC unique index (unlike dedupKeyQueuedUq, which
    // only fires while queued) makes a re-dispatch of the same outbox row after
    // the worker crashed before marking it done a no-op / hard-conflict — so the
    // downstream agent_wakeup_requests insert (aoa OR the heartbeat wakeupRequest
    // row) can never double-wake a target, regardless of run lifecycle. Scoped by
    // the key PREFIX so it is fully isolated from the reason-based idempotency
    // index above and from any other idempotency_key user.
    commentWakeupIdempotencyUq: uniqueIndex("agent_wakeup_requests_comment_wakeup_idempotency_uq")
      .on(table.companyId, table.idempotencyKey)
      .where(sql`idempotency_key LIKE 'comment-wakeup:%'`),
  }),
);
