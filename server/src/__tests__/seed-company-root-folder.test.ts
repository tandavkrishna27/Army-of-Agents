import { describe, it, expect, vi } from "vitest";

// Mock drizzle dependencies so importing memory-folders.ts doesn't trigger the ESM cycle.
vi.mock("@armyofagents/db", () => ({
  memoryFolders: new Proxy({}, { get: (_t, p) => ({ name: String(p) }) }),
}));
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ op: "and", args }),
  eq: (a: unknown, b: unknown) => ({ op: "eq", a, b }),
  isNull: (a: unknown) => ({ op: "isNull", a }),
}));
vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: () => undefined,
}));
vi.mock("../middleware/logger.js", () => ({
  logger: { child: () => ({ info: () => undefined, warn: () => undefined }) },
}));

import { seedCompanyRootFolder } from "../services/memory-folders.js";

describe("seedCompanyRootFolder", () => {
  it("creates the expanded Company folder set for a new company", async () => {
    const createSpy = vi.fn(async (input) => ({ id: `f-${input.seedKey}`, path: input.path }));
    const fakeSvc = { create: createSpy };

    await seedCompanyRootFolder(fakeSvc as never, { companyId: "co-1" });

    expect(createSpy).toHaveBeenCalledTimes(19);
    expect(createSpy).toHaveBeenNthCalledWith(1, expect.objectContaining({
      companyId: "co-1",
      departmentId: null,
      path: "Company",
      displayName: "Company",
      seedKey: "company.root",
    }));
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
      path: "Company/People/Humans",
      seedKey: "company.people-humans",
    }));
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
      path: "Company/Agents/Agent Teams",
      seedKey: "company.agents-agent-teams",
    }));
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
      path: "Company/Files",
      seedKey: "company.files",
    }));
  });

  it("is idempotent and continues creating missing folders after duplicate seeds", async () => {
    const createdPaths: string[] = [];
    const createSpy = vi.fn(async (input) => {
      if (input.path === "Company") {
        throw new Error("duplicate key value violates unique constraint \"memory_folders_unique_path_per_company\"");
      }
      createdPaths.push(input.path);
      return { id: `f-${input.seedKey}`, path: input.path };
    });
    const fakeSvc = { create: createSpy };

    await expect(
      seedCompanyRootFolder(fakeSvc as never, { companyId: "co-1" }),
    ).resolves.toBeUndefined();

    expect(createdPaths).toContain("Company/Profile");
    expect(createdPaths).toContain("Company/Files");
  });
});
