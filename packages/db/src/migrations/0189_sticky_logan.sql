CREATE TABLE IF NOT EXISTS "operator_break_glass_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_user_id" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"company_id" uuid,
	"role" text DEFAULT 'founder' NOT NULL,
	"reason" text NOT NULL,
	"granted_by_user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"swept_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_secrets" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "obg_operator_active_idx" ON "operator_break_glass_grants" USING btree ("operator_user_id","expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "obg_org_idx" ON "operator_break_glass_grants" USING btree ("organization_id");--> statement-breakpoint
-- Backfill company_secrets.organization_id from the owning company's tenant.
-- Hand-appended after generation (drizzle-kit emits only the column add).
-- Idempotent (WHERE organization_id IS NULL) so a re-run is a no-op.
UPDATE "company_secrets" SET "organization_id" = c."organization_id" FROM "companies" c WHERE "company_secrets"."company_id" = c."id" AND "company_secrets"."organization_id" IS NULL;