/**
 * Thread Orchestration Controller — the per-thread "bookmark" that drives the
 * Adjutant agent idempotently as a conversation advances.
 *
 * Intentionally NOT modeled as a task/issue: this record has event-cursor
 * semantics (read cursor + epoch counter) that the task board lacks, and
 * adding it there would pollute the work surface with internal plumbing.
 * One row per thread; created lazily on first Adjutant trigger.
 */
import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { discussions, discussionEntries } from "./discussions.js";

export const threadOrchestrationState = pgTable(
  "thread_orchestration_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // One controller per thread — UNIQUE enforces the invariant.
    threadId: uuid("thread_id")
      .notNull()
      .references(() => discussions.id, { onDelete: "cascade" })
      .unique(),

    // Read cursor: the last discussion_entries row fully processed by the
    // Adjutant. NULL means nothing has been processed yet for this thread.
    lastProcessedEntryId: uuid("last_processed_entry_id").references(
      () => discussionEntries.id,
      { onDelete: "set null" },
    ),

    // Bumped by 1 each time a new human entry triggers a run cycle.
    // Passed to every spawned run so stale in-flight runs can detect
    // they were superseded without querying the DB.
    runEpoch: integer("run_epoch").notNull().default(0),

    // True when a run has been queued but not yet started.
    pendingRun: boolean("pending_run").notNull().default(false),

    // Number of consecutive agent-authored rounds since the last human entry.
    // Reset to 0 whenever a human entry arrives. Used to enforce hop-count
    // limits and prevent infinite agent self-loops.
    hopCount: integer("hop_count").notNull().default(0),

    // Last error message from an Adjutant run, if any. Cleared on the next
    // successful run. Persisted + logged; a UI/Inbox surface is tracked in #198.
    lastError: text("last_error"),

    // Consecutive run OR commit failures since the last successful run (the
    // adjutant-runner-throw and entries-load paths share this counter with the
    // action-commit path). Reset to 0 on success. When it reaches
    // MAX_CONSECUTIVE_COMMIT_FAILURES the orchestrator circuit-breaks: it advances
    // the cursor past the failing entry so one poison action cannot stall the thread.
    consecutiveCommitFailures: integer("consecutive_commit_failures")
      .notNull()
      .default(0),

    // Lifecycle: 'active' while the thread is open; 'closed' when the thread
    // is archived. Closed controllers are skipped by the dispatch gate.
    status: text("status").notNull().default("active"),
    // Allowed values: 'active' | 'closed'

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);
