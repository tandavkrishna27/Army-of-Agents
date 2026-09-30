-- JOB-007 Decision #122 / C14 custom security DDL for the operator-metadata
-- target-generation-cutoff fanout record (`execution_target_revocations`).
-- drizzle-kit cannot express roles, operation grants, FORCE RLS, or policies, so
-- this entire block is hand-authored into the empty custom stub. Every statement is
-- naturally idempotent or guarded/drop-before-create per C14, so a re-apply under
-- the migration advisory lock is a no-op.
--
-- Security matrix (mirrors `distributed_cutover_markers` in 0233, and the E2
-- operator-metadata shape in 0213..0215):
--   * aoa_operator  WRITE      — the revocation authority writes ONE record per
--                                committed cutoff; the fanout worker advances the
--                                bounded scan/cursor/retry state. No DELETE — the
--                                record is durable audit/idempotency metadata.
--   * aoa_app       READ-ONLY  — the fanout DRIVER reads pending records at the
--                                control plane OUTSIDE a tenant transaction
--                                (policy: aoa.organization_id unset), then converges
--                                each admitted Organization SEPARATELY via runInTenant.
--   * tenants       NONE       — an aoa_app query WITH the tenant GUC set never
--                                matches the read policy, so the record is invisible.
--   * FORCE RLS                — defense-in-depth against a non-superuser owner
--                                mistake (E2-F004 rationale).
-- This record is NOT lease authority: the authoritative cutoff is the target's
-- bumped device_generation. Application startup can only READ this record; it can
-- never write or synthesize it.
-- C14 hand-authored security DDL: guarded operator role creation.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aoa_operator') THEN CREATE ROLE "aoa_operator" NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; END IF; END $$;
--> statement-breakpoint
-- C14 hand-authored security DDL: guarded serving role creation.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aoa_app') THEN CREATE ROLE "aoa_app" NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; END IF; END $$;
--> statement-breakpoint
-- C14 hand-authored security DDL: remove ambient public authority first.
REVOKE ALL ON "execution_target_revocations" FROM PUBLIC;
--> statement-breakpoint
-- C14 hand-authored security DDL: strip any inherited aoa_app authority before the narrow re-grant.
REVOKE ALL ON "execution_target_revocations" FROM "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: strip any inherited aoa_operator authority before the narrow re-grant.
REVOKE ALL ON "execution_target_revocations" FROM "aoa_operator";
--> statement-breakpoint
-- C14 hand-authored security DDL: operator writes the durable record (no DELETE — records are durable).
GRANT SELECT, INSERT, UPDATE ON "execution_target_revocations" TO "aoa_operator";
--> statement-breakpoint
-- C14 hand-authored security DDL: the fanout driver reads the record; it never writes it.
GRANT SELECT ON "execution_target_revocations" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: natural idempotent RLS enablement.
ALTER TABLE "execution_target_revocations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- C14 hand-authored security DDL: FORCE removes a non-superuser owner's exemption.
ALTER TABLE "execution_target_revocations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- C14 hand-authored security DDL: drop-before-create operator write policy (idempotent replay guard).
DROP POLICY IF EXISTS "execution_target_revocations_operator_write" ON "execution_target_revocations";
--> statement-breakpoint
-- C14 hand-authored security DDL: aoa_operator has full access to this platform-infra table.
CREATE POLICY "execution_target_revocations_operator_write" ON "execution_target_revocations" TO "aoa_operator"
  USING (true)
  WITH CHECK (true);
--> statement-breakpoint
-- C14 hand-authored security DDL: drop-before-create app read policy (idempotent replay guard).
DROP POLICY IF EXISTS "execution_target_revocations_app_read" ON "execution_target_revocations";
--> statement-breakpoint
-- C14 hand-authored security DDL: aoa_app may READ the record ONLY outside a tenant transaction;
-- a tenant GUC (aoa.organization_id) being set makes the record invisible (tenants NONE).
CREATE POLICY "execution_target_revocations_app_read" ON "execution_target_revocations" FOR SELECT TO "aoa_app"
  USING (current_setting('aoa.organization_id', true) IS NULL);
