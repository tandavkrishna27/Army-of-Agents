-- C14 hand-appended idempotency guard; drizzle-kit cannot emit IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS "worker_lease_rejections" (
	"organization_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"target_authority_key" text NOT NULL,
	"eligibility_version" integer NOT NULL,
	"static_context_hash" text NOT NULL,
	"workload_type" text NOT NULL,
	"placement_owner" text NOT NULL,
	"placement_target_class" text NOT NULL,
	"placement_target_scope" text NOT NULL,
	"placement_target_generation" integer NOT NULL,
	"placement_profile_hash" text NOT NULL,
	"placement_provider_constraint_hash" text NOT NULL,
	"placement_input_digest" text NOT NULL,
	"placement_policy_digest" text NOT NULL,
	"reason_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_lease_rejections_pkey" PRIMARY KEY("organization_id","worker_id","attempt_id"),
	CONSTRAINT "worker_lease_rejections_workload_type_check" CHECK (workload_type IN ('batch', 'browser_session', 'service')),
	CONSTRAINT "worker_lease_rejections_placement_owner_check" CHECK (placement_owner IN ('managed_cloud', 'organization_dedicated', 'owner_desktop')),
	CONSTRAINT "worker_lease_rejections_placement_target_class_check" CHECK (placement_target_class IN ('managed_cloud', 'organization_dedicated', 'owner_desktop')),
	CONSTRAINT "worker_lease_rejections_placement_target_scope_check" CHECK (placement_target_scope IN ('platform', 'organization', 'owner')),
	CONSTRAINT "worker_lease_rejections_reason_code_check" CHECK (reason_code IN ('static_requirements_mismatch')),
	CONSTRAINT "worker_lease_rejections_hashes_check" CHECK (
        static_context_hash ~ '^[0-9a-f]{64}$' AND
        placement_profile_hash ~ '^[0-9a-f]{64}$' AND
        placement_provider_constraint_hash ~ '^[0-9a-f]{64}$' AND
        placement_input_digest ~ '^[0-9a-f]{64}$' AND
        placement_policy_digest ~ '^[0-9a-f]{64}$'
      ),
	CONSTRAINT "worker_lease_rejections_eligibility_version_check" CHECK (eligibility_version > 0),
	CONSTRAINT "worker_lease_rejections_placement_target_generation_check" CHECK (placement_target_generation > 0)
);
--> statement-breakpoint
-- C14 hand-appended idempotency guard; drizzle-kit cannot emit DROP INDEX IF EXISTS.
DROP INDEX IF EXISTS "jobs_claim_idx";--> statement-breakpoint
-- C14 hand-appended idempotency guard; drizzle-kit cannot emit replay-safe ADD CONSTRAINT.
DO $$ BEGIN ALTER TABLE "worker_lease_rejections" ADD CONSTRAINT "worker_lease_rejections_attempt_fk" FOREIGN KEY ("organization_id","company_id","job_id","attempt_id") REFERENCES "public"."job_attempts"("organization_id","company_id","job_id","id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;--> statement-breakpoint
-- C14 hand-appended idempotency guard; drizzle-kit cannot emit replay-safe ADD CONSTRAINT.
DO $$ BEGIN ALTER TABLE "worker_lease_rejections" ADD CONSTRAINT "worker_lease_rejections_worker_target_fk" FOREIGN KEY ("organization_id","worker_id","target_authority_key","target_id") REFERENCES "public"."workers"("organization_id","id","target_authority_key","execution_target_id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;--> statement-breakpoint
-- C14 hand-appended idempotency guards; drizzle-kit cannot emit IF NOT EXISTS.
CREATE INDEX IF NOT EXISTS "worker_lease_rejections_attempt_idx" ON "worker_lease_rejections" USING btree ("organization_id","company_id","job_id","attempt_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "worker_lease_rejections_cleanup_idx" ON "worker_lease_rejections" USING btree ("organization_id","updated_at","worker_id","attempt_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_attempts_lease_candidate_idx" ON "job_attempts" USING btree ("organization_id","placement_target_id","job_id","id") WHERE
        "job_attempts"."status" = 'pending' AND
        "job_attempts"."placement_disposition" = 'selected' AND
        "job_attempts"."placement_mode" = 'active' AND
        "job_attempts"."placement_lease_eligible" = true
      ;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_claim_idx" ON "jobs" USING btree ("organization_id","status","available_at","priority" DESC NULLS LAST,"created_at","id");
