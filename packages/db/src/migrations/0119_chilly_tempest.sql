-- Phase 1 (Task A4): hard cross-process dedup for queued wakeups + per-thread
-- workspace pointer with XOR invariant against the legacy per-task pointer.
--
-- Coordinated changes shipped together:
--   1. New "dedup_key" column on agent_wakeup_requests (nullable). The thread-
--      events service (Phase B) will populate it as `${agentId}:${threadId}:queued`
--      paired with `.onConflictDoNothing()` so duplicate queued inserts across
--      horizontally-scaled server processes are rejected at the DB layer.
--   2. Partial unique index "agent_wakeup_requests_dedup_key_queued_uq" — fires
--      only while a row is still queued AND dedupKey is not NULL. Once a row
--      transitions to claimed/finished/failed the dedupKey may legitimately
--      recur for the next queued wakeup.
--   3. New "thread_id" column on execution_workspaces (nullable FK → discussions,
--      ON DELETE SET NULL) so Phase B Engineer can attach an interactive
--      artifact workspace to a thread instead of a task.
--   4. Companion index + active-thread-workspace partial unique index mirror
--      the existing per-task pattern (one non-archived workspace per thread).
--   5. CHECK constraint "execution_workspaces_thread_or_issue_xor" enforces the
--      XOR invariant — every row has EXACTLY one of (thread_id, source_issue_id)
--      set. Existing rows (all per-task with sourceIssueId set, threadId NULL)
--      satisfy `(NULL IS NULL) <> (uuid IS NULL)` → `true <> false` → `true`.
--      Future per-thread rows satisfy `(uuid IS NULL) <> (NULL IS NULL)`
--      → `false <> true` → `true`. The (both NULL) and (both set) cases both
--      evaluate to `false` and are rejected.

ALTER TABLE "agent_wakeup_requests" ADD COLUMN "dedup_key" text;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD COLUMN "thread_id" uuid;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD CONSTRAINT "execution_workspaces_thread_id_discussions_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."discussions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_wakeup_requests_dedup_key_queued_uq" ON "agent_wakeup_requests" USING btree ("dedup_key") WHERE status = 'queued' AND dedup_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_workspaces_company_thread_idx" ON "execution_workspaces" USING btree ("company_id","thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "execution_workspaces_active_thread_workspace_uq" ON "execution_workspaces" USING btree ("company_id","thread_id") WHERE thread_id IS NOT NULL AND status <> 'archived';--> statement-breakpoint

-- XOR invariant: every execution_workspaces row has EXACTLY one of
-- (thread_id, source_issue_id) set. Legacy per-task workspaces have
-- source_issue_id set + thread_id NULL; Phase B per-thread workspaces
-- have thread_id set + source_issue_id NULL. Neither both-NULL nor
-- both-set are valid. If an existing dev/test DB happens to have a
-- workspace row with both source_issue_id and thread_id NULL (orphan
-- state — should be impossible for non-archived rows but theoretically
-- possible after a SET NULL cascade), this constraint will fail to
-- apply. Production data does not yet contain any per-thread rows
-- because the column is being introduced in this same migration, so
-- the constraint can be added unconditionally.
ALTER TABLE "execution_workspaces"
  ADD CONSTRAINT "execution_workspaces_thread_or_issue_xor"
  CHECK ((thread_id IS NULL) <> (source_issue_id IS NULL));