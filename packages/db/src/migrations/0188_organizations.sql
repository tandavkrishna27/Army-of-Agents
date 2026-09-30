-- packages/db/src/migrations/0187_organizations.sql
-- Phase 1 (multi-tenant cloud): introduce the Organization tenant parent,
-- backfill every existing company into ONE default Organization, and re-scope
-- the two globally-unique company identifiers so a second tenant can never
-- collide.
--
-- SAFETY (single atomic transaction — see packages/db/src/client.ts):
--   1. create the 3 tenant tables
--   2. ADD COLUMN companies.organization_id NULLABLE (safe on a populated table)
--   3. SET DEFAULT the sentinel org on the column (belt-and-suspenders for any
--      future/raw writer that omits organization_id; does NOT rewrite old rows)
--   4. INSERT the sentinel default Organization (idempotent)
--   5. UPDATE all companies -> default org (idempotent WHERE org_id IS NULL)
--   6. INSERT owner memberships from instance_admins (idempotent, FK-guarded)
--   7. FALLBACK owner: when NO instance_admin exists, seed the first company
--      founder (else the first user) as owner so the default org is never
--      ownerless/unadministrable in cloud_auth (idempotent, NOT EXISTS-guarded)
--   8. ALTER COLUMN ... SET NOT NULL (only after every row is populated)
--   9. ADD the FK constraint
--  10. swap companies_issue_prefix_idx -> (organization_id, issue_prefix)
--  11. swap issues_identifier_idx -> (company_id, identifier)
-- Within one default Organization, per-org uniqueness == the old global
-- uniqueness, so steps 8-9 cannot abort on existing data.
-- ONE-WAY DOOR once a second Organization exists: take a DB snapshot first.

CREATE TABLE IF NOT EXISTS "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"plan" text DEFAULT 'beta' NOT NULL,
	"concurrency_cap" integer,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_status_check" CHECK (status IN ('active', 'suspended', 'archived'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organization_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"invited_by_user_id" text,
	"joined_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_memberships_role_check" CHECK (role IN ('owner', 'admin', 'member', 'billing')),
	CONSTRAINT "organization_memberships_status_check" CHECK (status IN ('pending', 'active', 'suspended'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organization_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"invited_by_user_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_invitations_role_check" CHECK (role IN ('owner', 'admin', 'member', 'billing')),
	CONSTRAINT "organization_invitations_status_check" CHECK (status IN ('pending', 'accepted', 'revoked', 'expired'))
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_invited_by_user_id_user_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_invited_by_user_id_user_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_slug_uq" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organizations_status_idx" ON "organizations" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organization_memberships_org_user_uq" ON "organization_memberships" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organization_memberships_user_status_idx" ON "organization_memberships" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organization_memberships_org_status_idx" ON "organization_memberships" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organization_invitations_token_hash_uq" ON "organization_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organization_invitations_org_status_idx" ON "organization_invitations" USING btree ("organization_id","status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organization_invitations_pending_email_uq" ON "organization_invitations" USING btree ("organization_id","email") WHERE status = 'pending';--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "companies" ALTER COLUMN "organization_id" SET DEFAULT '00000000-0000-0000-0000-000000000001';--> statement-breakpoint
INSERT INTO "organizations" ("id", "name", "slug", "status", "plan")
VALUES ('00000000-0000-0000-0000-000000000001', 'Default Organization', 'default', 'active', 'beta')
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
UPDATE "companies"
SET "organization_id" = '00000000-0000-0000-0000-000000000001'
WHERE "organization_id" IS NULL;--> statement-breakpoint
INSERT INTO "organization_memberships" ("organization_id", "user_id", "role", "status", "joined_at")
SELECT '00000000-0000-0000-0000-000000000001', u."id", 'owner', 'active', now()
FROM "instance_user_roles" iur
JOIN "user" u ON u."id" = iur."user_id"
WHERE iur.role = 'instance_admin'
ON CONFLICT ("organization_id", "user_id") DO NOTHING;--> statement-breakpoint
-- Fallback owner: only fires when the instance_admin backfill above seeded NO
-- owner for the default org (e.g. an install with zero instance_admins). Picks
-- the earliest company founder (user_roles.role = 'founder'), else the earliest
-- user. A truly userless loopback install seeds nobody (fallback IS NULL) and
-- that is correct.
INSERT INTO "organization_memberships" ("organization_id", "user_id", "role", "status", "joined_at")
SELECT '00000000-0000-0000-0000-000000000001', fallback."user_id", 'owner', 'active', now()
FROM (
  SELECT COALESCE(
    (SELECT ur."user_id"
       FROM "user_roles" ur
       JOIN "user" u ON u."id" = ur."user_id"
      WHERE ur.role = 'founder'
      ORDER BY ur."created_at" ASC
      LIMIT 1),
    (SELECT u."id" FROM "user" u ORDER BY u."created_at" ASC LIMIT 1)
  ) AS "user_id"
) fallback
WHERE fallback."user_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "organization_memberships" m
    WHERE m."organization_id" = '00000000-0000-0000-0000-000000000001'
      AND m."role" = 'owner'
  )
ON CONFLICT ("organization_id", "user_id") DO NOTHING;--> statement-breakpoint
ALTER TABLE "companies" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
DROP INDEX IF EXISTS "companies_issue_prefix_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "companies_org_issue_prefix_idx" ON "companies" USING btree ("organization_id","issue_prefix");--> statement-breakpoint
DROP INDEX IF EXISTS "issues_identifier_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issues_identifier_idx" ON "issues" USING btree ("company_id","identifier");