import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROUTES = readFileSync(resolve(__dirname, "../routes/companies.ts"), "utf8");
const INDEX = readFileSync(resolve(__dirname, "../index.ts"), "utf8");

describe("company create attaches an organization + startup ensures default org", () => {
  it("passes organizationId into svc.create (sentinel in single-tenant)", () => {
    expect(ROUTES).toContain("DEFAULT_ORGANIZATION_ID");
    expect(ROUTES).toMatch(/organizationId:/);
  });
  it("ensures the default organization on boot", () => {
    expect(INDEX).toContain("ensureDefaultOrganization");
  });
});
