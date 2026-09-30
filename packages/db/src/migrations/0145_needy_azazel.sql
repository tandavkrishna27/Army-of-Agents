ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "source_action_id" uuid;--> statement-breakpoint
ALTER TABLE "discussion_entries" ADD COLUMN IF NOT EXISTS "source_action_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "artifacts_source_action_uq" ON "artifacts" USING btree ("company_id","source_action_id") WHERE source_action_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "discussion_entries_source_action_uq" ON "discussion_entries" USING btree ("discussion_id","source_action_id") WHERE source_action_id IS NOT NULL;
