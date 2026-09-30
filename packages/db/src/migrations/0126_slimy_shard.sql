ALTER TABLE "execution_workspaces" ADD COLUMN "active_run_id" uuid;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD COLUMN "locked_at" timestamp with time zone;