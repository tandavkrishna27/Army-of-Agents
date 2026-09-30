CREATE TABLE IF NOT EXISTS "file_import_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"file_size" integer NOT NULL,
	"storage_key" text NOT NULL,
	"processor_type" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"parser_warnings" jsonb,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"retry_after" timestamp with time zone,
	"department_id" uuid,
	"project_id" uuid,
	"default_layer" text DEFAULT 'domain' NOT NULL,
	"default_category" text DEFAULT 'reference' NOT NULL,
	"created_by" text NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"department_id" uuid,
	"folder_path" text DEFAULT '' NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"file_size" integer NOT NULL,
	"storage_key" text NOT NULL,
	"import_job_id" uuid,
	"extracted_item_count" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb,
	"uploaded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_extraction_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"total_files" integer DEFAULT 0 NOT NULL,
	"succeeded_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_extractions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"batch_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"input_type" text NOT NULL,
	"input_asset_id" uuid,
	"input_url" text,
	"extractor" text,
	"extracted_text" text,
	"extracted_metadata" jsonb,
	"progress_json" jsonb,
	"curator_run_id" uuid,
	"error_message" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"result_memory_item_id" uuid,
	"result_artifact_id" uuid,
	"created_by" text NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"department_id" uuid,
	"path" text NOT NULL,
	"display_name" text NOT NULL,
	"icon" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"seed_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"from_item_id" uuid NOT NULL,
	"to_item_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_retrievals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid,
	"run_id" uuid,
	"task_id" uuid,
	"triggered_by" text NOT NULL,
	"query" text,
	"item_id" uuid,
	"similarity_score" numeric(10, 6),
	"rank" integer,
	"shown_to_agent" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX IF EXISTS "plugins_plugin_key_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "marketplace_company_settings_company_id_unique";--> statement-breakpoint
ALTER TABLE "company_skills" ALTER COLUMN "customized" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN IF NOT EXISTS "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN IF NOT EXISTS "validation_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN IF NOT EXISTS "last_validated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN IF NOT EXISTS "pinned_to_skill" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN IF NOT EXISTS "import_job_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN IF NOT EXISTS "folder_path" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN IF NOT EXISTS "last_accessed_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN IF NOT EXISTS "founder_pinned_to_top" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "plugins" ADD COLUMN IF NOT EXISTS "company_id" uuid;--> statement-breakpoint
ALTER TABLE "plugins" ADD COLUMN IF NOT EXISTS "catalog_item_id" text;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "file_import_jobs" ADD CONSTRAINT "file_import_jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "file_import_jobs" ADD CONSTRAINT "file_import_jobs_department_id_projects_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "file_import_jobs" ADD CONSTRAINT "file_import_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "memory_assets" ADD CONSTRAINT "memory_assets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "memory_assets" ADD CONSTRAINT "memory_assets_department_id_projects_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "memory_assets" ADD CONSTRAINT "memory_assets_import_job_id_file_import_jobs_id_fk" FOREIGN KEY ("import_job_id") REFERENCES "public"."file_import_jobs"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "memory_extraction_batches" ADD CONSTRAINT "memory_extraction_batches_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "memory_extractions" ADD CONSTRAINT "memory_extractions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "memory_extractions" ADD CONSTRAINT "memory_extractions_batch_id_memory_extraction_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."memory_extraction_batches"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "memory_extractions" ADD CONSTRAINT "memory_extractions_input_asset_id_assets_id_fk" FOREIGN KEY ("input_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "memory_extractions" ADD CONSTRAINT "memory_extractions_curator_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("curator_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "memory_extractions" ADD CONSTRAINT "memory_extractions_result_memory_item_id_memory_items_id_fk" FOREIGN KEY ("result_memory_item_id") REFERENCES "public"."memory_items"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "memory_extractions" ADD CONSTRAINT "memory_extractions_result_artifact_id_artifacts_id_fk" FOREIGN KEY ("result_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "memory_folders" ADD CONSTRAINT "memory_folders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "memory_folders" ADD CONSTRAINT "memory_folders_department_id_projects_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "memory_relations" ADD CONSTRAINT "memory_relations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "memory_relations" ADD CONSTRAINT "memory_relations_from_item_id_memory_items_id_fk" FOREIGN KEY ("from_item_id") REFERENCES "public"."memory_items"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "memory_relations" ADD CONSTRAINT "memory_relations_to_item_id_memory_items_id_fk" FOREIGN KEY ("to_item_id") REFERENCES "public"."memory_items"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "memory_retrievals" ADD CONSTRAINT "memory_retrievals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "memory_retrievals" ADD CONSTRAINT "memory_retrievals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "memory_retrievals" ADD CONSTRAINT "memory_retrievals_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "memory_retrievals" ADD CONSTRAINT "memory_retrievals_task_id_issues_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "memory_retrievals" ADD CONSTRAINT "memory_retrievals_item_id_memory_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."memory_items"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "file_import_jobs_company_idx" ON "file_import_jobs" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "file_import_jobs_status_idx" ON "file_import_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "file_import_jobs_pending_idx" ON "file_import_jobs" USING btree ("status","retry_after","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_assets_company_idx" ON "memory_assets" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_assets_company_folder_idx" ON "memory_assets" USING btree ("company_id","department_id","folder_path");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_assets_import_job_idx" ON "memory_assets" USING btree ("import_job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_extraction_batches_company_created_idx" ON "memory_extraction_batches" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_extraction_batches_company_status_idx" ON "memory_extraction_batches" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_extractions_company_status_idx" ON "memory_extractions" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_extractions_batch_idx" ON "memory_extractions" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_extractions_result_memory_item_idx" ON "memory_extractions" USING btree ("result_memory_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_extractions_company_created_idx" ON "memory_extractions" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_folders_company_idx" ON "memory_folders" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_folders_dept_path_idx" ON "memory_folders" USING btree ("company_id","department_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memory_folders_unique_path_per_company" ON "memory_folders" USING btree ("company_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memory_relations_from_to_kind_uq" ON "memory_relations" USING btree ("from_item_id","to_item_id","kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_relations_company_from_idx" ON "memory_relations" USING btree ("company_id","from_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_relations_company_to_idx" ON "memory_relations" USING btree ("company_id","to_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_relations_company_kind_idx" ON "memory_relations" USING btree ("company_id","kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_retrievals_run_idx" ON "memory_retrievals" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_retrievals_company_created_idx" ON "memory_retrievals" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_retrievals_agent_created_idx" ON "memory_retrievals" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_retrievals_item_created_idx" ON "memory_retrievals" USING btree ("item_id","created_at");--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_import_job_id_file_import_jobs_id_fk" FOREIGN KEY ("import_job_id") REFERENCES "public"."file_import_jobs"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "plugins" ADD CONSTRAINT "plugins_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_items_agent_scope_idx" ON "memory_items" USING btree ("company_id","agent_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_items_pinned_skill_idx" ON "memory_items" USING btree ("company_id","pinned_to_skill","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_items_folder_path_idx" ON "memory_items" USING btree ("company_id","department_id","folder_path");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_items_founder_pinned_idx" ON "memory_items" USING btree ("company_id","founder_pinned_to_top","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plugins_company_plugin_key_idx" ON "plugins" USING btree ("company_id","plugin_key");
