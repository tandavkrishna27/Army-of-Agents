-- JOB-003 Decision #122 custom security DDL. drizzle-kit cannot express
-- role grants, FORCE RLS, or policies. Every statement is naturally
-- idempotent or drop-before-create per C14.
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; REVOKE is idempotent.
REVOKE ALL ON "worker_operation_receipts" FROM PUBLIC;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; REVOKE is idempotent.
REVOKE ALL ON "worker_operation_receipts" FROM "aoa_operator";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; GRANT is idempotent.
GRANT SELECT, INSERT, UPDATE, DELETE ON "worker_operation_receipts" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; ALTER is naturally convergent.
ALTER TABLE "worker_operation_receipts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; ALTER is naturally convergent.
ALTER TABLE "worker_operation_receipts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; DROP IF EXISTS is idempotent.
DROP POLICY IF EXISTS "worker_operation_receipts_tenant_isolation" ON "worker_operation_receipts";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; drop-before-create makes it idempotent.
CREATE POLICY "worker_operation_receipts_tenant_isolation" ON "worker_operation_receipts" TO "aoa_app"
  USING (organization_id = current_setting('aoa.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('aoa.organization_id', true)::uuid);
