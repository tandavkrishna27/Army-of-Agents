-- Threads v1: backfill existing discussions with thread-container defaults.
--
-- Pre-Threads discussions (created before migration 0109) have NULL values for
-- owner_user_id, origin_source, and origin_medium. Without this backfill they
-- appear as "Unclaimed" with null origin in the Threads UI.
--
-- Note: this is a DATA migration, not a schema migration. No DDL changes.
-- Idempotent: all three statements filter on IS NULL / specific phase value.

-- 1. Owner: pre-Threads discussions were human-created; owner = creator.
UPDATE discussions SET owner_user_id = created_by WHERE owner_user_id IS NULL;
--> statement-breakpoint

-- 2. Origin: set human/text origin for all pre-Threads discussions.
UPDATE discussions SET origin_source = 'human', origin_medium = 'text' WHERE origin_source IS NULL;
--> statement-breakpoint

-- 3. Phase heuristic: discussions with approved extracted items are already
--    scoped, so advance them from 'discuss' to 'scope'.
UPDATE discussions SET phase = 'scope'
WHERE phase = 'discuss'
  AND id IN (
    SELECT DISTINCT de.discussion_id
    FROM discussion_entries de
    JOIN discussion_extracted_items dei ON dei.discussion_entry_id = de.id
    WHERE dei.status = 'approved'
  );
