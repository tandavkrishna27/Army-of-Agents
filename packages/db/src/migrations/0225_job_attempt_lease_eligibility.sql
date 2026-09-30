-- C14: drizzle-kit generated this constraint swap. DROP IF EXISTS plus the
-- duplicate-object guard make a replay safe without hand-authoring schema DDL.
ALTER TABLE "job_attempts" DROP CONSTRAINT IF EXISTS "job_attempts_placement_atomic_check";--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_placement_atomic_check" CHECK ((
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
        placement_lease_eligible = (
          placement_disposition = 'selected' AND placement_mode = 'active'
        ) AND
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
      ));
EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL;
END $$;
