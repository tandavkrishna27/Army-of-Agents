CREATE TABLE IF NOT EXISTS "notification_digest_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"hub_item_id" uuid NOT NULL,
	"semantic_type" text NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"company_id" uuid NOT NULL,
	"rules" jsonb NOT NULL,
	"quiet_hours" jsonb NOT NULL,
	"digest" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "notification_digest_items" ADD CONSTRAINT "notification_digest_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "notification_digest_items" ADD CONSTRAINT "notification_digest_items_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "notification_digest_items" ADD CONSTRAINT "notification_digest_items_hub_item_id_notifications_id_fk" FOREIGN KEY ("hub_item_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_digest_items_company_user_idx" ON "notification_digest_items" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_digest_items_pending_idx" ON "notification_digest_items" USING btree ("company_id","user_id","acked_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notification_digest_items_pending_item_uq" ON "notification_digest_items" USING btree ("company_id","user_id","hub_item_id") WHERE "notification_digest_items"."acked_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_preferences_company_idx" ON "notification_preferences" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_preferences_user_idx" ON "notification_preferences" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notification_preferences_user_company_uq" ON "notification_preferences" USING btree ("user_id","company_id");
