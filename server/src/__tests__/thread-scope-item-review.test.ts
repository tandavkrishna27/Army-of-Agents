import { beforeEach, describe, expect, it, vi } from "vitest";

import { threadScopeVersionService } from "../services/thread-scope-versions.js";

function createSequenceDb(selectQueue: any[][], updateQueue: any[][] = []) {
  let selectIdx = 0;
  let updateIdx = 0;
  const capturedUpdates: unknown[] = [];

  function makeSelectChain() {
    return {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      then: vi.fn((fn: (rows: any[]) => any) =>
        Promise.resolve(fn(selectQueue[selectIdx++] ?? [])),
      ),
    };
  }

  function makeUpdateChain() {
    return {
      set: vi.fn((data: unknown) => {
        capturedUpdates.push(data);
        return {
          where: vi.fn(() => ({
            returning: vi.fn().mockReturnThis(),
            then: vi.fn((fn: (rows: any[]) => any) =>
              Promise.resolve(fn(updateQueue[updateIdx++] ?? [])),
            ),
          })),
        };
      }),
    };
  }

  const dbObj: any = {
    select: vi.fn(() => makeSelectChain()),
    update: vi.fn(() => makeUpdateChain()),
    capturedUpdates,
  };
  return dbObj;
}

const draftVersion = {
  id: "scope1",
  companyId: "co1",
  threadId: "thread1",
  versionNumber: 1,
  status: "draft",
  sourceEndSeq: 2,
};

const taskItem = {
  id: "task-item",
  companyId: "co1",
  scopeVersionId: "scope1",
  kind: "task_proposal",
  status: "draft",
  title: "Draft task",
  description: "Draft task description",
  payload: {},
  sourceEntryIds: ["entry1"],
};

const noisyItem = {
  id: "noisy-item",
  companyId: "co1",
  scopeVersionId: "scope1",
  kind: "memory_candidate",
  status: "draft",
  title: "Noisy memory",
  description: "Do not keep this.",
  payload: {},
  sourceEntryIds: ["entry1"],
};

describe("threadScopeVersionService item review", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-08T10:00:00.000Z"));
  });

  it("accepts and rejects items on a draft scope version", async () => {
    const db = createSequenceDb(
      [[draftVersion], [taskItem, noisyItem]],
      [[{ ...taskItem, status: "accepted" }], [{ ...noisyItem, status: "rejected" }]],
    );

    const result = await (threadScopeVersionService(db) as any).reviewItems(
      "co1",
      "thread1",
      "scope1",
      {
        items: [
          { itemId: "task-item", status: "accepted" },
          { itemId: "noisy-item", status: "rejected" },
        ],
      },
      { userId: "u1", isHuman: true },
    );

    expect(result).toMatchObject({
      ok: true,
      updatedItems: [
        expect.objectContaining({ id: "task-item", status: "accepted" }),
        expect.objectContaining({ id: "noisy-item", status: "rejected" }),
      ],
    });
    expect(db.capturedUpdates).toEqual([
      expect.objectContaining({ status: "accepted", updatedAt: new Date("2026-06-08T10:00:00.000Z") }),
      expect.objectContaining({ status: "rejected", updatedAt: new Date("2026-06-08T10:00:00.000Z") }),
    ]);
  });

  it("does not partially mutate a batch when any reviewed item is missing", async () => {
    const db = createSequenceDb(
      [[draftVersion], [taskItem]],
      [[{ ...taskItem, status: "accepted" }]],
    );

    const result = await (threadScopeVersionService(db) as any).reviewItems(
      "co1",
      "thread1",
      "scope1",
      {
        items: [
          { itemId: "task-item", status: "accepted" },
          { itemId: "missing-item", status: "rejected" },
        ],
      },
      { userId: "u1", isHuman: true },
    );

    expect(result).toEqual({
      ok: false,
      reason: "item_not_found",
      message: "Scope item not found",
    });
    expect(db.capturedUpdates).toEqual([]);
  });

  it("edits a draft scope item without changing applied state", async () => {
    const editedItem = {
      ...taskItem,
      status: "accepted",
      title: "Edited task title",
      description: "Edited task description",
      payload: { priority: "high" },
      sourceEntryIds: ["entry1", "entry2"],
    };
    const db = createSequenceDb([[draftVersion]], [[editedItem]]);

    const result = await (threadScopeVersionService(db) as any).updateItem(
      "co1",
      "thread1",
      "scope1",
      "task-item",
      {
        title: "Edited task title",
        description: "Edited task description",
        payload: { priority: "high" },
        sourceEntryIds: ["entry1", "entry2"],
        status: "accepted",
      },
      { userId: "u1", isHuman: true },
    );

    expect(result).toMatchObject({
      ok: true,
      item: expect.objectContaining({
        id: "task-item",
        title: "Edited task title",
        description: "Edited task description",
        status: "accepted",
      }),
    });
    expect(db.capturedUpdates[0]).toMatchObject({
      title: "Edited task title",
      description: "Edited task description",
      payload: { priority: "high" },
      sourceEntryIds: ["entry1", "entry2"],
      status: "accepted",
      updatedAt: new Date("2026-06-08T10:00:00.000Z"),
    });
    expect(db.capturedUpdates[0]).not.toMatchObject({ status: "applied" });
  });

  it("does not mutate items when the parent scope version is not draft", async () => {
    const db = createSequenceDb([[{ ...draftVersion, status: "accepted" }]]);

    const result = await (threadScopeVersionService(db) as any).reviewItems(
      "co1",
      "thread1",
      "scope1",
      { items: [{ itemId: "task-item", status: "accepted" }] },
      { userId: "u1", isHuman: true },
    );

    expect(result).toEqual({
      ok: false,
      reason: "not_draft",
      message: "Scope version must be draft to review items",
    });
    expect(db.capturedUpdates).toEqual([]);
  });

  it("rejects applied as an item review status", async () => {
    const db = createSequenceDb([[draftVersion]]);

    const result = await (threadScopeVersionService(db) as any).updateItem(
      "co1",
      "thread1",
      "scope1",
      "task-item",
      { status: "applied" },
      { userId: "u1", isHuman: true },
    );

    expect(result).toEqual({
      ok: false,
      reason: "invalid_status",
      message: "Scope item review status must be draft, accepted, or rejected",
    });
    expect(db.capturedUpdates).toEqual([]);
  });

  it("wraps the batch in a transaction and rolls back when a row disappears mid-batch", async () => {
    // Minor: reviewItems must apply per-item updates inside the guarded
    // transaction so a mid-batch failure does not leave partial accepted/rejected
    // state committed.
    let selectIdx = 0;
    let updateIdx = 0;
    const selectQueue: any[][] = [
      [draftVersion],
      [{ id: "task-item" }, { id: "noisy-item" }], // both exist on the pre-check
    ];
    // First update succeeds; second update returns no row (concurrent change).
    const updateQueue: any[][] = [[{ ...taskItem, status: "accepted" }], []];
    let committed = false;
    let rolledBack = false;

    function makeSelectChain() {
      return {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        then: vi.fn((fn: (rows: any[]) => any) =>
          Promise.resolve(fn(selectQueue[selectIdx++] ?? [])),
        ),
      };
    }
    function makeUpdateChain() {
      return {
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => updateQueue[updateIdx++] ?? []),
          })),
        })),
      };
    }

    const db: any = {
      select: vi.fn(() => makeSelectChain()),
      update: vi.fn(() => makeUpdateChain()),
      transaction: vi.fn(async (fn: (tx: any) => Promise<any>) => {
        try {
          const out = await fn(db);
          committed = true;
          return out;
        } catch (err) {
          rolledBack = true;
          throw err;
        }
      }),
    };

    const result = await (threadScopeVersionService(db) as any).reviewItems(
      "co1",
      "thread1",
      "scope1",
      {
        items: [
          { itemId: "task-item", status: "accepted" },
          { itemId: "noisy-item", status: "rejected" },
        ],
      },
      { userId: "u1", isHuman: true },
    );

    expect(result).toEqual({
      ok: false,
      reason: "item_not_found",
      message: "Scope item not found",
    });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(rolledBack).toBe(true);
    expect(committed).toBe(false);
  });

  it("commits a successful batch through the transaction", async () => {
    let selectIdx = 0;
    let updateIdx = 0;
    const selectQueue: any[][] = [
      [draftVersion],
      [{ id: "task-item" }],
    ];
    const updateQueue: any[][] = [[{ ...taskItem, status: "accepted" }]];
    let committed = false;

    function makeSelectChain() {
      return {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        then: vi.fn((fn: (rows: any[]) => any) =>
          Promise.resolve(fn(selectQueue[selectIdx++] ?? [])),
        ),
      };
    }
    function makeUpdateChain() {
      return {
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => updateQueue[updateIdx++] ?? []),
          })),
        })),
      };
    }

    const db: any = {
      select: vi.fn(() => makeSelectChain()),
      update: vi.fn(() => makeUpdateChain()),
      transaction: vi.fn(async (fn: (tx: any) => Promise<any>) => {
        const out = await fn(db);
        committed = true;
        return out;
      }),
    };

    const result = await (threadScopeVersionService(db) as any).reviewItems(
      "co1",
      "thread1",
      "scope1",
      { items: [{ itemId: "task-item", status: "accepted" }] },
      { userId: "u1", isHuman: true },
    );

    expect(result).toMatchObject({
      ok: true,
      updatedItems: [expect.objectContaining({ id: "task-item", status: "accepted" })],
    });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(committed).toBe(true);
  });
});
