-- DAT-006 Decision #122 custom security DDL. drizzle-kit cannot express role grants,
-- FORCE RLS, or policies. Every statement is naturally idempotent or drop-before-create
-- per C14. Mirrors 0228/0231/0237: aoa_app-only tenant DML, no operator authority, FORCE
-- RLS, one org-scoped tenant-isolation policy. This is the TEN-006 per-table RLS for the
-- NEW `folder_grants` table (the keystone the legacy-grants certificate set bumps for).

-- ---- folder_grants ----------------------------------------------------------
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; REVOKE is idempotent.
REVOKE ALL ON "folder_grants" FROM PUBLIC;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; REVOKE is idempotent.
REVOKE ALL ON "folder_grants" FROM "aoa_operator";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; GRANT is idempotent.
GRANT SELECT, INSERT, UPDATE, DELETE ON "folder_grants" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; ALTER is naturally convergent.
ALTER TABLE "folder_grants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; ALTER is naturally convergent.
ALTER TABLE "folder_grants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; DROP IF EXISTS is idempotent.
DROP POLICY IF EXISTS "folder_grants_tenant_isolation" ON "folder_grants";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; drop-before-create makes it idempotent.
CREATE POLICY "folder_grants_tenant_isolation" ON "folder_grants" TO "aoa_app"
  USING (organization_id = current_setting('aoa.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('aoa.organization_id', true)::uuid);
