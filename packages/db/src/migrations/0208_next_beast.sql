-- C14 replay guard around Drizzle-generated enum DDL.
DO $$ BEGIN
  CREATE TYPE "public"."agent_execution_setup_state" AS ENUM('pending', 'ready');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
-- C14 replay guard on Drizzle-generated column DDL. Existing rows take the
-- temporary ready default; 0209 switches only future inserts to pending.
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "agent_execution_setup_state" "agent_execution_setup_state" DEFAULT 'ready' NOT NULL;
