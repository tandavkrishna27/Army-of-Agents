-- I1 (comprehensive-review fixup): pre-flight cleanup for pre-existing
-- TOCTOU duplicates. The team_coordinations.upsert path was vulnerable
-- to two concurrent transactions both inserting a 'published' row for
-- the same team before this index existed. Any production cluster that
-- ran the prior code AND saw such a race will have duplicate published
-- rows; this CREATE UNIQUE INDEX would then abort with 23505.
--
-- The cleanup archives all but the most-recent published row per team.
-- Idempotent: zero rows affected on clean clusters (single-tenant or
-- never-raced multi-tenant). Safe: archived rows preserve all content
-- and can be revived via teamCoordinationService.upsert if needed.
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY team_id
    ORDER BY updated_at DESC, created_at DESC
  ) AS rn
  FROM team_coordinations
  WHERE status = 'published'
)
UPDATE team_coordinations
SET status = 'archived', updated_at = NOW()
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "team_coordinations_one_published_uq" ON "team_coordinations" USING btree ("team_id") WHERE status = 'published';--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'teams_status_check'
  ) THEN
    ALTER TABLE "teams" ADD CONSTRAINT "teams_status_check" CHECK (status IN ('active', 'archived'));
  END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'team_coordinations_status_check'
  ) THEN
    ALTER TABLE "team_coordinations" ADD CONSTRAINT "team_coordinations_status_check" CHECK (status IN ('draft', 'published', 'archived'));
  END IF;
END $$;
