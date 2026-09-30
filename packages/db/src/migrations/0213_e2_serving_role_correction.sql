-- Corrective E2 serving/operator-role gate (successor to E2-D03; Decision #123).
-- DELTA-FREE `--custom` migration under Decision #122/C14: the configured
-- drizzle schema cannot emit cluster roles, operation-level grants, or policies.
-- Every hand-authored statement is idempotent: guarded CREATE ROLE; attribute
-- ALTER/GRANT/ENABLE/FORCE natural re-apply; DROP POLICY IF EXISTS before CREATE.
-- aoa_app retains the 8 E2 grants and receives only traced JOB-010..014 legacy
-- operations. aoa_operator receives only null-Organization platform metadata.
-- Future enrollment/proof/revocation grants remain owned by JOB-002.
-- Generated from server/src/db/rls-tenant.ts; keep this file byte-for-byte aligned.
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aoa_app') THEN CREATE ROLE "aoa_app" NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; END IF; END $$;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
ALTER ROLE "aoa_app" NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aoa_operator') THEN CREATE ROLE "aoa_operator" NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; END IF; END $$;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
ALTER ROLE "aoa_operator" NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT, UPDATE ON "issues" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT, UPDATE ON "agents" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT ON "task_dependencies" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT ON "issue_labels" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT ON "labels" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT, UPDATE ON "notifications" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT INSERT ON "hub_audit" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT, INSERT, UPDATE ON "heartbeat_runs" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT, INSERT, UPDATE ON "agent_wakeup_requests" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT, UPDATE ON "discussion_entries" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT, INSERT, UPDATE ON "internal_agent_runs" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT, UPDATE ON "thread_orchestration_state" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT ON "internal_agent_conversations" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT ON "internal_agent_messages" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT ON "internal_agent_config" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT, UPDATE ON "companies" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT ON "organizations" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT, INSERT, UPDATE ON "approvals" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT, INSERT, UPDATE ON "agent_runtime_decisions" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT, INSERT, UPDATE ON "agent_runtime_trust_rules" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT, INSERT, UPDATE ON "internal_agent_runtime_approvals" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT, INSERT, UPDATE ON "internal_agent_tool_trust_rules" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT, INSERT, UPDATE, DELETE ON "budget_policies" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT, INSERT, UPDATE ON "budget_incidents" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT, INSERT ON "cost_events" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT, INSERT ON "activity_log" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT ON "projects" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT, INSERT, UPDATE ON "task_outputs" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT INSERT ON "issue_comments" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT ON "artifacts" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT ON "artifact_versions" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT ON "assets" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT ON "execution_workspaces" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT ON "workspace_runtime_services" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
GRANT SELECT, INSERT, UPDATE, DELETE ON "workers","execution_targets" TO "aoa_operator";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
ALTER TABLE "execution_targets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
ALTER TABLE "execution_targets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
DROP POLICY IF EXISTS "execution_targets_tenant_serving" ON "execution_targets";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; its guarded/natural/drop-before-create form is idempotent.
CREATE POLICY "execution_targets_tenant_serving" ON "execution_targets" FOR SELECT TO "aoa_app"
  USING (organization_id IS NULL OR organization_id = current_setting('aoa.organization_id', true)::uuid);
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
