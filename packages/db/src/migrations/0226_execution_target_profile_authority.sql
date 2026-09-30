-- JOB-009 Decision #122 custom security DDL. drizzle-kit cannot express
-- column grants. FORCE RLS remains the row-visibility authority: aoa_app can
-- update only its current tenant; aoa_operator only null-Organization rows.
-- No worker credential, config, capability, or liveness column is writable.
GRANT UPDATE ("registered_profile", "registered_profile_hash",
  "provider_constraint_profile", "updated_at")
  ON "execution_targets" TO "aoa_app";
--> statement-breakpoint
GRANT UPDATE ("registered_profile", "registered_profile_hash",
  "provider_constraint_profile", "updated_at")
  ON "execution_targets" TO "aoa_operator";
