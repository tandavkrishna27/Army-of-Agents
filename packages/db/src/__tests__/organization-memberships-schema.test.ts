import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = join(__dirname, "..", "schema", "organization_memberships.ts");
const INDEX_FILE = join(__dirname, "..", "schema", "index.ts");

describe("organization_memberships schema", () => {
  const src = readFileSync(SCHEMA_FILE, "utf8");
  const indexSrc = readFileSync(INDEX_FILE, "utf8");

  it("defines a human membership row", () => {
    expect(src).toMatch(/pgTable\(\s*"organization_memberships"/);
    expect(src).toMatch(/organizationId:\s*uuid\("organization_id"\)\.notNull\(\)\.references\(\(\)\s*=>\s*organizations\.id,\s*\{\s*onDelete:\s*"cascade"\s*\}\)/);
    expect(src).toMatch(/userId:\s*text\("user_id"\)\.notNull\(\)\.references\(\(\)\s*=>\s*authUsers\.id,\s*\{\s*onDelete:\s*"cascade"\s*\}\)/);
    expect(src).toMatch(/role:\s*text\("role"\)\.notNull\(\)\.default\("member"\)/);
    expect(src).toMatch(/status:\s*text\("status"\)\.notNull\(\)\.default\("active"\)/);
    expect(src).toMatch(/invitedByUserId:\s*text\("invited_by_user_id"\)/);
    expect(src).toMatch(/joinedAt:\s*timestamp\("joined_at"/);
  });

  it("is unique per (organization, user)", () => {
    expect(src).toMatch(
      /uniqueIndex\("organization_memberships_org_user_uq"\)\.on\(table\.organizationId,\s*table\.userId\)/,
    );
  });

  it("checks role and status vocabularies", () => {
    expect(src).toMatch(/organization_memberships_role_check",\s*sql`role IN \('owner', 'admin', 'member', 'billing'\)`/);
    expect(src).toMatch(/organization_memberships_status_check",\s*sql`status IN \('pending', 'active', 'suspended'\)`/);
  });

  it("is exported from the schema barrel", () => {
    expect(indexSrc).toContain('export { organizationMemberships } from "./organization_memberships.js";');
  });
});
