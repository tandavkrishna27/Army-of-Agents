-- Adds an HNSW index on memory_items.embedding for fast cosine-distance retrieval.
-- Conditional on pgvector being installed (matches the 0038 column-add pattern).
-- Partial index: skips rows where embedding is NULL (the common case until the
-- background processEmbeddingQueue worker has populated them).
--
-- HNSW chosen over IVFFlat because AoA's ingest pattern is incremental
-- (10 items/batch via processEmbeddingQueue with exponential backoff retry),
-- not bulk. HNSW gives better recall, no `lists` tuning, no rebuild after
-- inserts. Cost: ~2x memory of IVFFlat; trade is favorable for the expected
-- per-tenant scale (hundreds to low thousands of approved memory items).
--
-- Closes finding C12 from the 2026-05-05 codebase review.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    CREATE INDEX IF NOT EXISTS "memory_items_embedding_hnsw_idx"
      ON "memory_items" USING hnsw ("embedding" vector_cosine_ops)
      WHERE "embedding" IS NOT NULL;
  END IF;
EXCEPTION
  WHEN feature_not_supported OR undefined_object THEN
    RAISE NOTICE 'HNSW index skipped: pgvector version does not support HNSW (need ≥ 0.5.0)';
END $$;
