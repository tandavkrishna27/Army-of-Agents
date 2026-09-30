CREATE TABLE IF NOT EXISTS "memory_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL REFERENCES "public"."companies"("id") ON DELETE cascade,
	"department_id" uuid REFERENCES "public"."projects"("id") ON DELETE cascade,
	"autonomy_level" text DEFAULT 'supervised' NOT NULL,
	"active_context_tier" text DEFAULT 'durable' NOT NULL,
	"retention_days" integer DEFAULT 90 NOT NULL,
	"legal_hold" boolean DEFAULT false NOT NULL,
	"run_miner_enabled" boolean DEFAULT true NOT NULL,
	"run_miner_budget_cents" integer,
	"external_screening_enabled" boolean DEFAULT true NOT NULL,
	"private_memory_enabled" boolean DEFAULT true NOT NULL,
	"working_memory_ttl_days" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN IF NOT EXISTS "owner_type" text;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN IF NOT EXISTS "owner_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN IF NOT EXISTS "tier" text;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN IF NOT EXISTS "confidence" integer;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN IF NOT EXISTS "provenance_kind" text;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN IF NOT EXISTS "source_ref" text;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN IF NOT EXISTS "trust" text;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN IF NOT EXISTS "effective_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN IF NOT EXISTS "effective_to" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN IF NOT EXISTS "invalidated_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memory_settings_company_dept_uq" ON "memory_settings" USING btree ("company_id","department_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memory_settings_company_default_uq" ON "memory_settings" USING btree ("company_id") WHERE "memory_settings"."department_id" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_settings_company_idx" ON "memory_settings" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memory_items_identity_mirror_uq" ON "memory_items" USING btree ("company_id","title") WHERE "memory_items"."layer" = 'identity' AND "memory_items"."source_context" = 'company:identity';
