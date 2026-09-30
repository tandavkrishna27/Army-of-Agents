-- JOB-009 Decision #122 custom security DDL. drizzle-kit cannot express
-- column grants. Existing FORCE RLS policies continue to own row visibility;
-- this only admits the bounded, non-secret placement profile columns.
GRANT SELECT ("slug", "kind", "trust_class", "last_seen_at", "registered_profile",
  "registered_profile_hash", "provider_constraint_profile")
  ON "execution_targets" TO "aoa_app";
--> statement-breakpoint
GRANT SELECT ("registered_profile", "registered_profile_hash", "provider_constraint_profile")
  ON "execution_targets" TO "aoa_operator";
