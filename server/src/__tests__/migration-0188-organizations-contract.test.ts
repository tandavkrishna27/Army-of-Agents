import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SQL = readFileSync(
  resolve(__dirname, "../../../packages/db/src/migrations/0188_organizations.sql"),
  "utf8",
);

describe("Migration 0188 — organizations + safe companies backfill", () => {
  it("creates the three tenant tables", () => {
    expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS "organizations"/);
    expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS "organization_memberships"/);
    expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS "organization_invitations"/);
  });

  it("adds companies.organization_id as NULLABLE (never NOT NULL in the ADD COLUMN)", () => {
    const addCol = SQL.match(/ALTER TABLE "companies" ADD COLUMN "organization_id" uuid;?/);
    expect(addCol).not.toBeNull();
    expect(SQL).not.toMatch(/ADD COLUMN "organization_id" uuid NOT NULL/);
  });

  it("sets a sentinel DB DEFAULT on the column (belt-and-suspenders for raw writers)", () => {
    expect(SQL).toMatch(
      /ALTER TABLE "companies" ALTER COLUMN "organization_id" SET DEFAULT '00000000-0000-0000-0000-000000000001'/,
    );
  });

  it("seeds a fallback owner (founder, else first user) when no instance_admin exists", () => {
    expect(SQL).toMatch(/user_roles/);
    expect(SQL).toMatch(/role = 'founder'/);
    expect(SQL).toMatch(/NOT EXISTS[\s\S]*"role" = 'owner'/);
    // Fallback INSERT is guarded so it never double-seeds when admins were found.
    const ownerInserts = SQL.match(/INSERT INTO "organization_memberships"/g) ?? [];
    expect(ownerInserts.length).toBeGreaterThanOrEqual(2);
  });

  it("inserts the sentinel default Organization idempotently", () => {
    expect(SQL).toMatch(/'00000000-0000-0000-0000-000000000001'/);
    expect(SQL).toMatch(/'Default Organization'/);
    expect(SQL.toLowerCase()).toContain("on conflict");
    expect(SQL.toLowerCase()).toContain("do nothing");
  });

  it("backfills every company then flips the column NOT NULL — in that order", () => {
    const backfillIdx = SQL.search(/UPDATE "companies"\s+SET "organization_id"/i);
    const notNullIdx = SQL.search(/ALTER TABLE "companies" ALTER COLUMN "organization_id" SET NOT NULL/i);
    expect(backfillIdx).toBeGreaterThanOrEqual(0);
    expect(notNullIdx).toBeGreaterThanOrEqual(0);
    expect(backfillIdx).toBeLessThan(notNullIdx);
  });

  it("guards the backfill UPDATE with WHERE organization_id IS NULL (idempotent)", () => {
    expect(SQL).toMatch(/UPDATE "companies"\s+SET "organization_id"[\s\S]*WHERE "organization_id" IS NULL/i);
  });

  it("adds the FK only AFTER the column is populated + NOT NULL", () => {
    const notNullIdx = SQL.search(/SET NOT NULL/i);
    const fkIdx = SQL.search(/ADD CONSTRAINT "companies_organization_id_organizations_id_fk"/);
    expect(fkIdx).toBeGreaterThan(notNullIdx);
    expect(SQL).toMatch(/ON DELETE restrict/);
  });

  it("backfills owner memberships from instance admins, joined to real users", () => {
    expect(SQL).toMatch(/INSERT INTO "organization_memberships"/);
    expect(SQL).toMatch(/FROM "instance_user_roles"/);
    expect(SQL).toMatch(/JOIN "user"/);
    expect(SQL).toMatch(/'owner'/);
    expect(SQL).toMatch(/role = 'instance_admin'/);
  });

  it("swaps the prefix index to (organization_id, issue_prefix)", () => {
    expect(SQL).toMatch(/DROP INDEX IF EXISTS "companies_issue_prefix_idx"/);
    expect(SQL).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "companies_org_issue_prefix_idx" ON "companies"[\s\S]*"organization_id","issue_prefix"/);
  });

  it("re-scopes issues_identifier_idx to (company_id, identifier)", () => {
    expect(SQL).toMatch(/DROP INDEX IF EXISTS "issues_identifier_idx"/);
    expect(SQL).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "issues_identifier_idx" ON "issues"[\s\S]*"company_id","identifier"/);
  });

  it("orders index swaps AFTER the backfill (org_id populated before it is indexed)", () => {
    const backfillIdx = SQL.search(/UPDATE "companies"\s+SET "organization_id"/i);
    const prefixIdx = SQL.search(/CREATE UNIQUE INDEX IF NOT EXISTS "companies_org_issue_prefix_idx"/);
    expect(prefixIdx).toBeGreaterThan(backfillIdx);
  });
});
