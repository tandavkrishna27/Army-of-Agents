import { pgTable, uuid, text, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";

/**
 * Transactional outbox for @mention crew summons (PR #291 round-6 #3).
 *
 * `processMentions` is NOT idempotent — it bumps a participation hop counter and
 * requests crew participation — and it previously ran post-commit, fire-and-
 * forget, at the route level: a failure lost the summon, and a same-key retry
 * replayed the entry and skipped it, so an explicit `@agent` message could
 * persist without ever summoning that agent.
 *
 * The fix mirrors the write-behind embedding_queue pattern. addEntry inserts an
 * outbox row INSIDE the same transaction as the entry, so a committed entry
 * ALWAYS carries a pending summon. A background worker claims pending rows with
 * FOR UPDATE SKIP LOCKED (single-claim across workers), runs processMentions
 * once, and marks the row 'done' (so a successful summon is never re-run) or
 * schedules a backoff retry on failure. FKs are intentionally omitted (like
 * embedding_queue): the worker resolves the entry at app level and a missing
 * target simply fails the row rather than cascading.
 */
export const discussionMentionOutbox = pgTable(
  "discussion_mention_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    discussionId: uuid("discussion_id").notNull(),
    entryId: uuid("entry_id").notNull(),
    // Array<{ raw: string; name: string }> — the parsed @mentions to summon.
    mentions: jsonb("mentions").notNull(),
    // Mention-cascade hop count applied when the worker runs processMentions
    // (PR #291 round-8 #1). 0 = human-originated (the default); 1 = an
    // agent-authored reply, matching the { hopCount: 1 } the internal writers
    // (post-entry-tool / thread-agent-actions) used to pass directly — the loop
    // cap (MAX_HOP_COUNT) must count the same way now the outbox owns the summon.
    hopCount: integer("hop_count").notNull().default(0),
    // 'pending' | 'processing' | 'done' | 'failed'
    status: text("status").notNull().default("pending"),
    // Owner-lease token for a 'processing' claim (PR #291 round-9 #1). The worker
    // mints a fresh token when it claims a row; it heartbeats updated_at and marks
    // the row done/failed only while the token still matches. So if a long
    // controller participation outlasts the stale window and another worker
    // reclaims the row (new token), the original worker's heartbeat + terminal
    // write become no-ops — no double summon, no clobbering the new owner.
    claimToken: uuid("claim_token"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    // null = eligible immediately; set by the worker for backoff retry scheduling.
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Worker's pick-next-eligible query:
    // WHERE status='pending' AND (next_retry_at IS NULL OR next_retry_at <= now())
    pendingDueIdx: index("discussion_mention_outbox_pending_due_idx").on(table.status, table.nextRetryAt),
    entryIdx: index("discussion_mention_outbox_entry_idx").on(table.entryId),
  }),
);
