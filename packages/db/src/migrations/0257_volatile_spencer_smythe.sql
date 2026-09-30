CREATE TABLE IF NOT EXISTS "live_event_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"event_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "live_event_log_company_seq_uq" UNIQUE("company_id","seq"),
	CONSTRAINT "live_event_log_org_event_uq" UNIQUE("organization_id","event_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "live_event_sequences" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"next_seq" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- C14: wrap generated ADD CONSTRAINT in duplicate_object guards so the migration replays.
DO $$ BEGIN
 ALTER TABLE "live_event_log" ADD CONSTRAINT "live_event_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "live_event_log" ADD CONSTRAINT "live_event_log_company_fk" FOREIGN KEY ("organization_id","company_id") REFERENCES "public"."companies"("organization_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "live_event_sequences" ADD CONSTRAINT "live_event_sequences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "live_event_sequences" ADD CONSTRAINT "live_event_sequences_company_fk" FOREIGN KEY ("organization_id","company_id") REFERENCES "public"."companies"("organization_id","id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "live_event_log_company_seq_idx" ON "live_event_log" USING btree ("company_id","seq");--> statement-breakpoint
-- MIG-003 custom security DDL (mirrors 0235 job_events). drizzle-kit cannot express role
-- grants, FORCE RLS, or policies. Every statement is naturally idempotent or drop-before-create
-- per C14. `live_event_log` + `live_event_sequences` are aoa_app-only tenant DML, no operator
-- authority, FORCE RLS, one org-scoped tenant-isolation policy per table. The app writes them
-- under tenant context (withTenantTx sets aoa.organization_id).
-- ---- live_event_log ---------------------------------------------------------
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; REVOKE is idempotent.
REVOKE ALL ON "live_event_log" FROM PUBLIC;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; REVOKE is idempotent.
REVOKE ALL ON "live_event_log" FROM "aoa_operator";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; GRANT is idempotent.
GRANT SELECT, INSERT, UPDATE, DELETE ON "live_event_log" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; ALTER is naturally convergent.
ALTER TABLE "live_event_log" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; ALTER is naturally convergent.
ALTER TABLE "live_event_log" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; DROP IF EXISTS is idempotent.
DROP POLICY IF EXISTS "live_event_log_tenant_isolation" ON "live_event_log";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; drop-before-create makes it idempotent.
CREATE POLICY "live_event_log_tenant_isolation" ON "live_event_log" TO "aoa_app"
  USING (organization_id = current_setting('aoa.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('aoa.organization_id', true)::uuid);
--> statement-breakpoint
-- ---- live_event_sequences ---------------------------------------------------
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; REVOKE is idempotent.
REVOKE ALL ON "live_event_sequences" FROM PUBLIC;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; REVOKE is idempotent.
REVOKE ALL ON "live_event_sequences" FROM "aoa_operator";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; GRANT is idempotent.
GRANT SELECT, INSERT, UPDATE ON "live_event_sequences" TO "aoa_app";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; ALTER is naturally convergent.
ALTER TABLE "live_event_sequences" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; ALTER is naturally convergent.
ALTER TABLE "live_event_sequences" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; DROP IF EXISTS is idempotent.
DROP POLICY IF EXISTS "live_event_sequences_tenant_isolation" ON "live_event_sequences";
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; drop-before-create makes it idempotent.
CREATE POLICY "live_event_sequences_tenant_isolation" ON "live_event_sequences" TO "aoa_app"
  USING (organization_id = current_setting('aoa.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('aoa.organization_id', true)::uuid);
