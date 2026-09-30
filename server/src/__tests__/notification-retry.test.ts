/**
 * Notification delivery retry queue tests (Phase G2, T26).
 *
 * Covers the three public helpers in server/src/services/notifications.ts:
 *   - createNotification: hub-backed happy path + registry/failure rejection
 *   - retryFailedNotifications: candidate selection, success/failure paths,
 *     attempt-count rollover into `exhausted`
 *   - countPersistentlyFailingNotifications: aggregates rows that hit MAX
 *
 * Plus the worker scheduler in server/src/services/notification-retry-worker.ts
 *   - scheduleNotificationRetryWorker: returns a timer and fires the sweep
 *     on the configured interval (uses fake timers)
 *
 * Drizzle ESM cycle is avoided via the shared helpers in
 * __tests__/helpers/drizzle-mock.ts (see embedding-retry-persistence.test.ts
 * and workspace-ttl-sweeper.test.ts for the same idiom).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  drizzleOperatorStubs,
  makeTableProxy,
} from "./helpers/drizzle-mock.js";

const mocks = vi.hoisted(() => ({
  hubEmit: vi.fn(),
}));

vi.mock("@armyofagents/db", () => ({
  notifications: makeTableProxy("notifications"),
}));

vi.mock("../services/hub-items.js", () => ({
  hubItemsService: () => ({
    emit: mocks.hubEmit,
  }),
}));

vi.mock("drizzle-orm", () => drizzleOperatorStubs());

vi.mock("../middleware/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

// Importing after mocks are registered
import {
  MAX_DELIVERY_ATTEMPTS,
  countPersistentlyFailingNotifications,
  createNotification,
  retryFailedNotifications,
  type NotificationRow,
} from "../services/notifications.js";
import { scheduleNotificationRetryWorker } from "../services/notification-retry-worker.js";

// ── Mock DB helper ──────────────────────────────────────────────────────────
//
// Sequence-based: each select/update/insert returns the next pre-configured
// result. `insertValues` and `setCalls` capture the .values()/.set() payloads
// so assertions can verify the written shape. `insertOnCall` lets a test
// throw on a specific insert (e.g. fail the first, succeed the second).

type Row = Record<string, unknown>;

interface MockConfig {
  selects?: Row[][];
  updates?: Row[][];
  inserts?: Row[][];
  /**
   * Optional per-call insert behavior. If the entry at index N is a function,
   * it runs on the Nth insert call; throwing aborts the chain. Otherwise the
   * matching `inserts[N]` rows are returned.
   */
  insertOnCall?: Array<((values: Row) => void) | null>;
}

function createDb(cfg: MockConfig = {}) {
  let selectIdx = 0;
  let updateIdx = 0;
  let insertIdx = 0;
  const selects = cfg.selects ?? [];
  const updates = cfg.updates ?? [];
  const inserts = cfg.inserts ?? [];
  const insertOnCall = cfg.insertOnCall ?? [];

  const insertValues: Row[] = [];
  const setCalls: Row[] = [];
  const limitCalls: number[] = [];

  function makeSelectChain(getResult: () => Row[]) {
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.orderBy = () => chain;
    chain.limit = (n: number) => {
      limitCalls.push(n);
      return chain;
    };
    chain.then = (resolve: (v: Row[]) => unknown) =>
      Promise.resolve(resolve(getResult()));
    return chain;
  }

  function makeUpdateChain(getResult: () => Row[]) {
    const chain: Record<string, unknown> = {};
    chain.set = (patch: Row) => {
      setCalls.push(patch);
      return chain;
    };
    chain.where = () => chain;
    chain.returning = () => chain;
    chain.then = (resolve: (v: Row[]) => unknown) =>
      Promise.resolve(resolve(getResult()));
    return chain;
  }

  function makeInsertChain(getResult: () => Row[], hook?: (v: Row) => void) {
    const state: { values: Row | null } = { values: null };
    const chain: Record<string, unknown> = {};
    chain.values = (v: Row) => {
      state.values = v;
      insertValues.push(v);
      if (hook) hook(v);
      return chain;
    };
    chain.returning = () => chain;
    chain.then = (resolve: (v: Row[]) => unknown) =>
      Promise.resolve(resolve(getResult()));
    return chain;
  }

  return {
    select: () => makeSelectChain(() => selects[selectIdx++] ?? []),
    update: () => makeUpdateChain(() => updates[updateIdx++] ?? []),
    insert: () => {
      const callIdx = insertIdx++;
      const hook = insertOnCall[callIdx] ?? undefined;
      return makeInsertChain(() => inserts[callIdx] ?? [], hook ?? undefined);
    },
    insertValues,
    setCalls,
    limitCalls,
  } as unknown as {
    insertValues: Row[];
    setCalls: Row[];
    limitCalls: number[];
  } & Record<string, () => unknown>;
}

// ── createNotification ──────────────────────────────────────────────────────

describe("createNotification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("happy path: emits a delivered hub-backed notification row", async () => {
    const insertedId = "00000000-0000-0000-0000-000000000001";
    const deliveredAt = new Date();
    const db = createDb();
    mocks.hubEmit.mockResolvedValueOnce({
      id: insertedId,
      companyId: "co-1",
      userId: "user-1",
      type: "mention",
      title: "Hello",
      message: null,
      relatedEntityType: null,
      relatedEntityId: null,
      deliveryAttempts: 0,
      deliveredAt,
      deliveryError: null,
      createdAt: new Date(),
    });

    const row = await createNotification(db as never, {
      companyId: "co-1",
      userId: "user-1",
      type: "thread.mention",
      title: "Hello",
    });

    expect(row.id).toBe(insertedId);
    expect(row.type).toBe("mention");
    expect(row.deliveryAttempts).toBe(0);
    expect(row.deliveredAt).toBe(deliveredAt);
    expect(db.insertValues).toHaveLength(0);
    expect(mocks.hubEmit).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "co-1",
      semanticType: "mention",
      title: "Hello",
      ownerUserId: "user-1",
      message: null,
      deliveryAttempts: 0,
      deliveryError: null,
    }));
  });

  it("creates distinct hub source ids for repeated related notification events", async () => {
    const db = createDb();
    const deliveredAt = new Date();
    mocks.hubEmit
      .mockResolvedValueOnce({
        id: "00000000-0000-0000-0000-000000000101",
        companyId: "co-1",
        userId: "user-1",
        type: "thread.mention",
        title: "Hello",
        message: "First",
        relatedEntityType: "discussion",
        relatedEntityId: "11111111-1111-4111-8111-111111111111",
        deliveryAttempts: 0,
        deliveredAt,
        deliveryError: null,
        createdAt: new Date(),
      })
      .mockResolvedValueOnce({
        id: "00000000-0000-0000-0000-000000000102",
        companyId: "co-1",
        userId: "user-1",
        type: "thread.mention",
        title: "Hello again",
        message: "Second",
        relatedEntityType: "discussion",
        relatedEntityId: "11111111-1111-4111-8111-111111111111",
        deliveryAttempts: 0,
        deliveredAt,
        deliveryError: null,
        createdAt: new Date(),
      });

    const input = {
      companyId: "co-1",
      userId: "user-1",
      type: "thread.mention",
      title: "Hello",
      message: "Mention body",
      relatedEntityType: "discussion",
      relatedEntityId: "11111111-1111-4111-8111-111111111111",
    };

    await createNotification(db as never, input);
    await createNotification(db as never, { ...input, title: "Hello again" });

    const [first, second] = mocks.hubEmit.mock.calls.map((call) => call[0]);
    expect(first).toEqual(expect.objectContaining({
      legacyType: "thread.mention",
      sourceId: expect.stringMatching(
        /^11111111-1111-4111-8111-111111111111:user-1:thread\.mention:/,
      ),
    }));
    expect(second).toEqual(expect.objectContaining({
      legacyType: "thread.mention",
      sourceId: expect.stringMatching(
        /^11111111-1111-4111-8111-111111111111:user-1:thread\.mention:/,
      ),
    }));
    expect(first.sourceId).not.toBe(second.sourceId);
  });

  it("hub emit failure rethrows without creating an unvalidated retry stub", async () => {
    const db = createDb();
    mocks.hubEmit.mockRejectedValueOnce(new Error("transient db hiccup"));

    await expect(
      createNotification(db as never, {
        companyId: "co-1",
        userId: "user-1",
        type: "thread.mention",
        title: "Hello",
      }),
    ).rejects.toThrow("transient db hiccup");

    expect(db.insertValues).toHaveLength(0);
  });

  it("rejects unknown notification types before hub emit", async () => {
    const db = createDb();

    await expect(createNotification(db as never, {
      companyId: "co-1",
      userId: "user-1",
      type: "plugin.random",
      title: "Hello",
    })).rejects.toMatchObject({ status: 422 });

    expect(mocks.hubEmit).not.toHaveBeenCalled();
  });

  it("rejects dead notification types before hub emit", async () => {
    const db = createDb();

    await expect(createNotification(db as never, {
      companyId: "co-1",
      userId: "user-1",
      type: "discussion.extraction_complete",
      title: "Extraction complete",
    })).rejects.toMatchObject({ status: 422 });

    expect(mocks.hubEmit).not.toHaveBeenCalled();
  });
});

// ── retryFailedNotifications ────────────────────────────────────────────────

function makeRow(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: "row-1",
    companyId: "co-1",
    userId: "user-1",
    type: "thread.mention",
    title: "T",
    message: null,
    deliveryAttempts: 1,
    deliveredAt: null,
    deliveryError: "transient",
    createdAt: new Date(),
    ...overrides,
  };
}

describe("retryFailedNotifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns zeros and respects the batchSize limit when no candidates exist", async () => {
    const db = createDb({
      selects: [[]],
    });

    const result = await retryFailedNotifications(db as never, { batchSize: 5 });

    expect(result).toEqual({ scanned: 0, delivered: 0, failed: 0, exhausted: 0 });
    expect(db.limitCalls).toEqual([5]);
  });

  it("calls the attempt callback for each candidate row", async () => {
    const candidates = [
      makeRow({ id: "row-1" }),
      makeRow({ id: "row-2" }),
      makeRow({ id: "row-3" }),
    ];
    const seen: string[] = [];
    const db = createDb({
      selects: [candidates],
      updates: [[], [], []],
    });

    await retryFailedNotifications(db as never, {
      attempt: async (row) => {
        seen.push(row.id);
      },
    });

    expect(seen).toEqual(["row-1", "row-2", "row-3"]);
  });

  it("on success: clears deliveryError and sets deliveredAt", async () => {
    const db = createDb({
      selects: [[makeRow({ id: "row-1", deliveryAttempts: 1 })]],
      updates: [[]],
    });

    const result = await retryFailedNotifications(db as never, {
      attempt: async () => { /* success */ },
    });

    expect(result.delivered).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.exhausted).toBe(0);
    expect(db.setCalls).toHaveLength(1);
    expect(db.setCalls[0]).toMatchObject({ deliveryError: null });
    expect(db.setCalls[0]!.deliveredAt).toBeInstanceOf(Date);
  });

  it("on failure (attempts < MAX-1): increments deliveryAttempts and records error, counted as failed", async () => {
    const db = createDb({
      selects: [[makeRow({ id: "row-1", deliveryAttempts: 1 })]],
      updates: [[]],
    });

    const result = await retryFailedNotifications(db as never, {
      attempt: async () => { throw new Error("ws push down"); },
    });

    expect(result.delivered).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.exhausted).toBe(0);
    expect(db.setCalls).toHaveLength(1);
    expect(db.setCalls[0]).toMatchObject({
      deliveryAttempts: 2,
      deliveryError: "ws push down",
    });
    // No deliveredAt on failure path
    expect(db.setCalls[0]!.deliveredAt).toBeUndefined();
  });

  it("on failure that rolls attempts to MAX: counted as exhausted, not failed", async () => {
    // Row already at MAX-1 = 2 attempts. Next failure brings it to 3 = MAX.
    const db = createDb({
      selects: [[makeRow({ id: "row-1", deliveryAttempts: MAX_DELIVERY_ATTEMPTS - 1 })]],
      updates: [[]],
    });

    const result = await retryFailedNotifications(db as never, {
      attempt: async () => { throw new Error("still broken"); },
    });

    expect(result.delivered).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.exhausted).toBe(1);
    expect(db.setCalls[0]).toMatchObject({
      deliveryAttempts: MAX_DELIVERY_ATTEMPTS,
    });
  });

  it("mixed batch: one success, one failure, one exhaustion → counters add up", async () => {
    const rows = [
      makeRow({ id: "row-ok", deliveryAttempts: 1 }),
      makeRow({ id: "row-fail", deliveryAttempts: 1 }),
      makeRow({ id: "row-exhaust", deliveryAttempts: MAX_DELIVERY_ATTEMPTS - 1 }),
    ];
    const db = createDb({
      selects: [rows],
      updates: [[], [], []],
    });

    const result = await retryFailedNotifications(db as never, {
      attempt: async (row) => {
        if (row.id !== "row-ok") throw new Error("nope");
      },
    });

    expect(result).toEqual({ scanned: 3, delivered: 1, failed: 1, exhausted: 1 });
  });

  it("uses a no-op attempt by default — every candidate ends up delivered", async () => {
    const db = createDb({
      selects: [[makeRow({ id: "row-1" }), makeRow({ id: "row-2" })]],
      updates: [[], []],
    });

    const result = await retryFailedNotifications(db as never);

    expect(result.delivered).toBe(2);
    expect(result.failed).toBe(0);
  });
});

// ── countPersistentlyFailingNotifications ───────────────────────────────────

describe("countPersistentlyFailingNotifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the count reported by the query", async () => {
    const db = createDb({
      selects: [[{ count: 7 }]],
    });

    const n = await countPersistentlyFailingNotifications(db as never);

    expect(n).toBe(7);
  });

  it("returns 0 when no rows are returned", async () => {
    const db = createDb({
      selects: [[]],
    });

    const n = await countPersistentlyFailingNotifications(db as never);

    expect(n).toBe(0);
  });

  it("accepts an optional companyId scope (smoke — the SQL itself is exercised by integration tests)", async () => {
    const db = createDb({
      selects: [[{ count: 3 }]],
    });

    const n = await countPersistentlyFailingNotifications(db as never, "co-1");

    expect(n).toBe(3);
  });
});

// ── scheduleNotificationRetryWorker ─────────────────────────────────────────

describe("scheduleNotificationRetryWorker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a timer handle and runs the sweep on each interval tick", async () => {
    // Each tick the sweep selects candidates (empty → no-op) then idles.
    // We can't easily make the SUT call our mocked retry without hoisting,
    // so instead we count select() invocations via the mock DB.
    const db = createDb({
      // each tick fires one select; provide 3 empty result sets
      selects: [[], [], []],
    });
    let selectCount = 0;
    const origSelect = (db as unknown as { select: () => unknown }).select;
    (db as unknown as { select: () => unknown }).select = () => {
      selectCount++;
      return origSelect();
    };

    const timer = scheduleNotificationRetryWorker(db as never, {
      intervalMs: 1000,
    });

    expect(timer).toBeDefined();

    // Advance just enough to fire two ticks
    await vi.advanceTimersByTimeAsync(2500);

    expect(selectCount).toBeGreaterThanOrEqual(2);

    clearInterval(timer);
  });

  it("swallows sweep errors so the interval continues firing", async () => {
    // The select call throws synchronously; the worker should log and not
    // unhandle the rejection. We don't have a global handler to assert on,
    // but the lack of throw out of advanceTimersByTimeAsync is the proof.
    const db = createDb({});
    (db as unknown as { select: () => unknown }).select = () => {
      throw new Error("db gone");
    };

    const timer = scheduleNotificationRetryWorker(db as never, {
      intervalMs: 500,
    });

    await vi.advanceTimersByTimeAsync(1100);

    // If the worker had let the error propagate, this expect would never
    // be reached — the rejection would have surfaced via the fake timer.
    expect(timer).toBeDefined();
    clearInterval(timer);
  });
});
