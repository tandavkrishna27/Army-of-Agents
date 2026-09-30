ALTER TABLE "environment_leases" ADD COLUMN "commander_conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "environment_leases" ADD CONSTRAINT "environment_leases_commander_conversation_id_internal_agent_conversations_id_fk" FOREIGN KEY ("commander_conversation_id") REFERENCES "public"."internal_agent_conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- IF NOT EXISTS hand-appended after generation (drizzle-kit omits it; C14 /
-- CLAUDE.md Critical Rule #1 narrow exception). Idempotent re-run safety only
-- — no data/DDL semantics changed from what db:generate emitted.
CREATE INDEX IF NOT EXISTS "environment_leases_company_commander_conv_environment_status_idx" ON "environment_leases" USING btree ("company_id","commander_conversation_id","environment_id","status");