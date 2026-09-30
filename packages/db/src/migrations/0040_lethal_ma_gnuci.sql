ALTER TABLE "company_memberships" ADD COLUMN "parent_type" text;--> statement-breakpoint
ALTER TABLE "company_memberships" ADD COLUMN "parent_id" text;--> statement-breakpoint
CREATE INDEX "cm_company_parent_idx" ON "company_memberships" USING btree ("company_id","parent_type","parent_id");