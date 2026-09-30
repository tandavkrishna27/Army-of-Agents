CREATE TABLE IF NOT EXISTS "company_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"markdown" text NOT NULL,
	"source_type" text DEFAULT 'local_path' NOT NULL,
	"source_locator" text,
	"source_ref" text,
	"trust_level" text DEFAULT 'markdown_only' NOT NULL,
	"compatibility" text DEFAULT 'compatible' NOT NULL,
	"file_inventory" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "skill_keys" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "company_memberships" ADD COLUMN IF NOT EXISTS "is_system_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "company_skills" ADD CONSTRAINT "company_skills_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_skills_company_key_idx" ON "company_skills" USING btree ("company_id","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_skills_company_name_idx" ON "company_skills" USING btree ("company_id","name");