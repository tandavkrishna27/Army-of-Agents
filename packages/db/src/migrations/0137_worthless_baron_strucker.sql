ALTER TABLE "memory_items" ADD COLUMN IF NOT EXISTS "conversation_id" uuid;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_conversation_id_internal_agent_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."internal_agent_conversations"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_items_conversation_working_idx" ON "memory_items" USING btree ("company_id","conversation_id","layer","status");
