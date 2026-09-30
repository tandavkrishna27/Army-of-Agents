CREATE TABLE IF NOT EXISTS "provider_readiness_status" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid,
	"outcome" text NOT NULL,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tested_by_user_id" text,
	CONSTRAINT "provider_readiness_scope_uq" UNIQUE NULLS NOT DISTINCT("company_id","provider_id","scope_type","scope_id"),
	CONSTRAINT "provider_readiness_scope_shape_check" CHECK ((scope_type = 'company_default' AND scope_id IS NULL) OR (scope_type = 'agent' AND scope_id IS NOT NULL))
);
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "provider_readiness_status" ADD CONSTRAINT "provider_readiness_status_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "provider_readiness_status" ADD CONSTRAINT "provider_readiness_status_tested_by_user_id_user_id_fk" FOREIGN KEY ("tested_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;