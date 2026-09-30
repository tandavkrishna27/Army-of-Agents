ALTER TABLE "environment_leases" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "environment_leases" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "environment_leases" ADD CONSTRAINT "environment_leases_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- IF NOT EXISTS hand-appended after generation (drizzle-kit omits it; C14 /
-- CLAUDE.md Critical Rule #1 narrow exception). Idempotent re-run safety only
-- — no data/DDL semantics changed from what db:generate emitted.
CREATE INDEX IF NOT EXISTS "environment_leases_company_agent_environment_status_idx" ON "environment_leases" USING btree ("company_id","agent_id","environment_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "environment_leases_paused_reaper_idx" ON "environment_leases" USING btree ("status","paused_at");