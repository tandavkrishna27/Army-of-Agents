-- Pre-Task 0.5 (Thread-Native Agent Coordination Phase 1):
-- ensure the pgvector extension is enabled before any future Phase A
-- migration adds vector(1536) columns to memory_items, discussions, or
-- discussion_extracted_items.
--
-- Migration 0038 first attempted to enable pgvector and conditionally
-- added the memory_items.embedding column. This migration is the dedicated
-- preflight: it enables the extension (or no-ops on installs that don't
-- ship pgvector) so subsequent vector-column migrations can rely on
-- `vector` being a known type when present.
--
-- Idempotent across all targets:
--   * Postgres builds that ship pgvector (Docker postgres+pgvector, RDS
--     w/ extension allowlist, supabase, etc.) -> extension installed.
--   * Embedded-postgres bundle (server/src/index.ts) -> the bundled
--     vanilla Postgres does NOT ship pgvector. The EXCEPTION block lets
--     the migration log a NOTICE and continue rather than fail. Memory
--     code paths gate semantic search via probeDbCapabilities()
--     (server/src/services/db-capabilities.ts) and run fine without it.
--   * CI postgres:16 service (.github/workflows/pr.yml `migrations`
--     job) -> also vanilla; same NOTICE path.
--
-- Wrapped in DO $$ ... EXCEPTION to match the established defensive
-- pattern from migration 0038_marvelous_vapor.sql and the
-- 0083_memory_embedding_hnsw_index.sql HNSW guard. See Paperclip
-- Divergence notes / docs/architecture/decisions.md before changing.

DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgvector extension not available, skipping (vector columns will be gated by probeDbCapabilities)';
END $$;
