ALTER TABLE "discussions" ADD COLUMN "crew_paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "internal_agent_config" ADD COLUMN "crew_paused" boolean DEFAULT false NOT NULL;