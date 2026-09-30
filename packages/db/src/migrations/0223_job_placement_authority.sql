-- C14 hand-appended idempotency guards; drizzle-kit cannot emit IF NOT EXISTS for columns.
ALTER TABLE "execution_targets" ADD COLUMN IF NOT EXISTS "registered_profile" jsonb;--> statement-breakpoint
ALTER TABLE "execution_targets" ADD COLUMN IF NOT EXISTS "registered_profile_hash" text;--> statement-breakpoint
ALTER TABLE "execution_targets" ADD COLUMN IF NOT EXISTS "provider_constraint_profile" jsonb;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD COLUMN IF NOT EXISTS "placement_disposition" text;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD COLUMN IF NOT EXISTS "placement_owner" text;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD COLUMN IF NOT EXISTS "placement_target_id" uuid;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD COLUMN IF NOT EXISTS "placement_target_class" text;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD COLUMN IF NOT EXISTS "placement_target_scope" text;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD COLUMN IF NOT EXISTS "placement_target_generation" integer;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD COLUMN IF NOT EXISTS "placement_profile_hash" text;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD COLUMN IF NOT EXISTS "placement_provider_constraint_hash" text;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD COLUMN IF NOT EXISTS "placement_fallback_disposition" text;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD COLUMN IF NOT EXISTS "placement_reason_code" text;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD COLUMN IF NOT EXISTS "placement_mode" text;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD COLUMN IF NOT EXISTS "placement_lease_eligible" boolean;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD COLUMN IF NOT EXISTS "placement_input_digest" text;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD COLUMN IF NOT EXISTS "placement_policy_digest" text;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD COLUMN IF NOT EXISTS "placement_decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN IF NOT EXISTS "profile_snapshot" jsonb;--> statement-breakpoint
-- C14 hand-appended constraint guards; drizzle-kit cannot emit replay-safe ADD CONSTRAINT.
DO $$ BEGIN ALTER TABLE "execution_targets" ADD CONSTRAINT "execution_targets_placement_profiles_atomic_check" CHECK ((
        registered_profile IS NULL AND registered_profile_hash IS NULL AND provider_constraint_profile IS NULL
      ) OR (
        registered_profile IS NOT NULL AND registered_profile_hash ~ '^[0-9a-f]{64}$' AND
        provider_constraint_profile IS NOT NULL
      )); EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_placement_atomic_check" CHECK ((
        placement_decided_at IS NULL AND placement_disposition IS NULL AND
        placement_owner IS NULL AND placement_target_id IS NULL AND
        placement_target_class IS NULL AND placement_target_scope IS NULL AND
        placement_target_generation IS NULL AND placement_profile_hash IS NULL AND
        placement_provider_constraint_hash IS NULL AND placement_fallback_disposition IS NULL AND
        placement_reason_code IS NULL AND placement_mode IS NULL AND
        placement_lease_eligible IS NULL AND placement_input_digest IS NULL AND
        placement_policy_digest IS NULL
      ) OR (
        placement_decided_at IS NOT NULL AND
        placement_disposition IN ('selected', 'legacy', 'queued', 'failed') AND
        placement_fallback_disposition IS NOT NULL AND placement_reason_code IS NOT NULL AND
        placement_mode IN ('active', 'shadow', 'legacy') AND
        placement_lease_eligible IS NOT NULL AND
        placement_input_digest ~ '^[0-9a-f]{64}$' AND
        placement_policy_digest ~ '^[0-9a-f]{64}$' AND (
          (placement_disposition = 'selected' AND
           placement_owner IN ('managed_cloud', 'organization_dedicated', 'owner_desktop') AND
           placement_target_id IS NOT NULL AND
           placement_target_class = placement_owner AND
           placement_target_scope IN ('platform', 'organization', 'owner') AND
           placement_target_generation > 0 AND
           placement_profile_hash ~ '^[0-9a-f]{64}$' AND
           placement_provider_constraint_hash ~ '^[0-9a-f]{64}$') OR
          (placement_disposition = 'legacy' AND placement_owner = 'legacy' AND
           placement_target_id IS NULL AND placement_target_class IS NULL AND
           placement_target_scope IS NULL AND placement_target_generation IS NULL AND
           placement_profile_hash IS NULL AND placement_provider_constraint_hash IS NULL) OR
          (placement_disposition IN ('queued', 'failed') AND placement_owner IS NULL AND
           placement_target_id IS NULL AND placement_target_class IS NULL AND
           placement_target_scope IS NULL AND placement_target_generation IS NULL AND
           placement_profile_hash IS NULL AND placement_provider_constraint_hash IS NULL)
        )
      )); EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;
