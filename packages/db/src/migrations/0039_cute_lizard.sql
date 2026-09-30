ALTER TABLE "agents" ADD COLUMN "parent_type" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "parent_id" text;--> statement-breakpoint
CREATE INDEX "agents_company_parent_idx" ON "agents" USING btree ("company_id","parent_type","parent_id");