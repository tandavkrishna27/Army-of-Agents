import { describe, expect, it } from "vitest";
import { slugifyOrganizationName, isOrgSlugConflict } from "../organizations.js";

describe("organizationService pure helpers", () => {
  it("slugifies a name to lowercase kebab-case", () => {
    expect(slugifyOrganizationName("Acme, Inc.")).toBe("acme-inc");
    expect(slugifyOrganizationName("  Hello   World  ")).toBe("hello-world");
  });
  it("falls back to 'org' for a name with no alphanumerics", () => {
    expect(slugifyOrganizationName("***")).toBe("org");
  });
  it("detects a 23505 conflict on organizations_slug_uq (nested cause chain)", () => {
    const err = { cause: { code: "23505", constraint: "organizations_slug_uq" } };
    expect(isOrgSlugConflict(err)).toBe(true);
  });
  it("ignores unrelated 23505s", () => {
    const err = { code: "23505", constraint: "some_other_uq" };
    expect(isOrgSlugConflict(err)).toBe(false);
  });
});
