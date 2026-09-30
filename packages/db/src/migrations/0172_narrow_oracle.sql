CREATE TABLE IF NOT EXISTS "commander_login_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"auth_home" text NOT NULL,
	"login_url" text,
	"pid" integer,
	"pgid" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"started_by_user_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "commander_login_challenges" ADD CONSTRAINT "commander_login_challenges_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "commander_login_challenges" ADD CONSTRAINT "commander_login_challenges_started_by_user_id_user_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commander_login_challenges_company_idx" ON "commander_login_challenges" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commander_login_challenges_lock_idx" ON "commander_login_challenges" USING btree ("provider","auth_home","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commander_login_challenges_status_idx" ON "commander_login_challenges" USING btree ("status");
