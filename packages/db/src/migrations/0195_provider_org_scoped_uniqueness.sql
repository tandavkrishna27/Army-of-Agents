-- 0195 (multi-tenant cloud hardening): org-scope the two provider uniqueness
-- constraints introduced by 0190. Before this, provider_assignments_scope_uq and
-- provider_connections_identity_uq omit organization_id, so org-level rows
-- (company_id NULL) collapse to ONE row per provider per INSTALL under
-- NULLS NOT DISTINCT -- a second tenant could never mint its own org_default
-- assignment or org-level connection. Adding organization_id as the LEADING
-- column strictly WIDENS the key (can only reduce collisions), so it is safe on
-- populated data. Idempotent: DROP ... IF EXISTS + guarded ADD (duplicate_object).
ALTER TABLE "provider_assignments" DROP CONSTRAINT IF EXISTS "provider_assignments_scope_uq";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provider_assignments" ADD CONSTRAINT "provider_assignments_scope_uq" UNIQUE NULLS NOT DISTINCT("organization_id","company_id","provider","scope_type","scope_id");
EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
ALTER TABLE "provider_connections" DROP CONSTRAINT IF EXISTS "provider_connections_identity_uq";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_identity_uq" UNIQUE NULLS NOT DISTINCT("organization_id","company_id","provider","auth_method","owner_user_id","execution_target_id");
EXCEPTION WHEN duplicate_table THEN NULL; WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
-- Cutover member backfill (multi-tenant cloud): 0188 seeded org membership ONLY
-- for instance_admins (+ one fallback founder). cloud_auth assertCompanyAccess
-- (server/src/routes/authz.ts:71) requires BOTH an active org membership AND a
-- company membership, so on an existing multi-user install every NON-admin
-- member would 403 after cutover. Grant every active company member (principal
-- 'user') an 'active' 'member' row in that company's organization. JOIN "user"
-- guards the FK (organization_memberships.user_id -> user.id). Idempotent
-- (ON CONFLICT DO NOTHING on organization_memberships_org_user_uq); NEVER
-- downgrades an existing owner/admin (conflict skipped). DISTINCT collapses a
-- user who belongs to multiple companies in the SAME org to one row.
INSERT INTO "organization_memberships" ("organization_id", "user_id", "role", "status", "joined_at")
SELECT DISTINCT c."organization_id", cm."principal_id", 'member', 'active', now()
FROM "company_memberships" cm
JOIN "companies" c ON c."id" = cm."company_id"
JOIN "user" u ON u."id" = cm."principal_id"
WHERE cm."principal_type" = 'user'
  AND cm."status" = 'active'
ON CONFLICT ("organization_id", "user_id") DO NOTHING;--> statement-breakpoint
-- Defensive re-backfill of company_secrets.organization_id: belt for any org-NULL
-- secret minted by the pre-fix create path (server/src/services/secrets.ts) between
-- 0189 and the C3 service fix. Verbatim from 0189 + idempotent (WHERE ... IS NULL);
-- a no-op once C3 ships. NOT NULL/FK on the column stays DEFERRED (see C3).
UPDATE "company_secrets" SET "organization_id" = c."organization_id" FROM "companies" c WHERE "company_secrets"."company_id" = c."id" AND "company_secrets"."organization_id" IS NULL;
