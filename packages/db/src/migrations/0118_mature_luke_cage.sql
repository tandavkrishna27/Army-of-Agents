-- Phase 1 (Task A3): per-item embedding on discussion_extracted_items for
-- cross-thread semantic retrieval, source-thread provenance on issues for
-- tasks spawned by Dispatcher from a thread's scope_proposal.
--
-- Coordinated changes shipped together:
--   1. New "embedding" column on discussion_extracted_items, gated on
--      pgvector being installed (mirrors 0117 summary_embedding pattern).
--   2. New "source_discussion_id" FK column on issues (ON DELETE SET NULL —
--      task survives if the originating thread is deleted).
--   3. Defensive HNSW index on discussion_extracted_items.embedding for
--      cosine-similarity retrieval, wrapped in DO/EXCEPTION so embedded
--      postgres bundles (no pgvector) log a NOTICE and continue — matches
--      the established 0083 / 0115 / 0117 pattern. Runtime gating lives
--      in probeDbCapabilities() (server/src/services/db-capabilities.ts).

-- pgvector-gated column add (mirrors 0038 / 0117 pattern). The ADD COLUMN
-- would fail before the HNSW DO block has a chance to run on plain Postgres
-- without pgvector, so we gate the column itself the same way.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    ALTER TABLE "discussion_extracted_items" ADD COLUMN "embedding" vector(1536);
  END IF;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;--> statement-breakpoint

ALTER TABLE "issues" ADD COLUMN "source_discussion_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_source_discussion_id_discussions_id_fk" FOREIGN KEY ("source_discussion_id") REFERENCES "public"."discussions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- Defensive HNSW index for cross-thread semantic retrieval on the per-item
-- embedding column. pgvector is preflight-enabled by migration 0115; if it
-- is unavailable (embedded-postgres bundles, CI postgres:16 without the
-- extension) the column itself was skipped above, so the index creation
-- below also no-ops — the inner IF gate guards the column reference and the
-- outer EXCEPTION catches any other pgvector-version mismatch (no HNSW in
-- pgvector < 0.5.0). Runtime code gates via probeDbCapabilities() so the
-- missing index is non-fatal.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    CREATE INDEX IF NOT EXISTS "discussion_extracted_items_embedding_hnsw_idx"
      ON "discussion_extracted_items" USING hnsw ("embedding" vector_cosine_ops);
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Skipping HNSW index on discussion_extracted_items.embedding (pgvector unavailable): %', SQLERRM;
END $$;
