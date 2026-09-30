-- E0-F013 Decision 2, ruled option (a2): the unattributable-denial sink.
-- docs/replatform/DECISION-REQUEST-unattributable-denial-sink.md
--
-- `activity_log.company_id` becomes NULLABLE, a nullable `organization_id` is
-- added, and a partial CHECK retains the NOT NULL guarantee for every product
-- writer while relaxing it ONLY inside the reserved `security.denied.` action
-- namespace. All DDL below is `pnpm db:generate` OUTPUT from
-- packages/db/src/schema/activity_log.ts (columns, index, FK and the drizzle
-- `check()`); nothing here is hand-authored schema.
--
-- C14 CLASS (a) HAND-APPENDED IDEMPOTENCY GUARDS ONLY. The readiness gate
-- RE-APPLIES the pending tail, so a bare `ADD COLUMN` / `ADD CONSTRAINT` /
-- `CREATE INDEX` breaks recovery. `IF NOT EXISTS` on the column and index, and
-- `DROP CONSTRAINT IF EXISTS` before each `ADD CONSTRAINT`, make every statement
-- replay-safe against a partially- or fully-applied database. Exemplars: 0189,
-- 0195, 0240. `ALTER COLUMN ... DROP NOT NULL` is already idempotent.
--
-- N/N-1 COMPATIBILITY (expand phase). `remote-compose-deploy.sh` rolls the
-- binary back WITHOUT reverting the database, so both changes are expand-only:
--   * `DROP NOT NULL` only WIDENS what may be stored. The N-1 binary never wrote
--     a null `company_id` (its recorder refused to) and still cannot outside the
--     denial namespace, because the CHECK rejects it. Every N-1 read path filters
--     `company_id = :x`, and a NULL never matches, so no N-1 SELECT changes.
--   * a nullable `ADD COLUMN` is invisible to the N-1 binary: its drizzle model
--     has no `organization_id`, its INSERTs name their columns explicitly, and
--     the column has no default and no NOT NULL, so an N-1 INSERT succeeds and
--     leaves it null. There is no CONTRACT step in this migration.
ALTER TABLE "activity_log" ALTER COLUMN "company_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "activity_log" ADD COLUMN IF NOT EXISTS "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "activity_log" DROP CONSTRAINT IF EXISTS "activity_log_organization_id_organizations_id_fk";--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_log_organization_idx" ON "activity_log" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "activity_log" DROP CONSTRAINT IF EXISTS "activity_log_company_or_denial_check";--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_company_or_denial_check" CHECK (company_id IS NOT NULL OR action LIKE 'security.denied.%');
