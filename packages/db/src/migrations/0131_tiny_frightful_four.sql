ALTER TABLE "heartbeat_runs" ADD COLUMN "prompt_snapshot" text;--> statement-breakpoint
ALTER TABLE "internal_agent_runs" ADD COLUMN "prompt_snapshot" text;