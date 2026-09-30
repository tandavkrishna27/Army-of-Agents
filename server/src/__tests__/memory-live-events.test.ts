import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@armyofagents/db", () => ({
  memoryFolders: new Proxy({}, { get: (_t, p) => ({ name: String(p) }) }),
  memoryAssets: new Proxy({}, { get: (_t, p) => ({ name: String(p) }) }),
  memoryItems: new Proxy({}, { get: (_t, p) => ({ name: String(p) }) }),
}));
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ op: "and", args }),
  eq: (a: unknown, b: unknown) => ({ op: "eq", a, b }),
  isNull: (a: unknown) => ({ op: "isNull", a }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: "sql", strings, values }),
}));

const { publishMock } = vi.hoisted(() => ({ publishMock: vi.fn() }));
vi.mock("../services/live-events.js", () => ({ publishLiveEvent: publishMock }));

import { memoryFoldersService } from "../services/memory-folders.js";
import { memoryAssetsService } from "../services/memory-assets.js";

function tinyDb() {
  const rows: Array<Record<string, unknown>> = [];
  // Phase 6.2b's remove() does multiple selects (target, affected items,
  // affected sub-folders). The very first select returns the target folder
  // row; the rest should return empty so the reparent loops are no-ops in
  // this minimal fixture. Sequence-based discriminator (a table-name check
  // doesn't work because @armyofagents/db is mocked with a Proxy that
  // returns an object for any property access).
  let selectIdx = 0;
  const dbLike: Record<string, unknown> = {
    rows,
    select: () => {
      const idx = selectIdx++;
      return {
        from: () => ({
          where: async () => (idx === 0 ? rows : []),
        }),
      };
    },
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        const doReturn = async () => {
          const created = { ...row, id: `r-${rows.length}`, createdAt: new Date(), updatedAt: new Date() };
          rows.push(created);
          return [created];
        };
        // memory-folders.create now chains .onConflictDoNothing() before
        // .returning(); support both call shapes off the same insert logic.
        return { returning: doReturn, onConflictDoNothing: () => ({ returning: doReturn }) };
      },
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            if (rows.length === 0) return [];
            rows[0] = { ...rows[0], ...patch };
            return [rows[0]];
          },
        }),
      }),
    }),
    delete: () => ({ where: async () => { rows.splice(0); } }),
  };
  // Codex P1 follow-up: memory-folders.remove now wraps reparent + delete
  // in db.transaction(...). The mock passes itself in as the `tx` param.
  dbLike.transaction = async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn(dbLike);
  return dbLike as { rows: Array<Record<string, unknown>> } & Record<string, unknown>;
}

describe("LiveEvents publishes from memory services", () => {
  beforeEach(() => publishMock.mockClear());

  it("memoryFoldersService.create publishes memory.folder.created", async () => {
    const db = tinyDb();
    const svc = memoryFoldersService(db as never);
    await svc.create({
      companyId: "co-1",
      departmentId: null,
      path: "Engineering",
      displayName: "Engineering",
    });
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "memory.folder.created",
        companyId: "co-1",
      }),
    );
  });

  it("memoryAssetsService.create publishes memory.asset.created", async () => {
    const db = tinyDb();
    const svc = memoryAssetsService(db as never);
    await svc.create({
      companyId: "co-1",
      departmentId: null,
      folderPath: "Files",
      fileName: "x.pdf",
      mimeType: "application/pdf",
      fileSize: 1,
      storageKey: "k",
    });
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "memory.asset.created",
        companyId: "co-1",
      }),
    );
  });

  it("memoryFoldersService.remove publishes memory.folder.deleted", async () => {
    const db = tinyDb();
    // seedKey: null is required — Phase 6.2b introduced a guard that refuses
    // to delete seeded folders, so the fixture has to opt in to "user folder".
    // path is required too — the parent-path computation reads it.
    db.rows.push({
      id: "f-1",
      companyId: "co-1",
      seedKey: null,
      path: "Engineering",
    });
    const svc = memoryFoldersService(db as never);
    await svc.remove("f-1", "co-1");
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "memory.folder.deleted",
        companyId: "co-1",
      }),
    );
  });
});
