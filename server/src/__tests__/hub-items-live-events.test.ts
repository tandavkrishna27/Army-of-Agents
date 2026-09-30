import { beforeEach, describe, expect, it, vi } from "vitest";
import { hubItemsService } from "../services/hub-items.js";
import { publishLiveEvent } from "../services/live-events.js";

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));

const invalidateCompany = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../services/hub-counter-snapshots.js", () => ({
  hubCounterSnapshotsService: () => ({
    invalidateCompany,
    invalidateUser: vi.fn().mockResolvedValue(undefined),
  }),
}));

const COMPANY_ID = "11111111-1111-1111-1111-111111111111";
const ITEM_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_ID = "user-1";

function makeDbReturning(row: Record<string, unknown>) {
  const returning = vi.fn().mockResolvedValue([row]);
  const onConflictDoUpdate = vi.fn(() => ({ returning }));
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  const insert = vi.fn(() => ({ values }));
  const where = vi.fn().mockResolvedValue([]);
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { insert, values, onConflictDoUpdate, returning, select, from, where };
}

/**
 * DB mock for the NO-OP emit path: the gated upsert matches an existing row but
 * the change-detection setWhere is false → RETURNING is empty; emit() re-selects
 * the current row (`select().from().where().limit(1)`).
 */
function makeDbNoopUpsert(existingRow: Record<string, unknown>) {
  const returning = vi.fn().mockResolvedValue([]);
  const onConflictDoUpdate = vi.fn(() => ({ returning }));
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  const insert = vi.fn(() => ({ values }));
  const limit = vi.fn().mockResolvedValue([existingRow]);
  // `where` must serve both the digest-path awaits (plain resolve) and the
  // re-select (`.limit(1)`), so return a promise carrying a `.limit` method.
  const where = vi.fn(() => Object.assign(Promise.resolve([]), { limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { insert, values, onConflictDoUpdate, returning, select, from, where, limit };
}

function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM_ID,
    companyId: COMPANY_ID,
    userId: USER_ID,
    ownerUserId: USER_ID,
    semanticType: "approval_request",
    sourceType: "approval",
    sourceId: "approval-1",
    status: "open",
    version: 0,
    title: "Approve hire",
    summary: "rich summary",
    message: "rich summary",
    relatedEntityId: "related-1",
    createdAt: new Date("2026-06-30T00:00:00.000Z"),
    ...overrides,
  };
}

describe("hubItems live events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("publishes a metadata-only item change and count change after emit", async () => {
    const db = makeDbReturning(itemRow());

    await hubItemsService(db as never).emit({
      companyId: COMPANY_ID,
      semanticType: "approval_request",
      sourceType: "approval",
      sourceId: "approval-1",
      title: "Approve hire",
      summary: "rich summary",
      ownerUserId: USER_ID,
      relatedEntityId: "related-1",
    });

    expect(publishLiveEvent).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      type: "hub.item.changed",
      payload: {
        itemId: ITEM_ID,
        semanticType: "approval_request",
        lane: "waiting_on_you",
        status: "open",
        version: 0,
        change: "created",
      },
    });
    expect(publishLiveEvent).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      type: "hub.counts.changed",
      payload: { reason: "item_changed" },
    });

    const itemEvent = vi.mocked(publishLiveEvent).mock.calls.find(
      ([event]) => event.type === "hub.item.changed",
    )?.[0];
    expect(itemEvent?.payload).not.toHaveProperty("title");
    expect(itemEvent?.payload).not.toHaveProperty("summary");
    expect(itemEvent?.payload).not.toHaveProperty("message");
    expect(itemEvent?.payload).not.toHaveProperty("relatedEntityId");
    expect(itemEvent?.payload).not.toHaveProperty("sourceId");
  });

  it("does NOT publish or invalidate counters when a re-emit changes nothing (storm guard)", async () => {
    // The upsert's change-detection setWhere skipped the UPDATE (identical
    // content) → RETURNING empty → emit() re-selects the row and must treat it
    // as a no-op: no live events, no counter-snapshot invalidation. This is the
    // guard that breaks the [GET /sidebar-badges scan → hub.item.changed →
    // client refetches badges → scan …] feedback storm.
    const db = makeDbNoopUpsert(itemRow());

    const result = await hubItemsService(db as never).emit({
      companyId: COMPANY_ID,
      semanticType: "approval_request",
      sourceType: "approval",
      sourceId: "approval-1",
      title: "Approve hire",
      summary: "rich summary",
      ownerUserId: USER_ID,
      relatedEntityId: "related-1",
    });

    // Caller still gets the current row back.
    expect(result.id).toBe(ITEM_ID);
    expect(result.lane).toBe("waiting_on_you");
    // But nothing was broadcast and no counters were touched.
    expect(publishLiveEvent).not.toHaveBeenCalled();
    expect(invalidateCompany).not.toHaveBeenCalled();
  });

  it("still invalidates counters and publishes when the upsert actually changed the row", async () => {
    const db = makeDbReturning(itemRow());

    await hubItemsService(db as never).emit({
      companyId: COMPANY_ID,
      semanticType: "approval_request",
      sourceType: "approval",
      sourceId: "approval-1",
      title: "Approve hire",
      summary: "rich summary",
      ownerUserId: USER_ID,
      relatedEntityId: "related-1",
    });

    expect(invalidateCompany).toHaveBeenCalledWith(COMPANY_ID);
    expect(publishLiveEvent).toHaveBeenCalled();
  });

  it("does not publish from transaction executor-backed emit calls", async () => {
    const outerDb = makeDbReturning(itemRow({ id: "outer" }));
    const executor = makeDbReturning(itemRow({ id: ITEM_ID }));

    await hubItemsService(outerDb as never).emit({
      companyId: COMPANY_ID,
      semanticType: "approval_request",
      sourceType: "approval",
      sourceId: "approval-1",
      title: "Approve hire",
      ownerUserId: USER_ID,
      executor: executor as never,
    });

    expect(publishLiveEvent).not.toHaveBeenCalled();
  });
});
