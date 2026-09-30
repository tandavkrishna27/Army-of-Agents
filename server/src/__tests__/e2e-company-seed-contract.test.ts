import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Playwright company seeding contract", () => {
  it("uses deterministic API seeding instead of the retired onboarding modal", () => {
    const source = readFileSync(
      resolve(process.cwd(), "tests/e2e/helpers/seed-company.ts"),
      "utf8",
    );

    expect(source).toContain("export async function seedConfiguredCompany");
    expect(source).toContain('request.post("/api/companies"');
    expect(source).toContain("request.patch(");
    expect(source).not.toContain("seedCompanyViaWizard");
    expect(source).not.toContain("Name your company");
    expect(source).not.toContain("Choose your Commander");
  });
});
