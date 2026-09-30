import { describe, expect, it, vi } from "vitest";

function table(name: string) {
  return new Proxy({ __table: name }, {
    get(target, prop) {
      if (prop === "__table") return target.__table;
      return { table: name, name: String(prop) };
    },
  });
}

vi.mock("@armyofagents/db", () => ({
  companies: table("companies"),
  projects: table("projects"),
  memoryFolders: table("memoryFolders"),
  memoryItems: table("memoryItems"),
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ op: "and", args }),
  eq: (a: unknown, b: unknown) => ({ op: "eq", a, b }),
  isNull: (a: unknown) => ({ op: "isNull", a }),
  sql: (...args: unknown[]) => ({ op: "sql", args }),
}));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: () => undefined,
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { child: () => ({ info: () => undefined, warn: () => undefined }) },
}));

import {
  __memoryFolderSeedBackfillTest,
  backfillMemoryFolderSeeds,
} from "../migrations/backfill-memory-folder-seeds.js";

function createDb() {
  const state = {
    companies: [{ id: "co-1" }],
    projects: [
      {
        id: "dept-1",
        companyId: "co-1",
        name: "Software",
        type: "department",
        functionType: "software_development",
      },
      {
        id: "project-1",
        companyId: "co-1",
        name: "Website",
        type: "project",
        functionType: "general",
      },
    ],
    memoryFolders: [] as Array<Record<string, unknown>>,
  };

  return {
    state,
    select: () => ({
      from: (selectedTable: { __table: string }) => {
        const readRows = () => {
          if (selectedTable.__table === "companies") return state.companies;
          if (selectedTable.__table === "projects") {
            return state.projects.filter((project) => project.type === "department");
          }
          if (selectedTable.__table === "memoryFolders") return state.memoryFolders;
          return [];
        };
        return {
          where: async () => readRows(),
          then: (resolve: (rows: unknown[]) => unknown, reject?: (err: unknown) => unknown) =>
            Promise.resolve(readRows()).then(resolve, reject),
        };
      },
    }),
    insert: (selectedTable: { __table: string }) => ({
      values: (row: Record<string, unknown> | Record<string, unknown>[]) => {
        const doReturn = async () => {
          if (selectedTable.__table !== "memoryFolders") return [];
          const rows = Array.isArray(row) ? row : [row];
          const created = rows.map((value) => ({
            ...value,
            id: `folder-${state.memoryFolders.length}`,
            createdAt: new Date(),
            updatedAt: new Date(),
          }));
          state.memoryFolders.push(...created);
          return created;
        };
        // seedCompanyRootFolder chains .onConflictDoNothing() before
        // .returning(); support both call shapes off the same insert logic.
        return { returning: doReturn, onConflictDoNothing: () => ({ returning: doReturn }) };
      },
    }),
  };
}

describe("backfillMemoryFolderSeeds", () => {
  it("seeds existing companies and department projects", async () => {
    const db = createDb();

    const result = await backfillMemoryFolderSeeds(db as never);

    expect(result).toEqual({ companies: 1, departments: 1 });
    expect(db.state.memoryFolders).toContainEqual(expect.objectContaining({
      companyId: "co-1",
      departmentId: null,
      path: "Company/Agents/Agent Teams",
      seedKey: "company.agents-agent-teams",
    }));
    expect(db.state.memoryFolders).toContainEqual(expect.objectContaining({
      companyId: "co-1",
      departmentId: "dept-1",
      path: "software/Architecture",
      seedKey: "software_development.architecture",
    }));
    expect(db.state.memoryFolders.map((folder) => folder.path))
      .not.toContain("website/Overview");
  });

  it("derives stable department slugs from names", () => {
    expect(__memoryFolderSeedBackfillTest.departmentSlug("Software Development"))
      .toBe("software-development");
    expect(__memoryFolderSeedBackfillTest.departmentSlug("R&D / AI"))
      .toBe("r-and-d-ai");
    expect(__memoryFolderSeedBackfillTest.departmentSlug("!!!"))
      .toBe("department");
  });
});
