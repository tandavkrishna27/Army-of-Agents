import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(
  new URL("../migrations/0197_clever_tana_nile.sql", import.meta.url),
  "utf8",
);

describe("migration 0197 route-prefix safety", () => {
  it("replaces per-organization uniqueness with temporary global uniqueness", () => {
    expect(SQL).toContain('DROP INDEX "companies_org_issue_prefix_idx"');
    expect(SQL).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "companies_issue_prefix_idx" ON "companies"[\s\S]*\("issue_prefix"\)/,
    );
    expect(SQL).not.toMatch(/CREATE UNIQUE INDEX[\s\S]*\("organization_id",\s*"issue_prefix"\)/);
  });

  it("drops the old index before creating the route-safe replacement", () => {
    expect(SQL.indexOf('DROP INDEX "companies_org_issue_prefix_idx"')).toBeLessThan(
      SQL.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS "companies_issue_prefix_idx"'),
    );
  });
});
