import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { sidebarBadgeRoutes } from "../routes/sidebar-badges.js";

const mocks = vi.hoisted(() => ({
  access: {
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  },
  badgeService: {
    get: vi.fn(),
  },
  counterSnapshots: {
    getOrRefresh: vi.fn(),
  },
  dashboard: {
    summary: vi.fn(),
  },
  emitOpenApprovalHubItems: vi.fn(),
  emitLegacyAlertHubItems: vi.fn(),
  emitStaleWorkHubItems: vi.fn(),
  issueService: {
    staleCount: vi.fn(),
  },
  hubItems: {
    counts: vi.fn(),
    reconcile: vi.fn().mockResolvedValue({ healed: 0, closed: 0, refreshed: 0 }),
  },
  permissions: {
    getEffectiveRole: vi.fn(),
  },
}));

vi.mock("../services/access.js", () => ({
  accessService: () => mocks.access,
}));

vi.mock("../services/dashboard.js", () => ({
  dashboardService: () => mocks.dashboard,
}));

vi.mock("../services/hub-approval-requests.js", () => ({
  emitOpenApprovalHubItems: mocks.emitOpenApprovalHubItems,
}));

vi.mock("../services/hub-legacy-alerts.js", () => ({
  emitLegacyAlertHubItems: mocks.emitLegacyAlertHubItems,
}));

vi.mock("../services/hub-stale-work.js", () => ({
  emitStaleWorkHubItems: mocks.emitStaleWorkHubItems,
}));

vi.mock("../services/index.js", () => ({
  hubCounterSnapshotsService: () => mocks.counterSnapshots,
  hubItemsService: () => mocks.hubItems,
  permissionService: () => mocks.permissions,
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => mocks.issueService,
}));

vi.mock("../services/sidebar-badges.js", () => ({
  sidebarBadgeService: () => mocks.badgeService,
}));

function makeDb() {
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => Promise.resolve([{ count: 0 }])),
  };
  return {
    select: vi.fn(() => chain),
  };
}

function makeApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", sidebarBadgeRoutes(makeDb() as never));
  app.use(errorHandler);
  return app;
}

describe("sidebar badge routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.access.canUser.mockResolvedValue(false);
    mocks.access.hasPermission.mockResolvedValue(false);
    mocks.badgeService.get.mockResolvedValue({
      inbox: 99,
      approvals: 2,
      failedRuns: 3,
      joinRequests: 0,
      pendingDiscussions: 4,
    });
    mocks.counterSnapshots.getOrRefresh.mockResolvedValue({ open: 7, unread: 5 });
    mocks.dashboard.summary.mockResolvedValue({
      agents: { error: 0 },
      costs: { monthBudgetCents: 0, monthUtilizationPercent: 0 },
    });
    mocks.emitOpenApprovalHubItems.mockResolvedValue([]);
    mocks.emitLegacyAlertHubItems.mockResolvedValue([]);
    mocks.emitStaleWorkHubItems.mockResolvedValue([]);
    mocks.issueService.staleCount.mockResolvedValue(5);
    mocks.hubItems.counts.mockResolvedValue({ open: 7, unread: 5 });
    mocks.permissions.getEffectiveRole.mockResolvedValue("team_member");
  });

  it("uses RBAC-scoped hub counts for local board actors", async () => {
    const res = await request(
      makeApp({
        type: "board",
        source: "local_implicit",
        userId: "user-1",
        companyIds: [],
      }),
    ).get("/api/companies/co-1/sidebar-badges");

    expect(res.status).toBe(200);
    expect(res.body.inbox).toBe(7);
    expect(mocks.emitOpenApprovalHubItems).toHaveBeenCalledWith(expect.anything(), "co-1");
    expect(mocks.emitLegacyAlertHubItems).toHaveBeenCalledWith(expect.anything(), "co-1");
    expect(mocks.emitStaleWorkHubItems).toHaveBeenCalledWith(expect.anything(), "co-1", null);
    expect(mocks.hubItems.reconcile).toHaveBeenCalledWith("co-1", { sourceType: "company_budget" });
    expect(mocks.hubItems.reconcile).toHaveBeenCalledWith("co-1", { sourceType: "heartbeat_run" });
    expect(mocks.hubItems.reconcile.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.counterSnapshots.getOrRefresh.mock.invocationCallOrder[0],
    );
    expect(mocks.counterSnapshots.getOrRefresh).toHaveBeenCalledWith({
      companyId: "co-1",
      userId: "user-1",
      role: "founder",
    });
    expect(mocks.permissions.getEffectiveRole).not.toHaveBeenCalled();
  });

  it("uses effective role when authenticated board actors need scoped hub counts", async () => {
    const res = await request(
      makeApp({
        type: "board",
        source: "authenticated",
        userId: "user-2",
        companyIds: ["co-1"],
      }),
    ).get("/api/companies/co-1/sidebar-badges");

    expect(res.status).toBe(200);
    expect(res.body.inbox).toBe(7);
    expect(mocks.permissions.getEffectiveRole).toHaveBeenCalledWith("co-1", "user-2");
    expect(mocks.counterSnapshots.getOrRefresh).toHaveBeenCalledWith({
      companyId: "co-1",
      userId: "user-2",
      role: "team_member",
    });
  });

  it("does not write hub counter snapshots for non-board actors", async () => {
    const res = await request(
      makeApp({
        type: "agent",
        companyId: "co-1",
        agentId: "agent-1",
      }),
    ).get("/api/companies/co-1/sidebar-badges");

    expect(res.status).toBe(200);
    expect(res.body.inbox).toBe(12);
    expect(mocks.counterSnapshots.getOrRefresh).not.toHaveBeenCalled();
    expect(mocks.emitOpenApprovalHubItems).not.toHaveBeenCalled();
    expect(mocks.emitLegacyAlertHubItems).not.toHaveBeenCalled();
    expect(mocks.emitStaleWorkHubItems).not.toHaveBeenCalled();
  });
});
