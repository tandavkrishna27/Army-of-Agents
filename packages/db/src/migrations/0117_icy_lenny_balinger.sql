-- Phase 1 (Task A2): extend discussions with thread-native coordination
-- columns + canonicalize visibility values (open|private -> private|department|company).
--
-- Coordinated changes shipped together:
--   1. New defaults flip "visibility" / "default_thread_visibility" to 'company'.
--   2. Five new columns on discussions (shareToken, slackChannelId,
--      allowMemoryExtraction, adjutantEnabled, summaryEmbedding).
--   3. Backfill legacy "open" rows to "company" so existing data passes the
--      new ThreadVisibilitySchema (private|department|company).
--   4. Defensive HNSW index on summary_embedding, wrapped in DO/EXCEPTION so
--      embedded-postgres bundles (no pgvector) log a NOTICE and continue —
--      matches the established 0083 / 0115 pattern. The runtime gate lives
--      in probeDbCapabilities() (server/src/services/db-capabilities.ts).
--
-- The summary_embedding ADD COLUMN is conditional on pgvector being installed,
-- mirroring 0038's memory_items.embedding pattern — without the guard, the
-- migration fails on embedded-postgres / vanilla CI Postgres before the
-- DO/EXCEPTION block at the bottom gets a chance to run.

ALTER TABLE "discussions" ALTER COLUMN "visibility" SET DEFAULT 'company';--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "default_thread_visibility" SET DEFAULT 'company';--> statement-breakpoint
ALTER TABLE "discussions" ADD COLUMN "share_token" text;--> statement-breakpoint
ALTER TABLE "discussions" ADD COLUMN "slack_channel_id" text;--> statement-breakpoint
ALTER TABLE "discussions" ADD COLUMN "allow_memory_extraction" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "discussions" ADD COLUMN "adjutant_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint

-- pgvector-gated column add (mirrors 0038 memory_items.embedding pattern).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    ALTER TABLE "discussions" ADD COLUMN "summary_embedding" vector(1536);
  END IF;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;--> statement-breakpoint

ALTER TABLE "discussions" ADD CONSTRAINT "discussions_share_token_unique" UNIQUE("share_token");--> statement-breakpoint

-- Backfill legacy "open" rows to the new canonical "company" tier.
UPDATE "discussions" SET "visibility" = 'company' WHERE "visibility" = 'open';--> statement-breakpoint
UPDATE "projects" SET "default_thread_visibility" = 'company' WHERE "default_thread_visibility" = 'open';--> statement-breakpoint

-- Defensive HNSW index for cross-thread semantic retrieval on summary_embedding.
-- pgvector is preflight-enabled by migration 0115; if it is unavailable
-- (embedded-postgres bundles, CI postgres:16 without the extension) the
-- column itself was skipped above, so the index creation below also no-ops
-- — the inner IF gate guards the column reference and the outer EXCEPTION
-- catches any other pgvector-version mismatch (no HNSW in pgvector < 0.5.0).
-- Runtime code gates via probeDbCapabilities() so the missing index is
-- non-fatal.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    CREATE INDEX IF NOT EXISTS "discussions_summary_embedding_hnsw_idx"
      ON "discussions" USING hnsw ("summary_embedding" vector_cosine_ops);
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Skipping HNSW index on discussions.summary_embedding (pgvector unavailable): %', SQLERRM;
END $$;
