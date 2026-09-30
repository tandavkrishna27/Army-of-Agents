-- SVC-001 - desired-state service schema.
--
-- C14 hand-appended idempotency guards. drizzle-kit cannot emit IF NOT EXISTS /
-- duplicate_object guards or data-only backfills; the schema DDL below is otherwise
-- db:generate output, INCLUDING the DROP/ADD CHECK pairs (verified: drizzle-kit does
-- originate those for a changed CHECK, so they are not hand-authored DDL).
--
-- The guards are NECESSARY, not belt-and-braces: migration-idempotency's static check
-- matches only /^\s*CREATE (UNIQUE )?(TABLE|INDEX)\s+"/, so ADD CONSTRAINT and UPDATE
-- are covered by NO static check at all.
CREATE TABLE IF NOT EXISTS "service_generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"ttl_seconds" integer,
	"checkpoint_artifact_id" uuid,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_generations_service_generation_uq" UNIQUE("organization_id","service_id","generation"),
	CONSTRAINT "service_generations_org_id_uq" UNIQUE("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "service_instances" DROP CONSTRAINT IF EXISTS "service_instances_status_check";
--> statement-breakpoint
ALTER TABLE "services" DROP CONSTRAINT IF EXISTS "services_desired_state_check";
--> statement-breakpoint
-- C14 data-only backfill: `interrupted` was never a frozen SERVICE_INSTANCE_STATUS and is
-- being removed from the CHECK below. This is DEFENSIVE, not load-bearing - a repo-wide
-- search finds exactly two hits, both declarations, with no writer and no fixture. It runs
-- BEFORE the new CHECK is added, because an existing `interrupted` row would otherwise make
-- the ADD CONSTRAINT fail. Idempotent by construction.
UPDATE "service_instances" SET "status" = 'lost' WHERE "status" = 'interrupted';
--> statement-breakpoint
-- ORDERING IS LOAD-BEARING: the triple-composite FK below references
-- services(organization_id, company_id, id), so its unique must exist FIRST.
DO $$ BEGIN
 ALTER TABLE "services" ADD CONSTRAINT "services_org_company_id_uq" UNIQUE("organization_id","company_id","id");
EXCEPTION
 -- A UNIQUE constraint materialises an INDEX, so a replay raises duplicate_table
 -- (42P07) rather than duplicate_object (42710). Catching only the latter made this
 -- migration non-idempotent, which the named 0264 replay test caught.
 WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "service_instances" ADD CONSTRAINT "service_instances_org_id_uq" UNIQUE("organization_id","id");
EXCEPTION
 -- A UNIQUE constraint materialises an INDEX, so a replay raises duplicate_table
 -- (42P07) rather than duplicate_object (42710). Catching only the latter made this
 -- migration non-idempotent, which the named 0264 replay test caught.
 WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "service_generations" ADD CONSTRAINT "service_generations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 -- A UNIQUE constraint materialises an INDEX, so a replay raises duplicate_table
 -- (42P07) rather than duplicate_object (42710). Catching only the latter made this
 -- migration non-idempotent, which the named 0264 replay test caught.
 WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
-- The SOLE parent FK, and it must be RESTRICT rather than CASCADE. aoa_app holds DELETE on
-- `services`, and a referential action executes with the CONSTRAINT's rights, not the
-- caller's - so a cascade would erase every row this table declares immutable while aoa_app
-- holds no DELETE on it, and a `DELETE FROM service_generations -> 42501` test would still
-- pass. The triple composite also proves generation <-> service <-> company <-> org share
-- one tenant, which two independent FKs would NOT.
DO $$ BEGIN
 ALTER TABLE "service_generations" ADD CONSTRAINT "service_generations_org_company_service_fk" FOREIGN KEY ("organization_id","company_id","service_id") REFERENCES "public"."services"("organization_id","company_id","id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 -- A UNIQUE constraint materialises an INDEX, so a replay raises duplicate_table
 -- (42P07) rather than duplicate_object (42710). Catching only the latter made this
 -- migration non-idempotent, which the named 0264 replay test caught.
 WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_generations_organization_idx" ON "service_generations" USING btree ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_generations_service_idx" ON "service_generations" USING btree ("organization_id","service_id");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "service_instances" ADD CONSTRAINT "service_instances_status_check" CHECK (status IN ('pending', 'leased', 'starting', 'healthy', 'unhealthy', 'stopping', 'stopped', 'failed', 'lost'));
EXCEPTION
 -- A UNIQUE constraint materialises an INDEX, so a replay raises duplicate_table
 -- (42P07) rather than duplicate_object (42710). Catching only the latter made this
 -- migration non-idempotent, which the named 0264 replay test caught.
 WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "services" ADD CONSTRAINT "services_desired_state_check" CHECK (desired_state IN ('running', 'paused', 'stopped', 'deleted'));
EXCEPTION
 -- A UNIQUE constraint materialises an INDEX, so a replay raises duplicate_table
 -- (42P07) rather than duplicate_object (42710). Catching only the latter made this
 -- migration non-idempotent, which the named 0264 replay test caught.
 WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
--> statement-breakpoint
-- ---- service_generations: C14 security DDL ----------------------------------
-- Clause (a)'s ENTIRE enforcement mechanism. There are zero triggers/rules in this repo,
-- so immutability is grant omission: SELECT + INSERT only. No UPDATE. No DELETE.
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; REVOKE is idempotent.
REVOKE ALL ON "service_generations" FROM PUBLIC;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; REVOKE is idempotent.
REVOKE ALL ON "service_generations" FROM "aoa_operator";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; GRANT is idempotent.
-- NO UPDATE, NO DELETE - this omission IS the immutability guarantee.
GRANT SELECT, INSERT ON "service_generations" TO "aoa_app";
--> statement-breakpoint
ALTER TABLE "service_generations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "service_generations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "service_generations_tenant_isolation" ON "service_generations";
--> statement-breakpoint
CREATE POLICY "service_generations_tenant_isolation" ON "service_generations" TO "aoa_app"
  USING (organization_id = current_setting('aoa.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('aoa.organization_id', true)::uuid);
