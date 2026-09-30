-- JOB-001 Decision #122 custom security DDL. drizzle-kit cannot express roles,
-- operation grants, FORCE RLS, or policies. Every statement is naturally
-- idempotent or guarded/drop-before-create per C14.
-- C14 hand-authored security DDL: guarded role creation.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aoa_app') THEN CREATE ROLE "aoa_app" NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; END IF; END $$;
--> statement-breakpoint
-- C14 hand-authored security DDL: role posture is a natural idempotent ALTER.
ALTER ROLE "aoa_app" NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
--> statement-breakpoint
-- C14 hand-authored security DDL: remove ambient public authority first.
REVOKE ALL ON "job_outbox" FROM PUBLIC;
--> statement-breakpoint
-- C14 hand-authored security DDL: exact new-path outbox operations.
GRANT SELECT, INSERT, UPDATE, DELETE ON "job_outbox" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: admission edge is read-only.
GRANT SELECT ON "organization_memberships" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: remove any ambient whole-table MCP authority.
REVOKE ALL ON "mcp_api_keys" FROM "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: authenticated MCP revalidation sees identifiers/status only, never key hashes.
GRANT SELECT ("id", "company_id", "user_id", "revoked_at") ON "mcp_api_keys" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: natural idempotent RLS enablement.
ALTER TABLE "job_outbox" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- C14 hand-authored security DDL: defense-in-depth against an owner mistake.
ALTER TABLE "job_outbox" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- C14 hand-authored security DDL: drop-before-create policy replay guard.
DROP POLICY IF EXISTS "job_outbox_tenant_isolation" ON "job_outbox";
--> statement-breakpoint
-- C14 hand-authored security DDL: tenant GUC gates reads and writes.
CREATE POLICY "job_outbox_tenant_isolation" ON "job_outbox" TO "aoa_app"
  USING (organization_id = current_setting('aoa.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('aoa.organization_id', true)::uuid);
