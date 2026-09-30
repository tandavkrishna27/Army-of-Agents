import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_NOTIFICATION_PREFERENCES } from "@armyofagents/shared";
import { errorHandler } from "../middleware/index.js";
import { notificationPreferenceRoutes } from "../routes/notification-preferences.js";
import { notificationDigestService } from "../services/notification-digest.js";

const publishLiveEvent = vi.hoisted(() => vi.fn());
const mockHubItems = vi.hoisted(() => ({
  getVisible: vi.fn(),
}));

const mockPreferences = vi.hoisted(() => ({
  get: vi.fn(),
  upsert: vi.fn(),
  reset: vi.fn(),
}));

const mockDigest = vi.hoisted(() => ({
  listForUser: vi.fn(),
  ackForUser: vi.fn(),
}));

const mockPerms = vi.hoisted(() => ({
  getEffectiveRole: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../services/index.js", () => ({
  notificationPreferencesService: () => mockPreferences,
  notificationDigestService: () => mockDigest,
  permissionService: () => mockPerms,
  logActivity: mockLogActivity,
}));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent,
}));

vi.mock("../services/hub-items.js", () => ({
  hubItemsService: () => mockHubItems,
}));

const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const COMPANY_B = "55555555-5555-5555-5555-555555555555";
const OTHER_USER_ID = "other-user";

function boardActor(
  overrides: Partial<{
    userId: string;
    companyIds: string[];
    isInstanceAdmin: boolean;
    source: string;
  }> = {},
) {
  return {
    type: "board" as const,
    userId: overrides.userId ?? "user-1",
    source: overrides.source ?? "session",
    companyIds: overrides.companyIds ?? [COMPANY_A],
    isInstanceAdmin: overrides.isInstanceAdmin ?? false,
  };
}

function createApp(actor: unknown = boardActor()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", notificationPreferenceRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe("notification digest routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPreferences.get.mockResolvedValue(DEFAULT_NOTIFICATION_PREFERENCES);
    mockPreferences.upsert.mockResolvedValue(DEFAULT_NOTIFICATION_PREFERENCES);
    mockPreferences.reset.mockResolvedValue(DEFAULT_NOTIFICATION_PREFERENCES);
    mockPerms.getEffectiveRole.mockResolvedValue("team_member");
    mockDigest.listForUser.mockResolvedValue({
      items: [
        {
          id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          title: "Visible digest item",
          ownerUserId: "user-1",
        },
      ],
    });
    mockDigest.ackForUser.mockResolvedValue({ acked: 1 });
  });

  it("lists only pending digest rows visible to the current user", async () => {
    const app = createApp();

    const res = await request(app).get(
      `/api/companies/${COMPANY_A}/notifications/digest/me`,
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(mockDigest.listForUser).toHaveBeenCalledWith({
      companyId: COMPANY_A,
      userId: "user-1",
      role: "team_member",
    });
  });

  it("does not return digest rows for hub items hidden by hub RBAC", async () => {
    const app = createApp();

    const res = await request(app).get(
      `/api/companies/${COMPANY_A}/notifications/digest/me`,
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(
      res.body.items.every(
        (item: { ownerUserId: string | null }) => item.ownerUserId !== OTHER_USER_ID,
      ),
    ).toBe(true);
  });

  it("ack marks current user's pending digest rows as acknowledged", async () => {
    const app = createApp();

    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/notifications/digest/me/ack`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.acked).toEqual(expect.any(Number));
    expect(mockDigest.ackForUser).toHaveBeenCalledWith({
      companyId: COMPANY_A,
      userId: "user-1",
    });
  });

  it("ack logs an activity row", async () => {
    const app = createApp();

    await request(app)
      .post(`/api/companies/${COMPANY_A}/notifications/digest/me/ack`)
      .send({})
      .expect(200);

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: COMPANY_A,
        action: "notification_digest.acked",
        actorType: "user",
        actorId: "user-1",
      }),
    );
  });

  it("forbids digest access outside the current board actor companies", async () => {
    const app = createApp(boardActor({ companyIds: [COMPANY_B] }));

    const res = await request(app).get(
      `/api/companies/${COMPANY_A}/notifications/digest/me`,
    );

    expect(res.status).toBe(403);
    expect(mockDigest.listForUser).not.toHaveBeenCalled();
  });
});

function digestDb({
  pendingRows = [],
  insertReturning = [{ id: "digest-1" }],
  updateReturning = [{ id: "digest-1" }],
}: {
  pendingRows?: { hubItemId: string }[];
  insertReturning?: { id: string }[];
  updateReturning?: { id: string }[];
} = {}) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(pendingRows),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue(insertReturning),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue(updateReturning),
        })),
      })),
    })),
  } as never;
}

describe("notificationDigestService", () => {
  beforeEach(() => {
    publishLiveEvent.mockClear();
    mockHubItems.getVisible.mockReset();
  });

  it("reports whether queueForUser created a pending digest row", async () => {
    const created = await notificationDigestService(digestDb()).queueForUser({
      companyId: COMPANY_A,
      userId: "user-1",
      hubItemId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      semanticType: "reminder",
    });
    const duplicate = await notificationDigestService(
      digestDb({ insertReturning: [] }),
    ).queueForUser({
      companyId: COMPANY_A,
      userId: "user-1",
      hubItemId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      semanticType: "reminder",
    });

    expect(created).toEqual({ queued: true });
    expect(duplicate).toEqual({ queued: false });
  });

  it("publishes digest changed only when queue or ack changes rows", async () => {
    await notificationDigestService(digestDb()).queueForUser({
      companyId: COMPANY_A,
      userId: "user-1",
      hubItemId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      semanticType: "reminder",
    });
    await notificationDigestService(digestDb({ insertReturning: [] })).queueForUser({
      companyId: COMPANY_A,
      userId: "user-1",
      hubItemId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      semanticType: "reminder",
    });
    await notificationDigestService(digestDb()).ackForUser({
      companyId: COMPANY_A,
      userId: "user-1",
    });
    await notificationDigestService(digestDb({ updateReturning: [] })).ackForUser({
      companyId: COMPANY_A,
      userId: "user-1",
    });

    expect(publishLiveEvent).toHaveBeenCalledTimes(2);
    expect(publishLiveEvent).toHaveBeenCalledWith({
      companyId: COMPANY_A,
      type: "hub.digest.changed",
      payload: { reason: "queued" },
    });
    expect(publishLiveEvent).toHaveBeenCalledWith({
      companyId: COMPANY_A,
      type: "hub.digest.changed",
      payload: { reason: "acked" },
    });
  });

  it("hydrates each pending digest item directly instead of filtering a generic first page", async () => {
    mockHubItems.getVisible
      .mockResolvedValueOnce({
        id: "older-visible",
        lane: "notifications",
        title: "Older visible digest row",
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "newer-visible",
        lane: "waiting",
        title: "Newer visible digest row",
      });

    const result = await notificationDigestService(
      digestDb({
        pendingRows: [
          { hubItemId: "older-visible" },
          { hubItemId: "hidden-row" },
          { hubItemId: "newer-visible" },
        ],
      }),
    ).listForUser({
      companyId: COMPANY_A,
      userId: "user-1",
      role: "founder",
    });

    expect(mockHubItems.getVisible).toHaveBeenCalledTimes(3);
    expect(mockHubItems.getVisible).toHaveBeenNthCalledWith(1, COMPANY_A, {
      hubItemId: "older-visible",
      actorUserId: "user-1",
      role: "founder",
      status: "open",
    });
    expect(result.items.map((item) => item.id)).toEqual([
      "older-visible",
      "newer-visible",
    ]);
  });
});
