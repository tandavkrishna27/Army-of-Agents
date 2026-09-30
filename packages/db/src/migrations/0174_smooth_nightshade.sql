ALTER TABLE "onboarding_progress" ADD COLUMN "first_run_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "onboarding_progress" ADD COLUMN "first_run_persona" text;