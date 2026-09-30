-- QA-BUG-008 corrective: ensure discussions.summary_embedding and
-- discussion_extracted_items.embedding columns ALWAYS exist, even when
-- the database lacks pgvector.
--
-- Root cause (found by /investigate during QA-3 Discussions pass):
--
-- Migrations 0117 and 0118 conditionally ADD COLUMN gated by
-- `IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')`.
-- That gate matches the established 0038/0115 pattern for safe embedded-
-- postgres operation. The problem: the Drizzle schemas
-- (packages/db/src/schema/discussions.ts) declare these as
-- `vector("summary_embedding")` / `vector("embedding")` UNCONDITIONALLY,
-- so the query builder always lists them in SELECT column lists.
--
-- Production effect on embedded-postgres installs (no pgvector):
--   GET /api/companies/:cid/discussions
--   → Failed query: SELECT ..., "summary_embedding", ... FROM "discussions"
--   → 500 (column does not exist)
--
-- Memory has the analogous risk on memory_items.embedding but mitigates
-- it with the memory-projection.ts helper that explicitly enumerates the
-- safe columns and conditionally appends embedding. Discussions has 50+
-- callsites doing `db.select().from(discussions)` without an analogous
-- helper — refactoring all of them is high-blast-radius for a QA fix.
--
-- Chosen mitigation: ALWAYS add the column. Type is `text` on installs
-- without pgvector. This is sufficient because:
--   1. Every code path that *writes* to these columns first checks
--      getDbCapabilities().hasVectorSupport (see embeddings.ts:125, 204
--      and the write-behind queue gate). On no-pgvector installs the
--      column stays NULL forever and Drizzle's vector custom-type
--      fromDriver() is never invoked.
--   2. Drizzle's column-level nullability handles SELECT-NULL reads
--      without calling the custom type's deserializer.
--   3. On installs WHERE pgvector is available, 0117/0118 already added
--      the column as vector(1536); ADD COLUMN IF NOT EXISTS no-ops.
--
-- Future-pgvector-enable note: if a user later enables pgvector on a
-- previously-stubbed install, they need a one-time
--   ALTER TABLE discussions ALTER COLUMN summary_embedding TYPE vector(1536)
--   USING NULL::vector(1536);
-- (and same for discussion_extracted_items.embedding) — captured in
-- docs/deploy/pgvector-enablement.md. Same column shape (NULL) means no
-- data loss; only the type changes.

ALTER TABLE "discussions"
  ADD COLUMN IF NOT EXISTS "summary_embedding" text;--> statement-breakpoint

ALTER TABLE "discussion_extracted_items"
  ADD COLUMN IF NOT EXISTS "embedding" text;
