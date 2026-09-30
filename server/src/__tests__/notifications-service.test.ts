import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hubEmit: vi.fn(),
  hubApplyPersonalState: vi.fn(),
}));

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: any[]) => args),
  eq: vi.fn((a: any, b: any) => ({ eq: [a, b] })),
  desc: vi.fn((col: any) => ({ desc: col })),
  isNull: vi.fn((col: any) => ({ isNull: col })),
  sql: vi.fn((strings: any, ...values: any[]) => ({
    sql: true,
    strings,
    values,
  })),
}));

vi.mock("@armyofagents/db", () => ({
  notifications: {
    id: "notifications_id",
    companyId: "notifications_company_id",
    userId: "notifications_user_id",
    type: "notifications_type",
    title: "notifications_title",
    message: "notifications_message",
    relatedEntityType: "notifications_related_entity_type",
    relatedEntityId: "notifications_related_entity_id",
    readAt: "notifications_read_at",
    dismissedAt: "notifications_dismissed_at",
    createdAt: "notifications_created_at",
  },
}));

vi.mock("../services/hub-items.js", () => ({
  hubItemsService: () => ({
    emit: mocks.hubEmit,
    applyPersonalState: mocks.hubApplyPersonalState,
  }),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

let callIndex = 0;
let mockResults: any[] = [];

function createChainDb() {
  const chain: any = {};
  const methods = [
    "select",
    "insert",
    "update",
    "delete",
    "from",
    "where",
    "values",
    "set",
    "orderBy",
    "returning",
    "then",
  ];
  for (const method of methods) {
    chain[method] = vi.fn((...args: any[]) => {
      if (method === "then") {
        // Resolve the promise-like
        const result = mockResults[callIndex] ?? [];
        callIndex++;
        return Promise.resolve(args[0](result));
      }
      return chain;
    });
  }
  // Override terminal methods
  chain.returning = vi.fn(() => {
    const result = mockResults[callIndex] ?? [];
    callIndex++;
    return Promise.resolve(result);
  });
  // select().from().where().orderBy() should resolve to array
  chain.orderBy = vi.fn(() => {
    const result = mockResults[callIndex] ?? [];
    callIndex++;
    return Promise.resolve(result);
  });
  return chain;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("notificationService", () => {
  let db: any;

  beforeEach(() => {
    callIndex = 0;
    mockResults = [];
    vi.clearAllMocks();
    db = createChainDb();
  });

  it("create() routes known persistent notification types through hub emit", async () => {
    const { notificationService } = await import(
      "../services/notifications.js"
    );

    const mockNotification = {
      id: "hub-row-1",
      companyId: "co-1",
      userId: "user-1",
      type: "mention",
      title: "Mentioned",
      message: "You were mentioned",
      relatedEntityType: "discussion",
      relatedEntityId: "11111111-1111-4111-8111-111111111111",
      deliveryAttempts: 0,
      deliveredAt: new Date(),
      deliveryError: null,
      readAt: null,
      dismissedAt: null,
      createdAt: new Date(),
    };

    mocks.hubEmit.mockResolvedValueOnce(mockNotification);

    const svc = notificationService(db);
    const result = await svc.create("co-1", {
      userId: "user-1",
      type: "thread.mention",
      title: "Mentioned",
      message: "You were mentioned",
      relatedEntityType: "discussion",
      relatedEntityId: "11111111-1111-4111-8111-111111111111",
    });

    expect(result).toEqual(mockNotification);
    expect(mocks.hubEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "co-1",
        semanticType: "mention",
        sourceType: "discussion",
        title: "Mentioned",
        summary: "You were mentioned",
        message: "You were mentioned",
        ownerUserId: "user-1",
        relatedEntityType: "discussion",
        relatedEntityId: "11111111-1111-4111-8111-111111111111",
      }),
    );
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("create() rejects dead persistent notification types", async () => {
    const { notificationService } = await import(
      "../services/notifications.js"
    );

    const svc = notificationService(db);
    await expect(svc.create("co-1", {
      userId: "user-1",
      type: "discussion.extraction_complete",
      title: "Extraction complete",
    })).rejects.toMatchObject({ status: 422 });
    expect(mocks.hubEmit).not.toHaveBeenCalled();
  });

  it("list() returns notifications ordered by createdAt desc", async () => {
    const { notificationService } = await import(
      "../services/notifications.js"
    );

    const mockNotifications = [
      { id: "notif-2", title: "Second", createdAt: new Date("2026-03-20") },
      { id: "notif-1", title: "First", createdAt: new Date("2026-03-19") },
    ];

    mockResults = [mockNotifications]; // orderBy()

    const svc = notificationService(db);
    const result = await svc.list("co-1", "user-1");

    expect(result).toEqual(mockNotifications);
    expect(db.select).toHaveBeenCalled();
    expect(db.from).toHaveBeenCalled();
    expect(db.where).toHaveBeenCalled();
    expect(db.orderBy).toHaveBeenCalled();
  });

  it("list() with unreadOnly filters by readAt is null", async () => {
    const { notificationService } = await import(
      "../services/notifications.js"
    );

    const { isNull } = await import("drizzle-orm");
    const mockNotifications = [
      { id: "notif-1", readAt: null },
    ];

    mockResults = [mockNotifications];

    const svc = notificationService(db);
    const result = await svc.list("co-1", "user-1", { unreadOnly: true });

    expect(result).toEqual(mockNotifications);
    // isNull should be called for both dismissedAt and readAt
    expect(isNull).toHaveBeenCalled();
  });

  it("markRead() updates readAt and returns the notification", async () => {
    const { notificationService } = await import(
      "../services/notifications.js"
    );

    const mockUpdated = {
      id: "notif-1",
      readAt: new Date(),
    };

    mockResults = [[mockUpdated]]; // returning()

    const svc = notificationService(db);
    const result = await svc.markRead("co-1", "user-1", "notif-1");

    expect(result).toEqual(mockUpdated);
    expect(db.update).toHaveBeenCalled();
    expect(db.set).toHaveBeenCalled();
    expect(db.returning).toHaveBeenCalled();
    expect(mocks.hubApplyPersonalState).toHaveBeenCalledWith({
      companyId: "co-1",
      hubItemId: "notif-1",
      actorUserId: "user-1",
      state: { kind: "read" },
    });
  });

  it("markRead() throws 404 when notification not found", async () => {
    const { notificationService } = await import(
      "../services/notifications.js"
    );

    mockResults = [[]]; // returning() empty

    const svc = notificationService(db);
    await expect(svc.markRead("co-1", "user-1", "nonexistent")).rejects.toThrow(
      "Notification not found",
    );
  });

  it("dismiss() sets dismissedAt and returns the notification", async () => {
    const { notificationService } = await import(
      "../services/notifications.js"
    );

    const mockUpdated = {
      id: "notif-1",
      dismissedAt: new Date(),
    };

    mockResults = [[mockUpdated]]; // returning()

    const svc = notificationService(db);
    const result = await svc.dismiss("co-1", "user-1", "notif-1");

    expect(result).toEqual(mockUpdated);
    expect(db.update).toHaveBeenCalled();
    expect(mocks.hubApplyPersonalState).toHaveBeenCalledWith({
      companyId: "co-1",
      hubItemId: "notif-1",
      actorUserId: "user-1",
      state: { kind: "dismiss" },
    });
  });

  it("dismiss() throws 404 when notification not found", async () => {
    const { notificationService } = await import(
      "../services/notifications.js"
    );

    mockResults = [[]]; // returning() empty

    const svc = notificationService(db);
    await expect(svc.dismiss("co-1", "user-1", "nonexistent")).rejects.toThrow(
      "Notification not found",
    );
  });

  it("getUnreadCount() returns count of unread, non-dismissed notifications", async () => {
    const { notificationService } = await import(
      "../services/notifications.js"
    );

    // The select chain for count resolves via orderBy mock (last chain method before promise)
    // But getUnreadCount uses select().from().where() which doesn't call orderBy.
    // We need to handle the where() terminal case.
    // Override: the chain resolves when the last chained method is called.
    // For getUnreadCount the chain is: select().from().where() → Promise
    db.where = vi.fn(() => {
      const result = mockResults[callIndex] ?? [];
      callIndex++;
      return Promise.resolve(result);
    });

    mockResults = [[{ count: 5 }]];

    const svc = notificationService(db);
    const count = await svc.getUnreadCount("co-1", "user-1");

    expect(count).toBe(5);
  });

  it("getUnreadCount() returns 0 when no unread notifications", async () => {
    const { notificationService } = await import(
      "../services/notifications.js"
    );

    db.where = vi.fn(() => {
      const result = mockResults[callIndex] ?? [];
      callIndex++;
      return Promise.resolve(result);
    });

    mockResults = [[{ count: 0 }]];

    const svc = notificationService(db);
    const count = await svc.getUnreadCount("co-1", "user-1");

    expect(count).toBe(0);
  });
});
