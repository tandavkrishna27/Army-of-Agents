// Static (cross-platform, Windows-visible) contract test for migration 0189.
//
// Phase 3 folds BOTH schema changes into the single 0189 migration:
//   - CREATE TABLE operator_break_glass_grants
//   - ALTER TABLE company_secrets ADD COLUMN organization_id (NULLABLE) + backfill
// so Phase 4 stays 0190. This test reads the .sql text directly — no DB needed.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const migDir = fileURLToPath(new URL("../../../packages/db/src/migrations/", import.meta.url));

describe("migration 0189 contract", () => {
  const files = readdirSync(migDir).filter((f) => f.startsWith("0189_") && f.endsWith(".sql"));
  const file = files[0];
  const sqlText = file ? readFileSync(new URL(`../../../packages/db/src/migrations/${file}`, import.meta.url), "utf8") : "";

  it("exists as exactly one 0189 migration (Phase 3 owns a single migration)", () => {
    expect(files).toHaveLength(1);
  });

  it("adds company_secrets.organization_id as NULLABLE (no NOT NULL on that column)", () => {
    expect(sqlText).toMatch(/ALTER TABLE "company_secrets" ADD COLUMN "organization_id" uuid;/);
    // Scope the negative to the company_secrets ALTER: the break-glass CREATE
    // TABLE legitimately declares its own "organization_id" uuid NOT NULL, so a
    // broad regex would false-fail.
    expect(sqlText).not.toMatch(/ALTER TABLE "company_secrets" ADD COLUMN "organization_id" uuid NOT NULL/);
  });

  it("includes the backfill UPDATE populating company_secrets.organization_id from companies", () => {
    expect(sqlText).toMatch(/UPDATE "company_secrets" SET "organization_id" = c\."organization_id" FROM "companies" c/);
  });

  it("creates the operator_break_glass_grants table in the SAME migration", () => {
    expect(sqlText).toMatch(/CREATE TABLE (IF NOT EXISTS )?"operator_break_glass_grants"/);
  });
});
