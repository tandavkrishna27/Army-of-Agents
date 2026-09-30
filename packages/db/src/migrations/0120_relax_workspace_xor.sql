-- Phase 1 corrective migration: relax 0119's strict XOR constraint on
-- execution_workspaces.thread_id ⟷ source_issue_id.
--
-- Root cause (found by /investigate during Phase A → Phase B transition):
--
-- The strict XOR `(thread_id IS NULL) <> (source_issue_id IS NULL)` shipped in
-- 0119 rejects a previously-valid state — workspaces with BOTH columns NULL.
--
-- That state is reached via the heartbeat path at server/src/services/heartbeat.ts:2702
-- when an agent runs without an assigned issue but with a resolved project:
--
--   createTaskOwnedIdempotent({
--     ...,
--     sourceIssueId: issueRef?.id ?? null,   -- null when agent has no issue
--   })
--
-- Followed by execution-workspaces.ts:489-494:
--
--   if (!data.sourceIssueId) return create(data);   -- explicit null fallback
--
-- Memory Keeper sweeps, Adjutant sweeps, and on-demand agent invocations all
-- hit this path. Production data already contains such workspaces. Existing
-- tests didn't catch this because none of the 418 workspace tests covered the
-- null-sourceIssueId code path — false negative on the original A4 test pass.
--
-- The actual invariant we want is "at most one is set":
--   ✓ source_issue_id set, thread_id NULL   (legacy per-task workspace)
--   ✓ source_issue_id NULL, thread_id set   (Phase B per-thread workspace)
--   ✓ source_issue_id NULL, thread_id NULL  (project-scoped agent workspace — VALID)
--   ✗ source_issue_id set, thread_id set    (claiming both ownerships — INVALID)
--
-- This corrective migration drops the strict XOR and replaces it with the
-- "not both set" semantic. The dropped constraint name is preserved by the new
-- one's existence so the contract surface is "execution_workspaces has a
-- constraint preventing simultaneous task+thread ownership."

ALTER TABLE "execution_workspaces"
  DROP CONSTRAINT IF EXISTS "execution_workspaces_thread_or_issue_xor";--> statement-breakpoint

ALTER TABLE "execution_workspaces"
  ADD CONSTRAINT "execution_workspaces_not_both_thread_and_issue"
  CHECK (NOT (thread_id IS NOT NULL AND source_issue_id IS NOT NULL));
