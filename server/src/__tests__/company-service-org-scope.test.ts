import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(resolve(__dirname, "../services/companies.ts"), "utf8");

describe("companyService org-scoping + route-safe prefix allocation", () => {
  it("keys the prefix-conflict handler on the temporary global route constraint", () => {
    expect(SRC).toContain('constraint === "companies_issue_prefix_idx"');
    expect(SRC).not.toContain('constraint === "companies_org_issue_prefix_idx"');
  });
  it("defaults organization_id to the sentinel on insert (back-compat)", () => {
    expect(SRC).toContain("DEFAULT_ORGANIZATION_ID");
    expect(SRC).toMatch(/organizationId:\s*data\.organizationId\s*\?\?\s*DEFAULT_ORGANIZATION_ID/);
  });
});
