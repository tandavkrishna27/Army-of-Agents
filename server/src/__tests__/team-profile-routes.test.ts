import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { notFound } from "../errors.js";
import { errorHandler } from "../middleware/index.js";

const mockTeamService = vi.hoisted(() => ({
  assertFounder: vi.fn(),
  getUserRole: vi.fn(),
  isCompanySystemAdmin: vi.fn(),
  updateCompanyUserProfile: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => ({}),
  humanCapabilitiesService: () => ({}),
  humanContextService: () => ({}),
  humanDiscoveryService: () => ({}),
  logActivity: mockLogActivity,
  teamService: () => mockTeamService,
}));

import { teamRoutes } from "../routes/team.js";

function createApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", teamRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const companyId = "11111111-1111-4111-8111-111111111111";

describe("team profile routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogActivity.mockResolvedValue(undefined);
    mockTeamService.getUserRole.mockResolvedValue({ role: "team_member", projectId: null });
    mockTeamService.isCompanySystemAdmin.mockResolvedValue(false);
    mockTeamService.updateCompanyUserProfile.mockResolvedValue({
      userId: "user-1",
      displayName: "Updated Human",
      avatarUrl: null,
      title: "Operator",
      bio: null,
      location: null,
      timezone: null,
      socialLinks: [],
      avatarAssetId: null,
    });
  });

  it("lets a board member update their own company profile and logs activity", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      companyIds: [companyId],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .patch(`/api/companies/${companyId}/team/users/user-1/profile`)
      .send({ displayName: "Updated Human", title: "Operator" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.profile.displayName).toBe("Updated Human");
    expect(mockTeamService.updateCompanyUserProfile).toHaveBeenCalledWith(
      companyId,
      "user-1",
      { displayName: "Updated Human", title: "Operator" },
      "user-1",
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId,
        actorType: "user",
        actorId: "user-1",
        action: "team.profile_updated",
        entityType: "user_profile",
        entityId: "user-1",
      }),
    );
  });

  it("lets a founder update another member profile", async () => {
    mockTeamService.getUserRole.mockResolvedValueOnce({ role: "founder", projectId: null });
    const app = createApp({
      type: "board",
      userId: "founder-1",
      source: "session",
      companyIds: [companyId],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .patch(`/api/companies/${companyId}/team/users/user-2/profile`)
      .send({ displayName: "Teammate" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockTeamService.updateCompanyUserProfile).toHaveBeenCalled();
  });

  it("lets a company system admin update another member profile", async () => {
    mockTeamService.getUserRole.mockResolvedValueOnce({ role: "team_member", projectId: null });
    mockTeamService.isCompanySystemAdmin.mockResolvedValueOnce(true);
    const app = createApp({
      type: "board",
      userId: "admin-1",
      source: "session",
      companyIds: [companyId],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .patch(`/api/companies/${companyId}/team/users/user-2/profile`)
      .send({ title: "Ops" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockTeamService.updateCompanyUserProfile).toHaveBeenCalled();
  });

  it("rejects non-founder non-admin updates to another member profile", async () => {
    const app = createApp({
      type: "board",
      userId: "member-1",
      source: "session",
      companyIds: [companyId],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .patch(`/api/companies/${companyId}/team/users/user-2/profile`)
      .send({ title: "Nope" });

    expect(res.status).toBe(403);
    expect(mockTeamService.updateCompanyUserProfile).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("returns 404 and does not log activity when the target user is not an active member", async () => {
    mockTeamService.getUserRole.mockResolvedValueOnce({ role: "founder", projectId: null });
    mockTeamService.updateCompanyUserProfile.mockRejectedValueOnce(notFound("Team member not found"));
    const app = createApp({
      type: "board",
      userId: "founder-1",
      source: "session",
      companyIds: [companyId],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .patch(`/api/companies/${companyId}/team/users/inactive-user/profile`)
      .send({ displayName: "Inactive" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Team member not found");
    expect(mockTeamService.updateCompanyUserProfile).toHaveBeenCalledWith(
      companyId,
      "inactive-user",
      { displayName: "Inactive" },
      "founder-1",
    );
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("rejects non-board actors", async () => {
    const app = createApp({ type: "agent", companyId, agentId: "agent-1" });

    const res = await request(app)
      .patch(`/api/companies/${companyId}/team/users/user-1/profile`)
      .send({ displayName: "Nope" });

    expect(res.status).toBe(403);
    expect(mockTeamService.updateCompanyUserProfile).not.toHaveBeenCalled();
  });
});
