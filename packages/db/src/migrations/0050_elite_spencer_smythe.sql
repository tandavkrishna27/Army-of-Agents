CREATE TABLE "execution_workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"project_workspace_id" uuid,
	"source_issue_id" uuid,
	"mode" text NOT NULL,
	"strategy_type" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"cwd" text,
	"repo_url" text,
	"base_ref" text,
	"branch_name" text,
	"provider_type" text DEFAULT 'local_fs' NOT NULL,
	"provider_ref" text,
	"derived_from_execution_workspace_id" uuid,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"cleanup_eligible_at" timestamp with time zone,
	"cleanup_reason" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"execution_workspace_id" uuid,
	"heartbeat_run_id" uuid,
	"phase" text NOT NULL,
	"command" text,
	"cwd" text,
	"status" text DEFAULT 'running' NOT NULL,
	"exit_code" integer,
	"log_store" text,
	"log_ref" text,
	"log_bytes" bigint,
	"log_sha256" text,
	"log_compressed" boolean DEFAULT false NOT NULL,
	"stdout_excerpt" text,
	"stderr_excerpt" text,
	"metadata" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_runtime_services" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"project_workspace_id" uuid,
	"execution_workspace_id" uuid,
	"issue_id" uuid,
	"scope_type" text NOT NULL,
	"scope_id" text,
	"service_name" text NOT NULL,
	"status" text NOT NULL,
	"lifecycle" text NOT NULL,
	"reuse_key" text,
	"command" text,
	"cwd" text,
	"port" integer,
	"url" text,
	"provider" text NOT NULL,
	"provider_ref" text,
	"owner_agent_id" uuid,
	"started_by_run_id" uuid,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone,
	"stop_policy" jsonb,
	"health_status" text DEFAULT 'unknown' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "execution_workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "execution_workspace_preference" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "execution_workspace_settings" jsonb;--> statement-breakpoint
ALTER TABLE "project_workspaces" ADD COLUMN "source_type" text DEFAULT 'local_path' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_workspaces" ADD COLUMN "default_ref" text;--> statement-breakpoint
ALTER TABLE "project_workspaces" ADD COLUMN "visibility" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_workspaces" ADD COLUMN "setup_command" text;--> statement-breakpoint
ALTER TABLE "project_workspaces" ADD COLUMN "cleanup_command" text;--> statement-breakpoint
ALTER TABLE "project_workspaces" ADD COLUMN "remote_provider" text;--> statement-breakpoint
ALTER TABLE "project_workspaces" ADD COLUMN "remote_workspace_ref" text;--> statement-breakpoint
ALTER TABLE "project_workspaces" ADD COLUMN "shared_workspace_key" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "execution_workspace_policy" jsonb;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD CONSTRAINT "execution_workspaces_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD CONSTRAINT "execution_workspaces_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD CONSTRAINT "execution_workspaces_project_workspace_id_project_workspaces_id_fk" FOREIGN KEY ("project_workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD CONSTRAINT "execution_workspaces_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD CONSTRAINT "execution_workspaces_derived_from_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("derived_from_execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_operations" ADD CONSTRAINT "workspace_operations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_operations" ADD CONSTRAINT "workspace_operations_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_operations" ADD CONSTRAINT "workspace_operations_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_runtime_services" ADD CONSTRAINT "workspace_runtime_services_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_runtime_services" ADD CONSTRAINT "workspace_runtime_services_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_runtime_services" ADD CONSTRAINT "workspace_runtime_services_project_workspace_id_project_workspaces_id_fk" FOREIGN KEY ("project_workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_runtime_services" ADD CONSTRAINT "workspace_runtime_services_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_runtime_services" ADD CONSTRAINT "workspace_runtime_services_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_runtime_services" ADD CONSTRAINT "workspace_runtime_services_owner_agent_id_agents_id_fk" FOREIGN KEY ("owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_runtime_services" ADD CONSTRAINT "workspace_runtime_services_started_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("started_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "execution_workspaces_company_project_status_idx" ON "execution_workspaces" USING btree ("company_id","project_id","status");--> statement-breakpoint
CREATE INDEX "execution_workspaces_company_project_workspace_status_idx" ON "execution_workspaces" USING btree ("company_id","project_workspace_id","status");--> statement-breakpoint
CREATE INDEX "execution_workspaces_company_source_issue_idx" ON "execution_workspaces" USING btree ("company_id","source_issue_id");--> statement-breakpoint
CREATE INDEX "execution_workspaces_company_last_used_idx" ON "execution_workspaces" USING btree ("company_id","last_used_at");--> statement-breakpoint
CREATE INDEX "execution_workspaces_company_branch_idx" ON "execution_workspaces" USING btree ("company_id","branch_name");--> statement-breakpoint
CREATE INDEX "workspace_operations_company_run_started_idx" ON "workspace_operations" USING btree ("company_id","heartbeat_run_id","started_at");--> statement-breakpoint
CREATE INDEX "workspace_operations_company_workspace_started_idx" ON "workspace_operations" USING btree ("company_id","execution_workspace_id","started_at");--> statement-breakpoint
CREATE INDEX "workspace_runtime_services_company_workspace_status_idx" ON "workspace_runtime_services" USING btree ("company_id","project_workspace_id","status");--> statement-breakpoint
CREATE INDEX "workspace_runtime_services_company_execution_workspace_status_idx" ON "workspace_runtime_services" USING btree ("company_id","execution_workspace_id","status");--> statement-breakpoint
CREATE INDEX "workspace_runtime_services_company_project_status_idx" ON "workspace_runtime_services" USING btree ("company_id","project_id","status");--> statement-breakpoint
CREATE INDEX "workspace_runtime_services_run_idx" ON "workspace_runtime_services" USING btree ("started_by_run_id");--> statement-breakpoint
CREATE INDEX "workspace_runtime_services_company_updated_idx" ON "workspace_runtime_services" USING btree ("company_id","updated_at");--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issues_company_execution_workspace_idx" ON "issues" USING btree ("company_id","execution_workspace_id");--> statement-breakpoint
CREATE INDEX "project_workspaces_project_source_type_idx" ON "project_workspaces" USING btree ("project_id","source_type");--> statement-breakpoint
CREATE INDEX "project_workspaces_company_shared_key_idx" ON "project_workspaces" USING btree ("company_id","shared_workspace_key");--> statement-breakpoint
CREATE UNIQUE INDEX "project_workspaces_project_remote_ref_idx" ON "project_workspaces" USING btree ("project_id","remote_provider","remote_workspace_ref");