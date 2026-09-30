/**
 * cockpit route tests — Phase 3b.
 *
 * Board-only guard (Codex #1):
 *   - board actor → 200, svc.get called with board userId.
 *   - agent actor → 403, svc.get NOT called.
 *   - mcp actor  → 403, svc.get NOT called.
 *   - no actor   → 401, svc.get NOT called.
 *
 * assertCompanyAccess enforced:
 *   - board actor for a different company → 403.
 */

import express from "express";
import request from "supertest";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";

// ── Mock cockpitService ───────────────────────────────────────────────────────

const { mockGet, mockListTasks, mockGetCounts } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockListTasks: vi.fn(),
  mockGetCounts: vi.fn(),
}));

vi.mock("../services/cockpit.js", () => ({
  cockpitService: () => ({
    get: mockGet,
    listTasks: mockListTasks,
    getCounts: mockGetCounts,
  }),
}));

// ── Import route under test (after mocks are set) ────────────────────────────

const { cockpitRoutes } = await import("../routes/cockpit.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";

const COCKPIT_RESPONSE = {
  running: [],
  review: [],
  myTasks: [],
  today: { reminders: [], dueTasks: [] },
  stickyNotes: [],
  inbox: [],
  discussions: [],
  approvals: [],
  pinned: [],
  goalsAtRisk: [],
  budgetPulse: null,
  doneToday: [],
  proactiveFindings: [],
  teammatesActivity: [],
};

function createApp(
  actorOverride?: Record<string, unknown>,
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // Default: board actor belonging to COMPANY.
    (req as unknown as Record<string, unknown>).actor = actorOverride ?? {
      type: "board",
      userId: "board-user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [COMPANY],
    };
    next();
  });
  app.use("/api", cockpitRoutes({} as import("@armyofagents/db").Db));
  app.use(errorHandler);
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockGet.mockResolvedValue(COCKPIT_RESPONSE);
  mockListTasks.mockResolvedValue({ items: [], total: 0, nextCursor: null });
  mockGetCounts.mockResolvedValue({
    activeWorkMine: 0,
    generatedAt: "2026-07-10T00:00:00.000Z",
  });
});

describe("GET /companies/:cid/cockpit — board-only guard (Codex #1)", () => {
  it("board actor → 200 and svc.get called with board userId", async () => {
    const res = await request(createApp()).get(
      `/api/companies/${COMPANY}/cockpit`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ running: [], review: [], myTasks: [] });
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({ actorId: "board-user-1" }),
    );
  });

  it("agent actor → 403 and svc.get NOT called", async () => {
    const agentActor = {
      type: "agent",
      agentId: "agent-123",
      companyId: COMPANY,
      runId: null,
    };
    const res = await request(createApp(agentActor)).get(
      `/api/companies/${COMPANY}/cockpit`,
    );
    // assertBoard throws 403 for non-board actors.
    expect(res.status).toBe(403);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("mcp actor → 403 and svc.get NOT called", async () => {
    const mcpActor = {
      type: "mcp",
      userId: "mcp-user",
      companyId: COMPANY,
      runId: null,
    };
    const res = await request(createApp(mcpActor)).get(
      `/api/companies/${COMPANY}/cockpit`,
    );
    expect(res.status).toBe(403);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("unauthenticated (type=none) → 401 and svc.get NOT called", async () => {
    const noActor = { type: "none" };
    const res = await request(createApp(noActor)).get(
      `/api/companies/${COMPANY}/cockpit`,
    );
    // assertCompanyAccess throws 401 for type=none.
    expect(res.status).toBe(401);
    expect(mockGet).not.toHaveBeenCalled();
  });
});

describe("GET /companies/:cid/cockpit — assertCompanyAccess", () => {
  it("board actor for a different company → 403", async () => {
    // Actor has access to OTHER_COMPANY only, not COMPANY.
    const wrongCompanyActor = {
      type: "board",
      userId: "board-user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [OTHER_COMPANY], // NOT COMPANY
    };
    const res = await request(createApp(wrongCompanyActor)).get(
      `/api/companies/${COMPANY}/cockpit`,
    );
    expect(res.status).toBe(403);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("instance admin (isInstanceAdmin=true) → 200 even with no company membership", async () => {
    // Instance admins bypass the companyIds check in assertCompanyAccess.
    const adminActor = {
      type: "board",
      userId: "admin-user",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [], // no explicit membership
    };
    const res = await request(createApp(adminActor)).get(
      `/api/companies/${COMPANY}/cockpit`,
    );
    expect(res.status).toBe(200);
    expect(mockGet).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({ actorId: "admin-user", isInstanceAdmin: true }),
    );
  });
});

describe("GET /companies/:cid/cockpit/tasks", () => {
  it("passes a validated bucket, limit, and cursor to the service", async () => {
    const cursor = Buffer.from(JSON.stringify({
      attentionRank: 0,
      urgencyRank: 1,
      priorityRank: 2,
      updatedAt: "2026-07-10T00:00:00.000Z",
      id: "task-1",
    })).toString("base64url");
    const res = await request(createApp()).get(
      `/api/companies/${COMPANY}/cockpit/tasks?bucket=managed&limit=25&cursor=${cursor}`,
    );

    expect(res.status).toBe(200);
    expect(mockListTasks).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({ actorId: "board-user-1" }),
      "managed",
      { limit: 25, cursor },
    );
  });

  it.each([
    "bucket=unknown",
    "bucket=mine&limit=0",
    "bucket=mine&limit=101",
    "bucket=mine&limit=1.5",
    "bucket=mine&cursor=not-a-cursor",
  ])("rejects invalid query: %s", async (query) => {
    const res = await request(createApp()).get(
      `/api/companies/${COMPANY}/cockpit/tasks?${query}`,
    );
    expect(res.status).toBe(400);
    expect(mockListTasks).not.toHaveBeenCalled();
  });

  it("applies the board-only guard", async () => {
    const res = await request(createApp({
      type: "agent",
      agentId: "agent-123",
      companyId: COMPANY,
      runId: null,
    })).get(`/api/companies/${COMPANY}/cockpit/tasks?bucket=mine`);
    expect(res.status).toBe(403);
    expect(mockListTasks).not.toHaveBeenCalled();
  });
});

describe("GET /companies/:cid/cockpit/counts", () => {
  it("returns the lightweight cockpit counts", async () => {
    const res = await request(createApp()).get(
      `/api/companies/${COMPANY}/cockpit/counts`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ activeWorkMine: 0 });
    expect(mockGetCounts).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({ actorId: "board-user-1" }),
    );
  });
});
