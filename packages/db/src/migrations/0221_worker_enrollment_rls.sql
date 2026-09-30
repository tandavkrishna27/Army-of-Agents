-- JOB-002 Decision #122 custom security DDL. drizzle-kit cannot express roles,
-- operation/column grants, FORCE RLS, or policies. Every statement is
-- guarded, naturally idempotent, or drop-before-create per C14.
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aoa_app') THEN CREATE ROLE "aoa_app" NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; END IF; END $$;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aoa_operator') THEN CREATE ROLE "aoa_operator" NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; END IF; END $$;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
ALTER ROLE "aoa_app" NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
ALTER ROLE "aoa_operator" NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
REVOKE ALL ON "worker_enrollment_code_routes" FROM PUBLIC;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
REVOKE ALL ON "worker_enrollment_codes" FROM PUBLIC;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
REVOKE ALL ON "worker_proof_replays" FROM PUBLIC;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT, INSERT, DELETE ON "worker_enrollment_code_routes" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT, INSERT, UPDATE, DELETE ON "worker_enrollment_codes" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT, INSERT, DELETE ON "worker_proof_replays" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT ("id", "organization_id", "owner_user_id", "scope", "target_authority_key", "status", "device_generation", "capabilities") ON "execution_targets" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT UPDATE ("worker_token_hash", "device_generation", "status", "last_seen_at", "updated_at") ON "execution_targets" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT, INSERT, UPDATE, DELETE ON "workers" TO "aoa_operator";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT, INSERT, DELETE ON "worker_enrollment_code_routes" TO "aoa_operator";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT, INSERT, UPDATE, DELETE ON "worker_enrollment_codes" TO "aoa_operator";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT, INSERT, DELETE ON "worker_proof_replays" TO "aoa_operator";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT ("id", "organization_id", "owner_user_id", "slug", "kind", "trust_class", "status", "capabilities", "scope", "target_authority_key", "device_generation", "last_seen_at", "created_at", "updated_at") ON "execution_targets" TO "aoa_operator";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT UPDATE ("worker_token_hash", "device_generation", "status", "last_seen_at", "updated_at") ON "execution_targets" TO "aoa_operator";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
ALTER TABLE "worker_enrollment_code_routes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
ALTER TABLE "worker_enrollment_code_routes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
ALTER TABLE "worker_enrollment_codes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
ALTER TABLE "worker_enrollment_codes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
ALTER TABLE "worker_proof_replays" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
ALTER TABLE "worker_proof_replays" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
DROP POLICY IF EXISTS "worker_enrollment_code_routes_tenant_isolation" ON "worker_enrollment_code_routes";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
CREATE POLICY "worker_enrollment_code_routes_tenant_isolation" ON "worker_enrollment_code_routes" FOR ALL TO "aoa_app"
  USING (candidate_organization_id = current_setting('aoa.organization_id', true)::uuid)
  WITH CHECK (candidate_organization_id = current_setting('aoa.organization_id', true)::uuid);
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
DROP POLICY IF EXISTS "worker_enrollment_codes_tenant_isolation" ON "worker_enrollment_codes";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
CREATE POLICY "worker_enrollment_codes_tenant_isolation" ON "worker_enrollment_codes" TO "aoa_app"
  USING (organization_id = current_setting('aoa.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('aoa.organization_id', true)::uuid);
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
DROP POLICY IF EXISTS "worker_proof_replays_tenant_isolation" ON "worker_proof_replays";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
CREATE POLICY "worker_proof_replays_tenant_isolation" ON "worker_proof_replays" TO "aoa_app"
  USING (organization_id = current_setting('aoa.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('aoa.organization_id', true)::uuid);
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
DROP POLICY IF EXISTS "worker_enrollment_code_routes_platform_operator" ON "worker_enrollment_code_routes";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
CREATE POLICY "worker_enrollment_code_routes_platform_operator" ON "worker_enrollment_code_routes" FOR ALL TO "aoa_operator"
  USING (candidate_organization_id IS NULL)
  WITH CHECK (candidate_organization_id IS NULL);
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
DROP POLICY IF EXISTS "worker_enrollment_code_routes_operator_discovery" ON "worker_enrollment_code_routes";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
CREATE POLICY "worker_enrollment_code_routes_operator_discovery" ON "worker_enrollment_code_routes" FOR SELECT TO "aoa_operator"
  USING (true);
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
DROP POLICY IF EXISTS "worker_enrollment_codes_platform_operator" ON "worker_enrollment_codes";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
CREATE POLICY "worker_enrollment_codes_platform_operator" ON "worker_enrollment_codes" FOR ALL TO "aoa_operator"
  USING (organization_id IS NULL)
  WITH CHECK (organization_id IS NULL);
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
DROP POLICY IF EXISTS "worker_proof_replays_platform_operator" ON "worker_proof_replays";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
CREATE POLICY "worker_proof_replays_platform_operator" ON "worker_proof_replays" FOR ALL TO "aoa_operator"
  USING (organization_id IS NULL)
  WITH CHECK (organization_id IS NULL);
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
DROP POLICY IF EXISTS "workers_platform_operator" ON "workers";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
CREATE POLICY "workers_platform_operator" ON "workers" TO "aoa_operator"
  USING (organization_id IS NULL AND scope = 'platform')
  WITH CHECK (organization_id IS NULL AND scope = 'platform');
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
DROP POLICY IF EXISTS "execution_targets_platform_operator" ON "execution_targets";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
CREATE POLICY "execution_targets_platform_operator" ON "execution_targets" TO "aoa_operator"
  USING (organization_id IS NULL AND owner_user_id IS NULL)
  WITH CHECK (organization_id IS NULL AND owner_user_id IS NULL);
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
DROP POLICY IF EXISTS "execution_targets_tenant_enrollment_update" ON "execution_targets";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
CREATE POLICY "execution_targets_tenant_enrollment_update" ON "execution_targets" FOR UPDATE TO "aoa_app"
  USING (organization_id = current_setting('aoa.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('aoa.organization_id', true)::uuid);
