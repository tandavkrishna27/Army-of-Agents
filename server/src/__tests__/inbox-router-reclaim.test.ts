import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@armyofagents/db", () => ({
  // Each table proxy reports its own name via __table so the test can assert
  // which table each db.update() targeted (and in what order).
  threadInboxItems: new Proxy({ __table: "threadInboxItems" } as any, { get: (t: any, p) => (p === "__table" ? t.__table : p) }),
  agentWakeupRequests: new Proxy({ __table: "agentWakeupRequests" } as any, { get: (t: any, p) => (p === "__table" ? t.__table : p) }),
}));
vi.mock("drizzle-orm", () => ({
  and: vi.fn((...a: unknown[]) => ({ _op: "and", a })),
  eq: vi.fn((a: unknown, b: unknown) => ({ _op: "eq", a, b })),
  inArray: vi.fn((a: unknown, b: unknown) => ({ _op: "inArray", a, b })),
  isNotNull: vi.fn((a: unknown) => ({ _op: "isNotNull", a })),
  lt: vi.fn((a: unknown, b: unknown) => ({ _op: "lt", a, b })),
}));
vi.mock("../middleware/logger.js", () => ({
  logger: { child: () => ({ debug: vi.fn(), warn: vi.fn() }) },
}));

const mockRouteItem = vi.fn().mockResolvedValue({ action: "human", outcome: "off" });
vi.mock("../services/inbox-router.js", () => ({
  routeInboxItem: (...a: any[]) => mockRouteItem(...a),
}));

import { runInboxSweep } from "../services/internal-agent/aoa-agents/sweep-inbox.js";

// Build a db whose 3 selects return [staleRouting, staleEscalated, pending] in order.
// updateTargets records which table each update() touched, in order, so ordering
// can be asserted (the wakeup cancel must precede the inbox finalize). UPDATE
// supports both awaited form and `.catch()` (the wakeup-cancel uses .catch).
function makeDb(staleRouting: object[], staleEscalated: object[], pending: object[]) {
  const seq = [staleRouting, staleEscalated, pending];
  let call = 0;
  const updateTargets: string[] = [];
  const whereResult = { then: (r: Function) => r([]), catch: () => Promise.resolve([]) };
  const updateSpy = vi.fn().mockImplementation((table: any) => {
    updateTargets.push(table?.__table ?? "unknown");
    return { set: () => ({ where: () => whereResult }) };
  });
  return {
    db: {
      select: () => ({ from: () => ({ where: () => Promise.resolve(seq[call++] ?? []) }) }),
      update: updateSpy,
    } as any,
    updateSpy,
    updateTargets,
  };
}

describe("sweep-inbox reclaim (C4 / Codex P1 #2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-establish the default resolution each test so a persistent
    // mockRejectedValue (set by the all-fail test) can't leak across cases.
    mockRouteItem.mockResolvedValue({ action: "human", outcome: "off" });
  });

  it("reclaims stale routing → pending_route", async () => {
    const { db, updateSpy } = makeDb([{ id: "r-1" }], [], []);
    const result = await runInboxSweep(db);
    expect(result.reclaimed).toBe(1);
    expect(result.finalized).toBe(0);
    expect(updateSpy).toHaveBeenCalledTimes(1); // only the routing reclaim
  });

  it("finalizes stale escalated → routed+human, cancelling the wakeup FIRST", async () => {
    const { db, updateTargets } = makeDb(
      [],
      [{ id: "e-1", navigatorWakeupId: "w-1" }, { id: "e-2", navigatorWakeupId: null }],
      [],
    );
    const result = await runInboxSweep(db);
    expect(result.reclaimed).toBe(0);
    expect(result.finalized).toBe(2);
    expect(mockRouteItem).not.toHaveBeenCalled(); // escalated is NOT re-routed
    // Order matters (crash-safety): cancel agentWakeupRequests BEFORE finalizing
    // threadInboxItems. Assert the exact sequence.
    expect(updateTargets).toEqual(["agentWakeupRequests", "threadInboxItems"]);
  });

  it("drains pending_route via routeInboxItem", async () => {
    const { db } = makeDb([], [], [{ id: "p-1" }, { id: "p-2" }]);
    const result = await runInboxSweep(db);
    expect(result.swept).toBe(2);
    expect(mockRouteItem).toHaveBeenCalledTimes(2);
  });

  it("continues + counts after a routeInboxItem failure (error containment)", async () => {
    // One item's routeInboxItem rejects; the sweep must catch it, keep going,
    // and still count both attempts (swept++ is unconditional). No throw.
    mockRouteItem.mockRejectedValueOnce(new Error("boom"));
    const { db } = makeDb([], [], [{ id: "p-1" }, { id: "p-2" }]);
    const result = await runInboxSweep(db);
    expect(result.swept).toBe(2);
    expect(mockRouteItem).toHaveBeenCalledTimes(2);
  });

  it("does not throw when every routeInboxItem rejects", async () => {
    mockRouteItem.mockRejectedValue(new Error("all fail"));
    const { db } = makeDb([], [], [{ id: "p-1" }, { id: "p-2" }]);
    await expect(runInboxSweep(db)).resolves.toMatchObject({ swept: 2 });
  });

  it("no stale, no pending → all zero", async () => {
    const { db } = makeDb([], [], []);
    const result = await runInboxSweep(db);
    expect(result).toEqual({ swept: 0, reclaimed: 0, finalized: 0 });
  });
});
