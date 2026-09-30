CREATE TABLE IF NOT EXISTS "hub_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"company_id" uuid NOT NULL,
	"default_landing" text DEFAULT 'home' NOT NULL,
	"visible_lanes" jsonb NOT NULL,
	"group_mode" text DEFAULT 'auto' NOT NULL,
	"density" text DEFAULT 'comfortable' NOT NULL,
	"show_autopilot_entry" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hub_preferences" ADD CONSTRAINT "hub_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hub_preferences" ADD CONSTRAINT "hub_preferences_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hub_preferences_company_idx" ON "hub_preferences" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hub_preferences_user_idx" ON "hub_preferences" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hub_preferences_user_company_uq" ON "hub_preferences" USING btree ("user_id","company_id");
