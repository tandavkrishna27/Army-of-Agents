import { describe, expect, it, vi } from "vitest";

// seedNewCompanyBestEffort (post-insert, best-effort) touches the memory-folder
// seeder; stub it so the positive-path assertions exercise the writer, not the
// seeder. All other seeders are `.catch`-wrapped / never-throw, matching the
// companies-prefix-conflict.test.ts mock-db precedent.
vi.mock("../services/memory-folders.js", () => ({
  memoryFoldersService: vi.fn(() => ({})),
  seedCompanyRootFolder: vi.fn().mockResolvedValue(undefined),
}));

import { companyService } from "../services/companies.js";
import { DEFAULT_ORGANIZATION_ID } from "@armyofagents/shared";

function makeMockDb(returningRow: Record<string, unknown>) {
  const returning = vi.fn().mockResolvedValue([returningRow]);
  const values = vi.fn(() => ({ returning }));
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
  return { db, values, returning };
}

// TEN-006a / E2-D07: the Company writers no longer silently bucket an
// Organization-omitting create to DEFAULT_ORGANIZATION_ID. The owning
// Organization must be resolved explicitly by the caller (the self-hosted
// Default Org via resolveCompanyOrganizationId, or the real tenant in
// cloud_auth). A writer reached with no resolvable Organization fails CLOSED.
describe("company writers fail closed on an unresolved Organization (TEN-006a / E2-D07)", () => {
  it("create() throws when no organizationId is resolvable (no silent sentinel bucketing)", async () => {
    const { db } = makeMockDb({ id: "c1", name: "No Org Co", issuePrefix: "NOC" });
    await expect(
      companyService(db as never).create({ name: "No Org Co" } as never),
    ).rejects.toThrow(/explicitly resolved organizationId/i);
  });

  it("create() succeeds and stamps the explicitly-resolved organizationId", async () => {
    const { db, values } = makeMockDb({
      id: "c1",
      name: "Org Co",
      issuePrefix: "ORG",
      organizationId: "org-explicit",
    });
    const company = await companyService(db as never).create({
      name: "Org Co",
      organizationId: "org-explicit",
    } as never);
    expect(company.id).toBe("c1");
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-explicit" }),
    );
  });

  it("create() accepts the DEFAULT Organization when the caller resolves it explicitly (self-hosted)", async () => {
    const { db, values } = makeMockDb({
      id: "c2",
      name: "Self Hosted Co",
      issuePrefix: "SHC",
      organizationId: DEFAULT_ORGANIZATION_ID,
    });
    await companyService(db as never).create({
      name: "Self Hosted Co",
      organizationId: DEFAULT_ORGANIZATION_ID,
    } as never);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: DEFAULT_ORGANIZATION_ID }),
    );
  });

  it("createWithOperator() throws before any write when no organizationId is resolvable", async () => {
    const { db } = makeMockDb({ id: "c3", name: "No Org Co" });
    await expect(
      companyService(db as never).createWithOperator(
        { name: "No Org Co" } as never,
        {},
        "user-1",
        (() => ({ ensureRealOperator: vi.fn() })) as never,
      ),
    ).rejects.toThrow(/explicitly resolved organizationId/i);
  });
});
