-- JOB-013 Decision #122 custom security DDL. drizzle-kit cannot express role
-- grants, FORCE RLS, or policies. Every statement is naturally idempotent or
-- drop-before-create per C14. Mirrors 0228/0231/0235/0237/0241/0243: aoa_app-only
-- tenant DML, no operator authority, FORCE RLS, one org-scoped tenant-isolation policy.
--
-- This migration RE-AFFIRMS the existing tenant-isolation RLS on the one distributed
-- table JOB-013 widened (0244 widened the `job_projection_receipts` projection-kind
-- CHECK to add `activity_audit`). It is a NO-OP against an already-correct database:
-- the grant set, the FORCE-RLS flag, and the single
-- `job_projection_receipts_tenant_isolation` policy are all UNCHANGED from 0235/0241/0243 —
-- the drop-before-create keeps the frozen POLICY_COUNTS/RLS manifest stable while
-- re-establishing the #122 pattern authoritatively over the widened CHECK. ZERO new
-- CREATE POLICY → POLICY_COUNTS unchanged.
--
-- `activity_log` and `hub_audit` are deliberately NOT touched here: both are CAV-005
-- legacy, non-forced, app-layer-company-scoped tables (table-level grants to aoa_app —
-- activity_log SELECT+INSERT, hub_audit INSERT — already cover the transactional audit
-- writes). JOB-013 adds NO grant, NO RLS, NO policy on those tables.

-- ---- job_projection_receipts ------------------------------------------------
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; REVOKE is idempotent.
REVOKE ALL ON "job_projection_receipts" FROM PUBLIC;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; REVOKE is idempotent.
REVOKE ALL ON "job_projection_receipts" FROM "aoa_operator";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; GRANT is idempotent.
GRANT SELECT, INSERT, UPDATE, DELETE ON "job_projection_receipts" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; ALTER is naturally convergent.
ALTER TABLE "job_projection_receipts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; ALTER is naturally convergent.
ALTER TABLE "job_projection_receipts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; DROP IF EXISTS is idempotent.
DROP POLICY IF EXISTS "job_projection_receipts_tenant_isolation" ON "job_projection_receipts";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; drop-before-create makes it idempotent.
CREATE POLICY "job_projection_receipts_tenant_isolation" ON "job_projection_receipts" TO "aoa_app"
  USING (organization_id = current_setting('aoa.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('aoa.organization_id', true)::uuid);
