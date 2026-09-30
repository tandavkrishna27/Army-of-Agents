ALTER TABLE "companies" ADD COLUMN "creation_request_id" uuid;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "creation_request_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "companies_organization_creation_request_uq" ON "companies" USING btree ("organization_id","creation_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_creator_creation_request_uq" ON "organizations" USING btree ("created_by_user_id","creation_request_id");
