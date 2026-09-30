import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @armyofagents/db with proxy-based table stubs (matches AoA convention).
vi.mock("@armyofagents/db", () => ({
  memoryFolders: new Proxy({}, { get: (_t, p) => ({ name: String(p) }) }),
}));
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ op: "and", args }),
  eq: (a: unknown, b: unknown) => ({ op: "eq", a, b }),
  isNull: (a: unknown) => ({ op: "isNull", a }),
}));

import { memoryFoldersService } from "../services/memory-folders.js";

function createMockDb() {
  const folders: Array<Record<string, unknown>> = [];
  // When true, select().from().where() returns only folders whose
  // (companyId, path) matches the last-inserted values — lets the get-or-create
  // conflict test assert the existing row is returned rather than every folder.
  const scopedSelect = { companyId: null as unknown, path: null as unknown };
  return {
    folders,
    select: () => ({
      from: () => ({
        where: async () => {
          if (scopedSelect.path !== null) {
            return folders.filter(
              (f) => f.companyId === scopedSelect.companyId && f.path === scopedSelect.path,
            );
          }
          return folders;
        },
      }),
    }),
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        const insertOne = () => {
          const created = { ...row, id: `mock-${folders.length}`, createdAt: new Date(), updatedAt: new Date() };
          folders.push(created);
          return created;
        };
        return {
          // Direct insert (seedForDepartment path) — always inserts.
          returning: async () => [insertOne()],
          // Get-or-create path: no-op when (companyId, path) already exists.
          onConflictDoNothing: () => ({
            returning: async () => {
              scopedSelect.companyId = row.companyId;
              scopedSelect.path = row.path;
              const dup = folders.some(
                (f) => f.companyId === row.companyId && f.path === row.path,
              );
              if (dup) return [];
              return [insertOne()];
            },
          }),
        };
      },
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            if (folders.length === 0) return [];
            folders[0] = { ...folders[0], ...patch };
            return [folders[0]];
          },
        }),
      }),
    }),
    delete: () => ({
      where: async () => {
        folders.splice(0);
      },
    }),
  };
}

describe("memoryFoldersService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a folder with companyId and normalized path", async () => {
    const db = createMockDb();
    const svc = memoryFoldersService(db as never);
    const created = await svc.create({
      companyId: "co-1",
      departmentId: "dept-1",
      path: "  Engineering/Decisions  ",
      displayName: "Decisions",
    });
    expect(created.path).toBe("Engineering/Decisions");
    expect(created.companyId).toBe("co-1");
  });

  it("create is get-or-create: a duplicate (companyId, path) returns the existing row without inserting or throwing", async () => {
    const db = createMockDb();
    db.folders.push({
      id: "existing-1",
      companyId: "co-1",
      departmentId: null,
      path: "Company",
      displayName: "Company",
      seedKey: "company.root",
    });
    const svc = memoryFoldersService(db as never);

    const result = await svc.create({
      companyId: "co-1",
      departmentId: null,
      path: "Company",
      displayName: "Company",
      seedKey: "company.root",
    });

    // No duplicate inserted, and the pre-existing row is returned.
    expect(db.folders.filter((f) => f.path === "Company")).toHaveLength(1);
    expect(result.id).toBe("existing-1");
  });

  it("lists folders scoped to companyId", async () => {
    const db = createMockDb();
    db.folders.push({ id: "f-1", companyId: "co-1", path: "Engineering/Decisions" });
    const svc = memoryFoldersService(db as never);
    const list = await svc.list({ companyId: "co-1" });
    expect(list).toHaveLength(1);
  });

  it("update normalizes path", async () => {
    const db = createMockDb();
    db.folders.push({ id: "f-1", companyId: "co-1", path: "Engineering" });
    const svc = memoryFoldersService(db as never);
    const updated = await svc.update("f-1", "co-1", { path: "  Engineering/Subfolder  " });
    expect(updated?.path).toBe("Engineering/Subfolder");
  });

  it("seedForDepartment inserts one row per FolderSeed scoped to dept", async () => {
    const db = createMockDb();
    const svc = memoryFoldersService(db as never);
    await svc.seedForDepartment({
      companyId: "co-1",
      departmentId: "dept-1",
      departmentSlug: "engineering",
      functionType: "software_development",
    });
    expect(db.folders).toHaveLength(16);
    expect(db.folders[0].path).toBe("engineering/Overview");
    expect(db.folders[0].seedKey).toBe("software_development.overview");
    expect(db.folders).toContainEqual(expect.objectContaining({
      path: "engineering/Decisions",
      seedKey: "software_development.decisions",
    }));
    expect(db.folders.map((folder) => folder.path)).toContain("engineering/Architecture");
    expect(db.folders.map((folder) => folder.path)).toContain("engineering/QA & Testing");
  });

  it("seedForDepartment is idempotent — second call inserts nothing", async () => {
    const db = createMockDb();
    const svc = memoryFoldersService(db as never);
    await svc.seedForDepartment({
      companyId: "co-1",
      departmentId: "dept-1",
      departmentSlug: "engineering",
      functionType: "software_development",
    });
    const before = db.folders.length;
    await svc.seedForDepartment({
      companyId: "co-1",
      departmentId: "dept-1",
      departmentSlug: "engineering",
      functionType: "software_development",
    });
    expect(db.folders.length).toBe(before);
  });

  it("seedForDepartment skips legacy folders that already have the seeded path", async () => {
    const db = createMockDb();
    db.folders.push({
      id: "legacy-decisions",
      companyId: "co-1",
      departmentId: "dept-1",
      path: "engineering/Decisions",
      displayName: "Decisions",
      seedKey: null,
    });
    const svc = memoryFoldersService(db as never);

    await svc.seedForDepartment({
      companyId: "co-1",
      departmentId: "dept-1",
      departmentSlug: "engineering",
      functionType: "software_development",
    });

    expect(db.folders.filter((folder) => folder.path === "engineering/Decisions"))
      .toHaveLength(1);
    expect(db.folders).toHaveLength(16);
  });
});
