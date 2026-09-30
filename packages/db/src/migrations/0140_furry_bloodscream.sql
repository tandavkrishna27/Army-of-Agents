ALTER TABLE "memory_retrievals" ADD COLUMN IF NOT EXISTS "conversation_id" uuid;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "memory_retrievals" ADD CONSTRAINT "memory_retrievals_conversation_id_internal_agent_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."internal_agent_conversations"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_retrievals_conversation_created_idx" ON "memory_retrievals" USING btree ("conversation_id","created_at");
