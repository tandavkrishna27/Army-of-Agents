-- Add ON DELETE CASCADE / SET NULL to assets FKs.
-- Drops and recreates both FKs (company_id -> cascade, created_by_agent_id -> set null)
-- so a DELETE on companies no longer aborts when asset rows exist, and so an
-- agent delete leaves the asset record intact (only clearing the attribution).
ALTER TABLE "assets" DROP CONSTRAINT IF EXISTS "assets_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "assets" DROP CONSTRAINT IF EXISTS "assets_created_by_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
