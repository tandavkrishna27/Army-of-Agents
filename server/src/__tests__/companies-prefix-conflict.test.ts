import { describe, expect, it, vi } from "vitest";

vi.mock("../services/memory-folders.js", () => ({
  memoryFoldersService: vi.fn(() => ({})),
  seedCompanyRootFolder: vi.fn().mockResolvedValue(undefined),
}));

import { companyService } from "../services/companies.js";

describe("companyService issue prefix allocation", () => {
  it("retries when a wrapped Postgres unique-constraint error hits the issue prefix", async () => {
    const duplicatePrefixError = Object.assign(new Error("Failed query"), {
      cause: {
        code: "23505",
        // Prefix-backed routes remain globally keyed until company-qualified
        // URLs ship, so the retry handler must key on the global index.
        constraint_name: "companies_issue_prefix_idx",
      },
    });
    const returning = vi
      .fn()
      .mockRejectedValueOnce(duplicatePrefixError)
      .mockResolvedValueOnce([
        {
          id: "company-1",
          name: "E2E Test Company",
          issuePrefix: "EETA",
        },
      ]);
    const values = vi.fn(() => ({ returning }));
    // T3.5: createCompanyWithUniquePrefix calls db.select().from(agents).where().limit(1)
    // to check for marketplace-installed crew. Return [] so the legacy ensure path runs.
    const db = {
      insert: vi.fn(() => ({ values })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([]),
          })),
        })),
      })),
    };

    const company = await companyService(db as never).create({
      name: "E2E Test Company",
      organizationId: "00000000-0000-0000-0000-000000000001",
    } as never);

    expect(company.issuePrefix).toBe("EETA");
    expect(values).toHaveBeenNthCalledWith(1, expect.objectContaining({
      issuePrefix: "EET",
    }));
    expect(values).toHaveBeenNthCalledWith(2, expect.objectContaining({
      issuePrefix: "EETA",
    }));
  });
});
