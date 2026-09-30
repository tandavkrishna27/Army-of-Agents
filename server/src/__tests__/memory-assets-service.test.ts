import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@armyofagents/db", () => ({
  memoryAssets: new Proxy({}, { get: (_t, p) => ({ name: String(p) }) }),
}));
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ op: "and", args }),
  eq: (a: unknown, b: unknown) => ({ op: "eq", a, b }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: "sql", strings, values }),
}));

import { memoryAssetsService } from "../services/memory-assets.js";

function createMockDb() {
  const assets: Array<Record<string, unknown>> = [];
  return {
    assets,
    select: () => ({
      from: () => ({
        where: async () => assets,
      }),
    }),
    insert: () => ({
      values: (row: Record<string, unknown>) => ({
        returning: async () => {
          const created = { ...row, id: `asset-${assets.length}`, createdAt: new Date(), updatedAt: new Date() };
          assets.push(created);
          return [created];
        },
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => {
          // Apply the patch to the first row (simulating db side-effect)
          const apply = (): Array<Record<string, unknown>> => {
            if (assets.length === 0) return [];
            const incrementOp = patch.extractedItemCount as { op?: string; values?: unknown[] } | undefined;
            if (incrementOp && typeof incrementOp === "object" && incrementOp.op === "sql") {
              const currentCount = (assets[0].extractedItemCount as number) ?? 0;
              const delta = (incrementOp.values?.[1] as number) ?? 0;
              assets[0] = { ...assets[0], extractedItemCount: currentCount + delta };
            } else {
              assets[0] = { ...assets[0], ...patch };
            }
            return [assets[0]];
          };
          const promise = Promise.resolve().then(() => { apply(); });
          return Object.assign(promise, {
            returning: async () => apply(),
          });
        },
      }),
    }),
    delete: () => ({ where: async () => { assets.splice(0); } }),
  };
}

describe("memoryAssetsService", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates an asset row scoped by companyId", async () => {
    const db = createMockDb();
    const svc = memoryAssetsService(db as never);
    const created = await svc.create({
      companyId: "co-1",
      departmentId: "dept-1",
      folderPath: "Engineering/Files",
      fileName: "rfc-9421.pdf",
      mimeType: "application/pdf",
      fileSize: 1024,
      storageKey: "co-1/file-imports/abc-rfc-9421.pdf",
    });
    expect(created.companyId).toBe("co-1");
    expect(created.fileName).toBe("rfc-9421.pdf");
    expect(created.extractedItemCount).toBe(0);
  });

  it("lists assets filtered by folderPath", async () => {
    const db = createMockDb();
    db.assets.push({ id: "a-1", companyId: "co-1", folderPath: "Engineering/Files" });
    db.assets.push({ id: "a-2", companyId: "co-1", folderPath: "Marketing/Files" });
    const svc = memoryAssetsService(db as never);
    const all = await svc.list({ companyId: "co-1" });
    expect(all).toHaveLength(2);
  });

  it("update can rename and move", async () => {
    const db = createMockDb();
    db.assets.push({ id: "a-1", companyId: "co-1", fileName: "old.pdf", folderPath: "X" });
    const svc = memoryAssetsService(db as never);
    const updated = await svc.update("a-1", "co-1", {
      fileName: "new.pdf",
      folderPath: " Y / Z ",
    });
    expect(updated?.fileName).toBe("new.pdf");
    expect(updated?.folderPath).toBe("Y/Z");
  });

  it("incrementExtractedCount increases counter atomically", async () => {
    const db = createMockDb();
    db.assets.push({ id: "a-1", companyId: "co-1", extractedItemCount: 5 });
    const svc = memoryAssetsService(db as never);
    await svc.incrementExtractedCount("a-1", "co-1", 3);
    expect(db.assets[0].extractedItemCount).toBe(8);
  });
});
