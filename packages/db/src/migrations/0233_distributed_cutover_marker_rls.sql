-- DEP-003 (E6 deployment harness) Decision #122 / C14 custom security DDL for the
-- operator-gated 0188 cutover marker (slug `distributed_cutover_marker`). drizzle-kit
-- cannot express roles, operation grants, FORCE RLS, or policies, so this entire
-- block is hand-authored into the empty custom stub. Every statement is naturally
-- idempotent or guarded/drop-before-create per C14, so a re-apply under the
-- migration advisory lock is a no-op.
--
-- Security matrix (mirrors the E2 operator-metadata shape in 0213..0215):
--   * aoa_operator  WRITE      — only the operator-gated migration job (via the
--                                aoa_operator non-owner pool) writes the marker.
--   * aoa_app       READ-ONLY  — the control plane reads it OUTSIDE a tenant
--                                transaction (policy: aoa.organization_id unset).
--   * tenants       NONE       — an aoa_app query WITH the tenant GUC set never
--                                matches the read policy, so the marker is invisible.
--   * FORCE RLS                — defense-in-depth against a non-superuser owner
--                                mistake (E2-F004 rationale).
-- Application startup can only READ this marker; it can never write or synthesize it.
-- C14 hand-authored security DDL: guarded operator role creation.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aoa_operator') THEN CREATE ROLE "aoa_operator" NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; END IF; END $$;
--> statement-breakpoint
-- C14 hand-authored security DDL: guarded serving role creation.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aoa_app') THEN CREATE ROLE "aoa_app" NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE; END IF; END $$;
--> statement-breakpoint
-- C14 hand-authored security DDL: remove ambient public authority first.
REVOKE ALL ON "distributed_cutover_markers" FROM PUBLIC;
--> statement-breakpoint
-- C14 hand-authored security DDL: strip any inherited aoa_app authority before the narrow re-grant.
REVOKE ALL ON "distributed_cutover_markers" FROM "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: strip any inherited aoa_operator authority before the narrow re-grant.
REVOKE ALL ON "distributed_cutover_markers" FROM "aoa_operator";
--> statement-breakpoint
-- C14 hand-authored security DDL: operator writes the durable marker (no DELETE — markers are durable).
GRANT SELECT, INSERT, UPDATE ON "distributed_cutover_markers" TO "aoa_operator";
--> statement-breakpoint
-- C14 hand-authored security DDL: the control plane reads the marker; it never writes it.
GRANT SELECT ON "distributed_cutover_markers" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: natural idempotent RLS enablement.
ALTER TABLE "distributed_cutover_markers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- C14 hand-authored security DDL: FORCE removes a non-superuser owner's exemption.
ALTER TABLE "distributed_cutover_markers" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- C14 hand-authored security DDL: drop-before-create operator write policy (idempotent replay guard).
DROP POLICY IF EXISTS "distributed_cutover_markers_operator_write" ON "distributed_cutover_markers";
--> statement-breakpoint
-- C14 hand-authored security DDL: aoa_operator has full access to this platform-infra table.
CREATE POLICY "distributed_cutover_markers_operator_write" ON "distributed_cutover_markers" TO "aoa_operator"
  USING (true)
  WITH CHECK (true);
--> statement-breakpoint
-- C14 hand-authored security DDL: drop-before-create app read policy (idempotent replay guard).
DROP POLICY IF EXISTS "distributed_cutover_markers_app_read" ON "distributed_cutover_markers";
--> statement-breakpoint
-- C14 hand-authored security DDL: aoa_app may READ the marker ONLY outside a tenant transaction;
-- a tenant GUC (aoa.organization_id) being set makes the marker invisible (tenants NONE).
CREATE POLICY "distributed_cutover_markers_app_read" ON "distributed_cutover_markers" FOR SELECT TO "aoa_app"
  USING (current_setting('aoa.organization_id', true) IS NULL);
