ALTER TABLE "notifications" ADD COLUMN "claimed_by_user_id" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hub_items_claimed_open_idx" ON "notifications" USING btree ("company_id","claimed_by_user_id") WHERE "notifications"."status" = 'open';
