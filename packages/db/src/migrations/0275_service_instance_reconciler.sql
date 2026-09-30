-- SVC-002 - service reconciler and placement. The instance columns the reconciler writes,
-- and the partial unique index that is the AUTHORITY for "no duplicate placement".
--
-- C14 class (a) hand-appended idempotency guards ONLY. drizzle-kit cannot emit
-- IF NOT EXISTS / duplicate_object guards; every statement below is otherwise db:generate
-- output, INCLUDING the DROP CONSTRAINT / ADD CONSTRAINT pair for the widened parent FK.
-- That pair's provenance was an OPEN QUESTION in SVC-002-design.md (§10, last paragraph:
-- "Settle it by running the generator, not by arguing"). It was settled by running the
-- generator: drizzle-kit originates both statements for a changed composite FK, exactly as
-- SVC-001 measured for a changed CHECK. No hand-authored DDL, and no C14 class (b) block --
-- `service_instances` is an already-registered relation whose grants, RLS and policy are in
-- place, and adding columns to it changes no ACL.
--
-- The guards are NECESSARY, not belt-and-braces: migration-idempotency's static check
-- matches only /^\s*CREATE (UNIQUE )?(TABLE|INDEX)\s+"/, so the ADD COLUMN and
-- DROP/ADD CONSTRAINT statements are covered by NO static check at all. A named double-apply
-- case for this file lives beside the 0264 one in migration-idempotency.test.ts.
--
-- ★ `company_id` is added NOT NULL WITHOUT a backfill, and that is safe for a measured
-- reason rather than an assumed one: at the base commit `service_instances` had exactly one
-- INSERT in the whole tree (packages/db/src/repositories/tenant/index.ts) with ZERO
-- production callers, so no deployment has ever written a row. If that ever stops being
-- true, this statement fails LOUDLY on a non-empty table rather than silently stamping a
-- sentinel company, which is the fail-closed direction.
ALTER TABLE "service_instances" DROP CONSTRAINT IF EXISTS "service_instances_org_service_fk";
--> statement-breakpoint
ALTER TABLE "service_instances" ADD COLUMN IF NOT EXISTS "company_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "service_instances" ADD COLUMN IF NOT EXISTS "job_id" uuid;--> statement-breakpoint
ALTER TABLE "service_instances" ADD COLUMN IF NOT EXISTS "attempt_id" uuid;--> statement-breakpoint
-- The parent FK, widened from the (organization_id, service_id) PAIR to the
-- (organization_id, company_id, service_id) TRIPLE. E2-F013's reason: with the pair, an
-- instance could carry company B while its service belongs to company A inside one org,
-- with every constraint satisfied -- and the denormalized company_id is the sole company
-- predicate any later reader has, so its integrity is the whole guarantee. Same correction
-- SVC-001 applied to `service_generations`. The FK target `services_org_company_id_uq`
-- already exists (0264). Still ON DELETE CASCADE (E2-D09): instances die with their service.
DO $$ BEGIN
 ALTER TABLE "service_instances" ADD CONSTRAINT "service_instances_org_company_service_fk" FOREIGN KEY ("organization_id","company_id","service_id") REFERENCES "public"."services"("organization_id","company_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 -- A UNIQUE constraint materialises an INDEX, so a replay can raise duplicate_table
 -- (42P07) rather than duplicate_object (42710). Catching only the latter is what made
 -- 0264 non-idempotent, which its named replay test caught.
 WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
-- ★★★ THE AUTHORITY for "one service, one running instance, without duplicate placement".
-- A unique index is enforced by the storage engine on EVERY insert, including one written
-- by a caller that does not exist yet -- unlike the reconciler's advisory lock, which
-- nothing forces SVC-004's restart path or SVC-007's manual "start now" control to take.
-- The predicate's three states are exactly the terminals of the FROZEN serviceInstance
-- lifecycle (worker-protocol SERVICE_INSTANCE_TRANSITIONS), so it is derived rather than
-- hand-picked; the reconciliation against that authority is asserted server-side.
CREATE UNIQUE INDEX IF NOT EXISTS "service_instances_live_service_uq" ON "service_instances" USING btree ("organization_id","service_id") WHERE status NOT IN ('stopped', 'failed', 'lost');
