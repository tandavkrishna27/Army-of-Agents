-- Phase 6.2e: archive memory items that were auto-extracted from uploaded
-- files (those with importJobId set). Founder no longer wants 50+ paragraph
-- items per upload polluting the pending-review list. They remain in the DB
-- and are recoverable via the Archived virtual folder; an Active Commander
-- sub-agent will replace this flow with curated extraction in a later phase.
--
-- Note: this is a DATA migration, not a schema migration. No DDL changes.

UPDATE memory_items
SET status = 'archived',
    updated_at = NOW()
WHERE import_job_id IS NOT NULL
  AND status IN ('pending', 'approved');

-- Don't touch items with status = 'archived' (idempotent if migration runs again)
-- or status = 'rejected' (those were explicitly rejected by the founder).
