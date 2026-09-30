CREATE TABLE IF NOT EXISTS "github_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"installation_id" text NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"github_host" text DEFAULT 'github.com' NOT NULL,
	"suspended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "issue_context_bundle_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"bundle_id" uuid NOT NULL,
	"item_type" text NOT NULL,
	"source_id" uuid,
	"label" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "issue_context_bundles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_issue_id" uuid NOT NULL,
	"target_issue_id" uuid NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"brief" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "issue_context_bundle_items" ADD CONSTRAINT "issue_context_bundle_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "issue_context_bundle_items" ADD CONSTRAINT "issue_context_bundle_items_bundle_id_issue_context_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."issue_context_bundles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "issue_context_bundles" ADD CONSTRAINT "issue_context_bundles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "issue_context_bundles" ADD CONSTRAINT "issue_context_bundles_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "issue_context_bundles" ADD CONSTRAINT "issue_context_bundles_target_issue_id_issues_id_fk" FOREIGN KEY ("target_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "issue_context_bundles" ADD CONSTRAINT "issue_context_bundles_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "issue_context_bundles" ADD CONSTRAINT "issue_context_bundles_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "github_installations_company_id_unique" ON "github_installations" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_installations_installation_id_idx" ON "github_installations" USING btree ("installation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_context_bundle_items_company_bundle_idx" ON "issue_context_bundle_items" USING btree ("company_id","bundle_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_context_bundle_items_company_type_source_idx" ON "issue_context_bundle_items" USING btree ("company_id","item_type","source_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_context_bundles_company_target_idx" ON "issue_context_bundles" USING btree ("company_id","target_issue_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_context_bundles_company_source_idx" ON "issue_context_bundles" USING btree ("company_id","source_issue_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "execution_workspaces_active_task_workspace_uq" ON "execution_workspaces" USING btree ("company_id","source_issue_id") WHERE source_issue_id IS NOT NULL AND status <> 'archived';
