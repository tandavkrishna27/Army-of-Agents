CREATE TABLE IF NOT EXISTS "company_user_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"display_name" text,
	"title" text,
	"bio" text,
	"location" text,
	"timezone" text,
	"social_links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"avatar_asset_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" text
);
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "company_user_profiles" ADD CONSTRAINT "company_user_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "company_user_profiles" ADD CONSTRAINT "company_user_profiles_avatar_asset_id_assets_id_fk" FOREIGN KEY ("avatar_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_user_profiles_company_user_uq" ON "company_user_profiles" USING btree ("company_id","user_id");
