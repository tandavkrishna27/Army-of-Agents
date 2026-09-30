-- DEP-009 Decision #122 custom security DDL. drizzle-kit cannot express role grants,
-- FORCE RLS, or policies. Every statement is naturally idempotent or drop-before-create
-- per C14. Mirrors 0228/0231/0235/0237: aoa_app-only tenant DML, no operator authority,
-- FORCE RLS, one org-scoped tenant-isolation policy keyed on the aoa.organization_id GUC.
-- This is the per-table RLS for the NEW `worker_admission_rate_limits` table — the SHARED
-- admission rate-limit counter both control-plane replicas increment under RLS.

-- ---- worker_admission_rate_limits -------------------------------------------
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; REVOKE is idempotent.
REVOKE ALL ON "worker_admission_rate_limits" FROM PUBLIC;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; REVOKE is idempotent.
REVOKE ALL ON "worker_admission_rate_limits" FROM "aoa_operator";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; GRANT is idempotent.
GRANT SELECT, INSERT, UPDATE, DELETE ON "worker_admission_rate_limits" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; ALTER is naturally convergent.
ALTER TABLE "worker_admission_rate_limits" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; ALTER is naturally convergent.
ALTER TABLE "worker_admission_rate_limits" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; DROP IF EXISTS is idempotent.
DROP POLICY IF EXISTS "worker_admission_rate_limits_tenant_isolation" ON "worker_admission_rate_limits";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; drop-before-create makes it idempotent.
CREATE POLICY "worker_admission_rate_limits_tenant_isolation" ON "worker_admission_rate_limits" TO "aoa_app"
  USING (organization_id = current_setting('aoa.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('aoa.organization_id', true)::uuid);
