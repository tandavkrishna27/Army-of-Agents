import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(resolve(__dirname, "../services/companies.ts"), "utf8");

describe("companyService org-scoping + route-safe prefix allocation", () => {
  it("keys the prefix-conflict handler on the temporary global route constraint", () => {
    expect(SRC).toContain('constraint === "companies_issue_prefix_idx"');
    expect(SRC).not.toContain('constraint === "companies_org_issue_prefix_idx"');
  });
  it("resolves organization_id explicitly and fails closed on an omitted Organization (TEN-006a / E2-D07)", () => {
    // The fail-OPEN silent-sentinel bucket is GONE: a Company writer no longer
    // buckets an Organization-omitting create to DEFAULT_ORGANIZATION_ID.
    expect(SRC).not.toMatch(/organizationId:\s*data\.organizationId\s*\?\?\s*DEFAULT_ORGANIZATION_ID/);
    expect(SRC).not.toContain("data.organizationId ?? DEFAULT_ORGANIZATION_ID");
    // Writers resolve the Organization through the fail-closed guard, which
    // throws when no Organization is resolvable (never buckets to the sentinel).
    expect(SRC).toContain("requireResolvedOrganizationId");
    expect(SRC).toMatch(/function requireResolvedOrganizationId/);
  });
});
