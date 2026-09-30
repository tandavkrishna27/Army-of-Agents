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
// Mock live-events to avoid side-effect imports
vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: () => undefined,
}));

import {
  getSeedFoldersForFunctionType,
  COMPANY_SEED_FOLDERS,
} from "../services/memory-folder-seeds.js";
import { seedFoldersOnDepartmentCreate } from "../services/memory-folders.js";

describe("memory-folder-seeds", () => {
  it("returns engineering seed folders for software_development", () => {
    const seeds = getSeedFoldersForFunctionType("software_development");
    expect(seeds.map((s) => s.displayName)).toEqual([
      "Overview",
      "Plans & Priorities",
      "Decisions",
      "Playbooks",
      "Processes",
      "Policies",
      "References",
      "Metrics",
      "People & Responsibilities",
      "Tools & Systems",
      "Files",
      "Architecture",
      "Codebase",
      "Releases",
      "Incidents",
      "QA & Testing",
    ]);
  });

  it("returns marketing seed folders", () => {
    const seeds = getSeedFoldersForFunctionType("marketing");
    expect(seeds.map((s) => s.displayName)).toEqual([
      "Overview",
      "Plans & Priorities",
      "Decisions",
      "Playbooks",
      "Processes",
      "Policies",
      "References",
      "Metrics",
      "People & Responsibilities",
      "Tools & Systems",
      "Files",
      "Brand",
      "Campaigns",
      "Channels",
      "Audience",
      "Launches",
    ]);
  });

  it("returns canonical support seed folders", () => {
    const seeds = getSeedFoldersForFunctionType("support");
    expect(seeds.map((s) => s.path)).toContain("Plans & Priorities");
    expect(seeds.map((s) => s.path)).toContain("Macros");
    expect(seeds.map((s) => s.path)).toContain("Escalations");
    expect(seeds.map((s) => s.path)).toContain("Customer Issues");
    expect(seeds.map((s) => s.path)).toContain("FAQs");
  });

  it("keeps old customer_support alias compatible", () => {
    expect(getSeedFoldersForFunctionType("customer_support").map((s) => s.path)).toEqual(
      getSeedFoldersForFunctionType("support").map((s) => s.path),
    );
  });

  it("returns canonical hr and research seed folders", () => {
    expect(getSeedFoldersForFunctionType("hr").map((s) => s.path)).toContain("Hiring");
    expect(getSeedFoldersForFunctionType("hr").map((s) => s.path)).toContain("Onboarding");
    expect(getSeedFoldersForFunctionType("research").map((s) => s.path)).toContain("Findings");
    expect(getSeedFoldersForFunctionType("research").map((s) => s.path)).toContain("Experiments");
  });

  it("returns generic seed folders for unknown function type", () => {
    const seeds = getSeedFoldersForFunctionType("totally_unknown");
    expect(seeds.map((s) => s.displayName)).toEqual([
      "Overview",
      "Plans & Priorities",
      "Decisions",
      "Playbooks",
      "Processes",
      "Policies",
      "References",
      "Metrics",
      "People & Responsibilities",
      "Tools & Systems",
      "Files",
    ]);
  });

  it("returns generic seed folders when functionType is null", () => {
    const seeds = getSeedFoldersForFunctionType(null);
    expect(seeds.map((s) => s.displayName)).toEqual([
      "Overview",
      "Plans & Priorities",
      "Decisions",
      "Playbooks",
      "Processes",
      "Policies",
      "References",
      "Metrics",
      "People & Responsibilities",
      "Tools & Systems",
      "Files",
    ]);
  });

  it("each seed has a stable seedKey for collision-safe creation", () => {
    const seeds = getSeedFoldersForFunctionType("software_development");
    expect(seeds.find((s) => s.displayName === "Decisions")?.seedKey).toBe(
      "software_development.decisions",
    );
  });

  it("COMPANY_SEED_FOLDERS exposes the expanded company identity folders", () => {
    expect(COMPANY_SEED_FOLDERS.map((s) => s.path)).toEqual([
      "Company",
      "Company/Profile",
      "Company/Mission & Vision",
      "Company/Strategy",
      "Company/Operating Principles",
      "Company/Brand & Voice",
      "Company/Policies",
      "Company/People",
      "Company/People/Humans",
      "Company/People/Teams",
      "Company/People/Roles",
      "Company/Agents",
      "Company/Agents/Directory",
      "Company/Agents/Responsibilities",
      "Company/Agents/Agent Teams",
      "Company/Decisions",
      "Company/Processes",
      "Company/References",
      "Company/Files",
    ]);
    expect(COMPANY_SEED_FOLDERS[0]).toMatchObject({
      path: "Company",
      displayName: "Company",
      seedKey: "company.root",
    });
  });
});

describe("seedFoldersOnDepartmentCreate", () => {
  it("seeds folders for newly-created department", async () => {
    const seedSpy = vi.fn(async () => []);
    const fakeSvc = { seedForDepartment: seedSpy };
    await seedFoldersOnDepartmentCreate(fakeSvc as never, {
      companyId: "co-1",
      project: {
        id: "p-1",
        type: "department",
        name: "Engineering",
        urlKey: "engineering",
        functionType: "software_development",
      },
    });
    expect(seedSpy).toHaveBeenCalledWith({
      companyId: "co-1",
      departmentId: "p-1",
      departmentSlug: "engineering",
      functionType: "software_development",
    });
  });

  it("does NOT seed folders for non-department projects", async () => {
    const seedSpy = vi.fn();
    const fakeSvc = { seedForDepartment: seedSpy };
    await seedFoldersOnDepartmentCreate(fakeSvc as never, {
      companyId: "co-1",
      project: { id: "p-1", type: "project", name: "X", urlKey: "x", functionType: null },
    });
    expect(seedSpy).not.toHaveBeenCalled();
  });
});
