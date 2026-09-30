CREATE TABLE IF NOT EXISTS "internal_agent_runtime_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"conversation_id" uuid,
	"run_id" uuid,
	"user_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"params" jsonb NOT NULL,
	"params_hash" text NOT NULL,
	"params_hash_version" text DEFAULT 'v1' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"decision" text,
	"executed_at" timestamp with time zone,
	"result_summary" text,
	"result_error" text,
	"result_entity_type" text,
	"result_entity_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "internal_agent_tool_trust_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"params_hash" text NOT NULL,
	"params_hash_version" text DEFAULT 'v1' NOT NULL,
	"scope" text DEFAULT 'exact_params' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by_user_id" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_outputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"issue_id" uuid NOT NULL,
	"type" text NOT NULL,
	"provider" text DEFAULT 'aoa' NOT NULL,
	"external_id" text,
	"artifact_id" uuid,
	"artifact_version_id" uuid,
	"asset_id" uuid,
	"execution_workspace_id" uuid,
	"runtime_service_id" uuid,
	"url" text,
	"title" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"review_state" text DEFAULT 'none' NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"health_status" text DEFAULT 'unknown' NOT NULL,
	"summary" text,
	"metadata" jsonb,
	"created_by_run_id" uuid,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "internal_agent_config" ADD COLUMN "runtime_approvals_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "internal_agent_config" ADD COLUMN "runtime_allow_always_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "internal_agent_config" ADD COLUMN "vendor_cli_bypass_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "internal_agent_runtime_approvals" ADD CONSTRAINT "internal_agent_runtime_approvals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_agent_runtime_approvals" ADD CONSTRAINT "internal_agent_runtime_approvals_conversation_id_internal_agent_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."internal_agent_conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_agent_runtime_approvals" ADD CONSTRAINT "internal_agent_runtime_approvals_run_id_internal_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."internal_agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_agent_tool_trust_rules" ADD CONSTRAINT "internal_agent_tool_trust_rules_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_outputs" ADD CONSTRAINT "task_outputs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_outputs" ADD CONSTRAINT "task_outputs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_outputs" ADD CONSTRAINT "task_outputs_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_outputs" ADD CONSTRAINT "task_outputs_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_outputs" ADD CONSTRAINT "task_outputs_artifact_version_id_artifact_versions_id_fk" FOREIGN KEY ("artifact_version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_outputs" ADD CONSTRAINT "task_outputs_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_outputs" ADD CONSTRAINT "task_outputs_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_outputs" ADD CONSTRAINT "task_outputs_runtime_service_id_workspace_runtime_services_id_fk" FOREIGN KEY ("runtime_service_id") REFERENCES "public"."workspace_runtime_services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_outputs" ADD CONSTRAINT "task_outputs_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_outputs" ADD CONSTRAINT "task_outputs_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_outputs" ADD CONSTRAINT "task_outputs_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ia_runtime_approvals_company_status_expiry_idx" ON "internal_agent_runtime_approvals" USING btree ("company_id","status","expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ia_runtime_approvals_company_user_status_idx" ON "internal_agent_runtime_approvals" USING btree ("company_id","user_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ia_runtime_approvals_run_idx" ON "internal_agent_runtime_approvals" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ia_runtime_approvals_tool_idx" ON "internal_agent_runtime_approvals" USING btree ("tool_name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ia_tool_trust_rules_exact_params_uq" ON "internal_agent_tool_trust_rules" USING btree ("company_id","user_id","tool_name","params_hash","params_hash_version","scope");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ia_tool_trust_rules_company_user_enabled_idx" ON "internal_agent_tool_trust_rules" USING btree ("company_id","user_id","enabled");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ia_tool_trust_rules_company_tool_idx" ON "internal_agent_tool_trust_rules" USING btree ("company_id","tool_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_outputs_company_issue_type_idx" ON "task_outputs" USING btree ("company_id","issue_id","type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_outputs_company_issue_primary_idx" ON "task_outputs" USING btree ("company_id","issue_id","is_primary");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_outputs_company_workspace_type_idx" ON "task_outputs" USING btree ("company_id","execution_workspace_id","type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_outputs_company_runtime_service_idx" ON "task_outputs" USING btree ("company_id","runtime_service_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_outputs_company_artifact_idx" ON "task_outputs" USING btree ("company_id","artifact_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "task_outputs_company_issue_provider_external_uq" ON "task_outputs" USING btree ("company_id","issue_id","provider","external_id") WHERE external_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_outputs_company_updated_idx" ON "task_outputs" USING btree ("company_id","updated_at");