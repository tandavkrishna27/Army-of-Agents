import { beforeEach, describe, expect, it, vi } from "vitest";
import { hubCounterSnapshots, hubItemUserState } from "@armyofagents/db";
import { hubCounterSnapshotsService } from "../services/hub-counter-snapshots.js";

function makeMutationChain(returningRows: unknown[] = []) {
  const chain = {
    set: vi.fn(() => chain),
    where: vi.fn(() => Promise.resolve(returningRows)),
    values: vi.fn(() => chain),
    onConflictDoUpdate: vi.fn(() => chain),
    returning: vi.fn(() => Promise.resolve(returningRows)),
  };
  return chain;
}

function makeSelectChain(rows: unknown[]) {
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(() => Promise.resolve(rows)),
    then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return chain;
}

function makeDb(snapshotRows: unknown[] = []) {
  const insertChain = makeMutationChain([
    {
      openCount: 5,
      unreadCount: 4,
      computedAt: new Date("2026-06-30T10:02:00.000Z"),
      invalidatedAt: null,
    },
  ]);
  const updateChain = makeMutationChain();
  const db = {
    select: vi.fn(() => makeSelectChain(snapshotRows)),
    insert: vi.fn(() => insertChain),
    update: vi.fn(() => updateChain),
  };
  return { db, insertChain, updateChain };
}

const ctx = {
  companyId: "11111111-1111-1111-1111-111111111111",
  userId: "user-1",
  role: "founder" as const,
};

describe("hubCounterSnapshotsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refreshes one user counter snapshot without creating user-item rows", async () => {
    const { db } = makeDb();
    const liveCounts = vi.fn().mockResolvedValue({ open: 5, unread: 4 });
    const svc = hubCounterSnapshotsService(db as never, { liveCounts });

    await svc.refresh(ctx);

    expect(liveCounts).toHaveBeenCalledWith(ctx);
    expect(db.insert).toHaveBeenCalledWith(hubCounterSnapshots);
    expect(db.insert).not.toHaveBeenCalledWith(hubItemUserState);
  });

  it("returns a valid snapshot without recomputing live counts", async () => {
    const { db } = makeDb([
      {
        openCount: 3,
        unreadCount: 2,
        invalidatedAt: new Date("2026-06-30T09:59:00.000Z"),
        computedAt: new Date("2026-06-30T10:00:00.000Z"),
      },
    ]);
    const liveCounts = vi.fn().mockResolvedValue({ open: 5, unread: 4 });
    const svc = hubCounterSnapshotsService(db as never, { liveCounts });

    await expect(svc.getOrRefresh(ctx)).resolves.toEqual({ open: 3, unread: 2 });
    expect(liveCounts).not.toHaveBeenCalled();
  });

  it("does not return a stale snapshot when invalidated after compute", async () => {
    const { db } = makeDb([
      {
        openCount: 3,
        unreadCount: 2,
        invalidatedAt: new Date("2026-06-30T10:01:00.000Z"),
        computedAt: new Date("2026-06-30T10:00:00.000Z"),
      },
    ]);
    const liveCounts = vi.fn().mockResolvedValue({ open: 5, unread: 4 });
    const svc = hubCounterSnapshotsService(db as never, { liveCounts });

    await expect(svc.getOrRefresh(ctx)).resolves.toEqual({ open: 5, unread: 4 });
    expect(liveCounts).toHaveBeenCalledWith(ctx);
  });

  it("invalidates one user or every company snapshot without inserting rows", async () => {
    const { db } = makeDb();
    const liveCounts = vi.fn();
    const svc = hubCounterSnapshotsService(db as never, { liveCounts });

    await svc.invalidateUser(ctx.companyId, ctx.userId);
    await svc.invalidateCompany(ctx.companyId);

    expect(db.update).toHaveBeenCalledTimes(2);
    expect(db.insert).not.toHaveBeenCalled();
  });
});
