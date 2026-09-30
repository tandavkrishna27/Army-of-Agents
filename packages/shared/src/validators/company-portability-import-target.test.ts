import { describe, expect, it } from "vitest";
import type { CompanyPortabilityImportTarget } from "../types/company-portability.js";
import { companyPortabilityImportSchema } from "./company-portability.js";

// Minimal known-valid inline source (mirrors the shape validated by the import route).
const baseSource = {
  type: "inline" as const,
  manifest: {
    schemaVersion: 2,
    generatedAt: "2026-07-31T00:00:00.000Z",
    source: null,
    includes: { company: false, agents: false },
    company: null,
    agents: [],
    projects: [],
    requiredSecrets: [],
  },
  files: {},
};

const ORG = "00000000-0000-0000-0000-0000000000a1";

const typedNewCompanyTarget: CompanyPortabilityImportTarget = {
  mode: "new_company",
  organizationId: ORG,
};

describe("companyPortabilityImportSchema — new_company target organizationId", () => {
  it("keeps the handwritten import target aligned with the schema", () => {
    expect(typedNewCompanyTarget).toMatchObject({ organizationId: ORG });
  });

  it("preserves an explicit organizationId on a new_company target", () => {
    const parsed = companyPortabilityImportSchema.parse({
      source: baseSource,
      target: { mode: "new_company", newCompanyName: "X", organizationId: ORG },
    });
    expect(parsed.target).toMatchObject({ mode: "new_company", organizationId: ORG });
  });

  it("accepts a new_company target with no organizationId (optional)", () => {
    const parsed = companyPortabilityImportSchema.parse({
      source: baseSource,
      target: { mode: "new_company" },
    });
    expect((parsed.target as { organizationId?: string }).organizationId).toBeUndefined();
  });

  it("rejects a non-uuid organizationId", () => {
    expect(() =>
      companyPortabilityImportSchema.parse({
        source: baseSource,
        target: { mode: "new_company", organizationId: "not-a-uuid" },
      }),
    ).toThrow();
  });
});
