CREATE TABLE IF NOT EXISTS "onboarding_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"company_id" uuid,
	"journey" text NOT NULL,
	"current_state" text NOT NULL,
	"completed_states" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_profiles" (
	"user_id" text PRIMARY KEY NOT NULL,
	"display_name" text,
	"avatar_url" text,
	"title" text,
	"bio" text,
	"social_links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "onboarding_progress" ADD CONSTRAINT "onboarding_progress_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "onboarding_progress_user_company_uq" ON "onboarding_progress" USING btree ("user_id","company_id") WHERE "onboarding_progress"."company_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "onboarding_progress_user_layer_uq" ON "onboarding_progress" USING btree ("user_id") WHERE "onboarding_progress"."company_id" IS NULL;
