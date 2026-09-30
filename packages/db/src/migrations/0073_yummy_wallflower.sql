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
ALTER TABLE "memory_items" ADD COLUMN "folder_path" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN "last_accessed_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN "founder_pinned_to_top" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_assets" ADD CONSTRAINT "memory_assets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_assets" ADD CONSTRAINT "memory_assets_department_id_projects_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_assets" ADD CONSTRAINT "memory_assets_import_job_id_file_import_jobs_id_fk" FOREIGN KEY ("import_job_id") REFERENCES "public"."file_import_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_folders" ADD CONSTRAINT "memory_folders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_folders" ADD CONSTRAINT "memory_folders_department_id_projects_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_assets_company_idx" ON "memory_assets" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_assets_company_folder_idx" ON "memory_assets" USING btree ("company_id","department_id","folder_path");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_assets_import_job_idx" ON "memory_assets" USING btree ("import_job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_folders_company_idx" ON "memory_folders" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_folders_dept_path_idx" ON "memory_folders" USING btree ("company_id","department_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memory_folders_unique_path_per_company" ON "memory_folders" USING btree ("company_id","path");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_items_folder_path_idx" ON "memory_items" USING btree ("company_id","department_id","folder_path");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_items_founder_pinned_idx" ON "memory_items" USING btree ("company_id","founder_pinned_to_top","status");