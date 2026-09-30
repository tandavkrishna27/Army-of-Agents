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
ALTER TABLE "memory_items" ADD COLUMN "import_job_id" uuid;--> statement-breakpoint
ALTER TABLE "file_import_jobs" ADD CONSTRAINT "file_import_jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_import_jobs" ADD CONSTRAINT "file_import_jobs_department_id_projects_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_import_jobs" ADD CONSTRAINT "file_import_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "file_import_jobs_company_idx" ON "file_import_jobs" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "file_import_jobs_status_idx" ON "file_import_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "file_import_jobs_pending_idx" ON "file_import_jobs" USING btree ("status","retry_after","created_at");--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_import_job_id_file_import_jobs_id_fk" FOREIGN KEY ("import_job_id") REFERENCES "public"."file_import_jobs"("id") ON DELETE set null ON UPDATE no action;