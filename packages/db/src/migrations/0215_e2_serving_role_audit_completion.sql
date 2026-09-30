-- Corrective E2 serving-role completion after prerequisite review attempt 2
-- (Decision #123). DELTA-FREE `--custom` migration under Decision #122/C14:
-- drizzle-kit cannot emit operation-specific column grants. Applied migrations
-- 0213/0214 remain unchanged. GRANT is naturally idempotent on re-application.
-- The exact projection matches the current heartbeat execution-target resolver;
-- worker_token_hash and all unrelated enrollment/ownership metadata stay denied.
GRANT SELECT ("id", "slug", "kind", "trust_class", "status", "organization_id", "config")
ON "execution_targets" TO "aoa_app";
