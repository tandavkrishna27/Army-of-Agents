import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockTeamService = vi.hoisted(() => ({
  assertFounder: vi.fn().mockResolvedValue(undefined),
  updateUserRole: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../services/index.js", () => ({
  accessService: () => ({}),
  humanCapabilitiesService: () => ({}),
  humanContextService: () => ({}),
  humanDiscoveryService: () => ({}),
  logActivity: mockLogActivity,
  teamService: () => mockTeamService,
}));

import { errorHandler } from "../middleware/index.js";
import { teamRoutes } from "../routes/team.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const ACTOR_USER_ID = "founder-user-1";
const TARGET_USER_ID = "target-user-1";
const PARENT_USER_ID = "manager-user-1";

function makeApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", teamRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe("PATCH /companies/:companyId/team/users/:userId/role", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTeamService.assertFounder.mockResolvedValue(undefined);
    mockTeamService.updateUserRole.mockResolvedValue({
      userId: TARGET_USER_ID,
      role: "team_lead",
      projectId: PROJECT_ID,
      parentType: "user",
      parentId: PARENT_USER_ID,
    });
  });

  it("updates a user role for a board founder actor and records activity", async () => {
    const app = makeApp({
      type: "board",
      source: "session",
      userId: ACTOR_USER_ID,
      companyIds: [COMPANY_ID],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .patch(`/api/companies/${COMPANY_ID}/team/users/${TARGET_USER_ID}/role`)
      .send({
        role: "team_lead",
        projectId: PROJECT_ID,
        parentType: "user",
        parentId: PARENT_USER_ID,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockTeamService.assertFounder).toHaveBeenCalledWith(
      COMPANY_ID,
      ACTOR_USER_ID,
    );
    expect(mockTeamService.updateUserRole).toHaveBeenCalledWith(
      COMPANY_ID,
      TARGET_USER_ID,
      {
        role: "team_lead",
        projectId: PROJECT_ID,
        parentType: "user",
        parentId: PARENT_USER_ID,
      },
      ACTOR_USER_ID,
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: COMPANY_ID,
        actorType: "user",
        actorId: ACTOR_USER_ID,
        action: "team.role_updated",
        entityType: "user_role",
        entityId: TARGET_USER_ID,
      }),
    );
  });

  it("rejects a non-board actor before role update or activity logging", async () => {
    const app = makeApp({
      type: "agent",
      companyId: COMPANY_ID,
      agentId: "agent-1",
      runId: "run-1",
    });

    const res = await request(app)
      .patch(`/api/companies/${COMPANY_ID}/team/users/${TARGET_USER_ID}/role`)
      .send({
        role: "team_lead",
        projectId: PROJECT_ID,
        parentType: "user",
        parentId: PARENT_USER_ID,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body).toEqual({ error: "Board authentication required" });
    expect(mockTeamService.assertFounder).not.toHaveBeenCalled();
    expect(mockTeamService.updateUserRole).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});
