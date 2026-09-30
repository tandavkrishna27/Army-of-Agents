import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROUTES = readFileSync(resolve(__dirname, "../routes/companies.ts"), "utf8");
const INDEX = readFileSync(resolve(__dirname, "../index.ts"), "utf8");

describe("company create attaches an organization + startup ensures default org", () => {
  it("passes an explicitly-resolved organizationId into svc.create (self-hosted resolves the Default Org)", () => {
    // TEN-006a / E2-D07: the route still resolves DEFAULT_ORGANIZATION_ID for
    // the self-hosted / isolation-not-enforced branch — but as an EXPLICIT,
    // documented resolution (`resolveCompanyOrganizationId`), never a silent
    // service-layer `?? DEFAULT_ORGANIZATION_ID` bucket.
    expect(ROUTES).toContain("DEFAULT_ORGANIZATION_ID");
    expect(ROUTES).toContain("resolveCompanyOrganizationId");
    expect(ROUTES).toMatch(/organizationId:/);
  });
  it("ensures the default organization on boot", () => {
    expect(INDEX).toContain("ensureDefaultOrganization");
  });
});
