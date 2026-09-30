CREATE INDEX IF NOT EXISTS "hub_items_group_open_idx" ON "notifications" USING btree ("company_id","group_key","created_at") WHERE "notifications"."status" = 'open';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hub_items_scope_open_idx" ON "notifications" USING btree ("company_id","scope_key","created_at") WHERE "notifications"."status" = 'open';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hub_items_source_open_idx" ON "notifications" USING btree ("company_id","source_type","created_at") WHERE "notifications"."status" = 'open';
