ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "responsible_user_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_company_responsible_user_status_idx" ON "issues" USING btree ("company_id","responsible_user_id","status");
