CREATE TABLE IF NOT EXISTS "hub_autopilot_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"mode" text DEFAULT 'off' NOT NULL,
	"rules" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hub_audit" ADD COLUMN IF NOT EXISTS "decision_context" jsonb;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "hub_autopilot_policies" ADD CONSTRAINT "hub_autopilot_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hub_autopilot_policies_company_idx" ON "hub_autopilot_policies" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hub_autopilot_policies_company_uq" ON "hub_autopilot_policies" USING btree ("company_id");
