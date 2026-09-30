ALTER TABLE "internal_agent_conversations" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "internal_agent_conversations" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "internal_agent_conversations" ADD COLUMN "shared_with_company" boolean DEFAULT false NOT NULL;