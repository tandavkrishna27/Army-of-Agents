-- H4 suggestion dedupe: stable per-finding identity + partial unique index.
--
-- Coordinated changes shipped together:
--   1. New "dedupe_key" column on suggestions (nullable). runAllDetectors now
--      populates it as `${category}:${patternId}` (fallback
--      `${category}:sha256(action_payload)`) paired with `.onConflictDoNothing()`
--      so duplicate pending inserts across concurrent detector runs (Home load,
--      POST /detect, memory-feedback, Commander analysis) are rejected at the DB
--      layer instead of racing to two rows.
--   2. Partial unique index "suggestions_pending_dedupe_idx" — fires only while a
--      row is pending AND dedupe_key is not NULL, so a dismissed/accepted/expired
--      row may legitimately share a dedupe_key with the next pending suggestion.
--      NULL dedupe_key rows are excluded entirely (legacy rows + any detector
--      output without a stable key participate only via the in-memory pre-filter
--      and the runtime self-heal in runAllDetectors, never the DB index).
--      Precedent: agent_wakeup_requests_dedup_key_queued_uq (migration 0119).
--
-- ⚠️ Pre-index duplicate collapse (P1-1): drizzle-kit emits a bare
-- CREATE UNIQUE INDEX with no data step, and Postgres ABORTS index creation if
-- existing rows already violate it. Live instances carry pending duplicate pairs
-- minted by the old read-then-insert TOCTOU race (e.g. two identical
-- "No identity memory exists yet" suggestions). The app-runtime self-heal only
-- runs on the next detector pass — too late, migrations run first. So we collapse
-- the existing pending duplicates HERE, BEFORE the index, keeping the NEWEST
-- pending row per (company_id, category, action_payload) — which IS the duplicate
-- signature: identical category + payload, differing only by id — and marking the
-- older rows dismissed. (Editing a drizzle-GENERATED migration is allowed;
-- Rule #1 bans hand-authored raw-SQL migration FILES, not this. Precedent: the
-- hand-edited data steps in migrations 0092/0119.)
--
-- Backfill: after the collapse we set dedupe_key on the surviving pending rows so
-- the partial unique index immediately guards them. The key is category-scoped
-- (`category || ':' || md5(action_payload::text)`) — deterministic per
-- (category, payload), NULL-safe (a NULL action_payload yields '<category>:' ||
-- md5('null')). Rows the collapse already dismissed are left with a NULL
-- dedupe_key (excluded from the index, harmless); the next detector pass's
-- self-heal backfills any that later reappear.
-- REVIEW FIX: the executable backfill below now prefers canonical runtime keys
-- for reconstructable detector families and leaves unreconstructable survivors
-- NULL instead of writing a hash that runtime would later trust.

-- 1. Collapse existing pending duplicates (keep newest per company/canonical
-- key). The partition key mirrors the canonical backfill below when possible,
-- then falls back to the old category+payload duplicate identity.
WITH ranked AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY
        "company_id",
        COALESCE(
          CASE
            WHEN "category" = 'goal_gap'
              AND "action_type" = 'create_task'
              AND "action_payload"->>'goalId' IS NOT NULL
              AND coalesce("title", '') ILIKE '%has no tasks yet%'
              THEN 'goal_gap:no_tasks:' || ("action_payload"->>'goalId')
            WHEN "category" = 'goal_gap'
              AND "action_type" = 'create_task'
              AND "action_payload"->>'goalId' IS NOT NULL
              AND coalesce("title", '') ILIKE '%looks stalled%'
              THEN 'goal_gap:stalled:' || ("action_payload"->>'goalId')
            WHEN "category" = 'memory_gap'
              AND "action_type" = 'suggest_memory'
              AND "action_payload"->>'layer' = 'identity'
              THEN 'memory_gap:identity'
            WHEN "category" = 'memory_gap'
              AND "action_type" = 'suggest_memory'
              AND "action_payload"->>'departmentId' IS NOT NULL
              THEN 'memory_gap:domain:' || ("action_payload"->>'departmentId')
            WHEN "category" = 'memory_gap'
              AND "action_type" = 'archive_memory'
              AND "action_payload"->>'memoryItemId' IS NOT NULL
              THEN 'memory_gap:stale:' || ("action_payload"->>'memoryItemId')
            WHEN "category" = 'pattern_detected'
              AND "action_payload"->>'patternId' IS NOT NULL
              THEN 'pattern_detected:' || ("action_payload"->>'patternId')
            WHEN "category" = 'budget_optimization'
              AND coalesce("title", '') ILIKE '%company budget%'
              THEN 'budget_optimization:company'
            ELSE NULL
          END,
          "category" || ':payload:' || coalesce("action_payload"::text, 'null')
        )
      ORDER BY "created_at" DESC, "id" DESC
    ) AS rn
  FROM "suggestions"
  WHERE "status" = 'pending'
)
UPDATE "suggestions" AS s
SET "status" = 'dismissed', "updated_at" = now()
FROM ranked r
WHERE s."id" = r."id" AND r.rn > 1;
--> statement-breakpoint
-- 1b. Archive already-materialized hub rows for suggestions this migration just
-- dismissed. Runtime reconcile only sees rows it dismisses itself; migration-
-- dismissed historical rows need the same source-row cleanup here.
UPDATE "notifications" AS h
SET "status" = 'archived', "archived_at" = COALESCE("archived_at", now())
WHERE h."source_type" = 'suggestion'
  AND h."status" = 'open'
  AND EXISTS (
    SELECT 1 FROM "suggestions" AS s
    WHERE s."id"::text = h."source_id"
      AND s."status" = 'dismissed'
  );
--> statement-breakpoint
-- 2. Add the column.
ALTER TABLE "suggestions" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
-- 3. Backfill dedupe_key on the surviving pending rows (deterministic per
--    category+payload) so the partial unique index guards them immediately.
UPDATE "suggestions"
SET "dedupe_key" = CASE
  WHEN "category" = 'goal_gap'
    AND "action_type" = 'create_task'
    AND "action_payload"->>'goalId' IS NOT NULL
    AND coalesce("title", '') ILIKE '%has no tasks yet%'
    THEN 'goal_gap:no_tasks:' || ("action_payload"->>'goalId')
  WHEN "category" = 'goal_gap'
    AND "action_type" = 'create_task'
    AND "action_payload"->>'goalId' IS NOT NULL
    AND coalesce("title", '') ILIKE '%looks stalled%'
    THEN 'goal_gap:stalled:' || ("action_payload"->>'goalId')
  WHEN "category" = 'memory_gap'
    AND "action_type" = 'suggest_memory'
    AND "action_payload"->>'layer' = 'identity'
    THEN 'memory_gap:identity'
  WHEN "category" = 'memory_gap'
    AND "action_type" = 'suggest_memory'
    AND "action_payload"->>'departmentId' IS NOT NULL
    THEN 'memory_gap:domain:' || ("action_payload"->>'departmentId')
  WHEN "category" = 'memory_gap'
    AND "action_type" = 'archive_memory'
    AND "action_payload"->>'memoryItemId' IS NOT NULL
    THEN 'memory_gap:stale:' || ("action_payload"->>'memoryItemId')
  WHEN "category" = 'pattern_detected'
    AND "action_payload"->>'patternId' IS NOT NULL
    THEN 'pattern_detected:' || ("action_payload"->>'patternId')
  WHEN "category" = 'budget_optimization'
    AND coalesce("title", '') ILIKE '%company budget%'
    THEN 'budget_optimization:company'
  ELSE "dedupe_key"
END
WHERE "status" = 'pending' AND "dedupe_key" IS NULL;
--> statement-breakpoint
-- 4. Create the partial unique index (now safe — no pending dup violations remain).
CREATE UNIQUE INDEX IF NOT EXISTS "suggestions_pending_dedupe_idx" ON "suggestions" USING btree ("company_id","dedupe_key") WHERE status = 'pending' AND dedupe_key IS NOT NULL;
