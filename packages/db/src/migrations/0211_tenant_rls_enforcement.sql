-- TEN-002 (E2-D01 / product Decision #122): tenant RLS enforcement for the 8
-- new-path distributed-execution tables. DELTA-FREE `--custom` migration: CREATE
-- ROLE / GRANT / ENABLE + FORCE ROW LEVEL SECURITY / CREATE POLICY are
-- cluster/security DDL that `drizzle-kit generate` CANNOT emit under this repo's
-- config (no entities.roles, no pgPolicy in schema; verified against
-- drizzle-orm@0.45.2 / drizzle-kit@0.31.10), so the entire block is C14
-- hand-authored into the empty custom stub (there is no schema delta to diff onto).
-- Every statement is idempotent (DO $$ IF NOT EXISTS role guard; GRANT/ENABLE/FORCE
-- are natural no-ops on re-apply; DROP POLICY IF EXISTS before CREATE POLICY) so a
-- re-apply under the migration advisory lock is a no-op. The role is created NOLOGIN
-- with NO committed credential; the login credential is provisioned at boot from env
-- (E2-D03, server/src/index.ts). FORCE (E2-F004) is defense-in-depth against a
-- non-superuser-owner mistake; the DB-enforcement guarantee is that aoa_app is
-- non-owner + NOSUPERUSER + NOBYPASSRLS. Authored by the pure builders in
-- server/src/db/rls-tenant.ts (buildTenantRlsMigrationSql) - keep them in sync.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aoa_app') THEN CREATE ROLE "aoa_app" NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; END IF; END $$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "jobs","job_attempts","leases","workers","services","service_instances","job_artifacts","job_secret_handles" TO "aoa_app";
--> statement-breakpoint
ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "jobs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "jobs_tenant_isolation" ON "jobs";
--> statement-breakpoint
CREATE POLICY "jobs_tenant_isolation" ON "jobs" TO "aoa_app"
  USING (organization_id = current_setting('aoa.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('aoa.organization_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "job_attempts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "job_attempts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "job_attempts_tenant_isolation" ON "job_attempts";
--> statement-breakpoint
CREATE POLICY "job_attempts_tenant_isolation" ON "job_attempts" TO "aoa_app"
  USING (organization_id = current_setting('aoa.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('aoa.organization_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "leases" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "leases" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "leases_tenant_isolation" ON "leases";
--> statement-breakpoint
CREATE POLICY "leases_tenant_isolation" ON "leases" TO "aoa_app"
  USING (organization_id = current_setting('aoa.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('aoa.organization_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "workers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workers" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "workers_tenant_isolation" ON "workers";
--> statement-breakpoint
CREATE POLICY "workers_tenant_isolation" ON "workers" TO "aoa_app"
  USING (organization_id = current_setting('aoa.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('aoa.organization_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "services" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "services" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "services_tenant_isolation" ON "services";
--> statement-breakpoint
CREATE POLICY "services_tenant_isolation" ON "services" TO "aoa_app"
  USING (organization_id = current_setting('aoa.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('aoa.organization_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "service_instances" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "service_instances" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "service_instances_tenant_isolation" ON "service_instances";
--> statement-breakpoint
CREATE POLICY "service_instances_tenant_isolation" ON "service_instances" TO "aoa_app"
  USING (organization_id = current_setting('aoa.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('aoa.organization_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "job_artifacts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "job_artifacts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "job_artifacts_tenant_isolation" ON "job_artifacts";
--> statement-breakpoint
CREATE POLICY "job_artifacts_tenant_isolation" ON "job_artifacts" TO "aoa_app"
  USING (organization_id = current_setting('aoa.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('aoa.organization_id', true)::uuid);
--> statement-breakpoint
ALTER TABLE "job_secret_handles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "job_secret_handles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "job_secret_handles_tenant_isolation" ON "job_secret_handles";
--> statement-breakpoint
CREATE POLICY "job_secret_handles_tenant_isolation" ON "job_secret_handles" TO "aoa_app"
  USING (organization_id = current_setting('aoa.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('aoa.organization_id', true)::uuid);