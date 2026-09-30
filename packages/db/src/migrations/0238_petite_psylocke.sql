CREATE TABLE IF NOT EXISTS "execution_target_revocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_id" uuid NOT NULL,
	"revoked_generation" integer NOT NULL,
	"target_scope" text NOT NULL,
	"organization_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"scan_cursor" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_target_revocations_status_check" CHECK (status IN ('pending', 'converging', 'completed')),
	CONSTRAINT "execution_target_revocations_scope_check" CHECK ((
        target_scope = 'platform' AND organization_id IS NULL
      ) OR (
        target_scope IN ('organization', 'owner') AND organization_id IS NOT NULL
      )),
	CONSTRAINT "execution_target_revocations_generation_check" CHECK (revoked_generation > 0)
);
--> statement-breakpoint
ALTER TABLE "job_attempts" ADD COLUMN "capacity_claim_state" text DEFAULT 'unclaimed' NOT NULL;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD COLUMN "capacity_workload_type" text;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD COLUMN "capacity_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD COLUMN "capacity_released_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "execution_target_revocations_target_generation_uq" ON "execution_target_revocations" USING btree ("target_id","revoked_generation");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_target_revocations_status_idx" ON "execution_target_revocations" USING btree ("status","created_at","id");--> statement-breakpoint
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_capacity_claim_check" CHECK ((
        capacity_claim_state = 'unclaimed' AND capacity_workload_type IS NULL AND
        capacity_claimed_at IS NULL AND capacity_released_at IS NULL
      ) OR (
        capacity_claim_state = 'held' AND capacity_workload_type IS NOT NULL AND
        capacity_claimed_at IS NOT NULL AND capacity_released_at IS NULL
      ) OR (
        capacity_claim_state = 'released' AND capacity_workload_type IS NOT NULL AND
        capacity_claimed_at IS NOT NULL AND capacity_released_at IS NOT NULL
      ));