// Static (cross-platform, Windows-visible) contract test for migration 0195.
// 0195 (multi-tenant cloud hardening) folds:
//   - org-scoping the two provider uniqueness constraints from 0190 (C1)
//   - the cutover member-backfill + defensive secrets re-backfill DML (C2)
// Reads the .sql text directly -- no DB needed.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const migDir = fileURLToPath(new URL("../../../packages/db/src/migrations/", import.meta.url));

describe("migration 0195 contract", () => {
  const files = readdirSync(migDir).filter((f) => f.startsWith("0195_") && f.endsWith(".sql"));
  const file = files[0];
  const sqlText = file
    ? readFileSync(new URL(`../../../packages/db/src/migrations/${file}`, import.meta.url), "utf8")
    : "";

  it("exists as exactly one 0195 migration", () => {
    expect(files).toHaveLength(1);
  });

  it("re-creates provider_assignments_scope_uq with organization_id as the leading column", () => {
    expect(sqlText).toMatch(/DROP CONSTRAINT IF EXISTS "provider_assignments_scope_uq"/);
    expect(sqlText).toMatch(
      /ADD CONSTRAINT "provider_assignments_scope_uq" UNIQUE NULLS NOT DISTINCT\("organization_id","company_id","provider","scope_type","scope_id"\)/,
    );
  });

  it("re-creates provider_connections_identity_uq with organization_id as the leading column", () => {
    expect(sqlText).toMatch(/DROP CONSTRAINT IF EXISTS "provider_connections_identity_uq"/);
    expect(sqlText).toMatch(
      /ADD CONSTRAINT "provider_connections_identity_uq" UNIQUE NULLS NOT DISTINCT\("organization_id","company_id","provider","auth_method","owner_user_id","execution_target_id"\)/,
    );
  });

  it("includes the cutover member-backfill INSERT into organization_memberships", () => {
    expect(sqlText).toMatch(/INSERT INTO "organization_memberships"[\s\S]*FROM "company_memberships" cm/);
    expect(sqlText).toMatch(/ON CONFLICT \("organization_id", "user_id"\) DO NOTHING/);
  });

  it("includes the defensive company_secrets.organization_id re-backfill", () => {
    expect(sqlText).toMatch(/UPDATE "company_secrets" SET "organization_id" = c\."organization_id" FROM "companies" c/);
  });
});
