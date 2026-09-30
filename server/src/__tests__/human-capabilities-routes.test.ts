import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";

const mockTeamService = vi.hoisted(() => ({
  getUserRole: vi.fn(),
  isCompanySystemAdmin: vi.fn(),
}));

const mockHumanCapabilitiesService = vi.hoisted(() => ({
  listDocuments: vi.fn(),
  createDocument: vi.fn(),
  updateDocument: vi.fn(),
  deleteDocument: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => ({}),
  logActivity: mockLogActivity,
  teamService: () => mockTeamService,
  humanCapabilitiesService: () => mockHumanCapabilitiesService,
  humanContextService: () => ({}),
  humanDiscoveryService: () => ({}),
}));

import { teamRoutes } from "../routes/team.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const targetUserId = "user-1";
const actorUserId = "user-1";

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

function makeActor(userId = actorUserId) {
  return {
    type: "board",
    userId,
    source: "session",
    companyIds: [companyId],
    isInstanceAdmin: false,
  };
}

describe("human capability routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogActivity.mockResolvedValue(undefined);
    mockTeamService.getUserRole.mockResolvedValue({ role: "team_member", projectId: null });
    mockTeamService.isCompanySystemAdmin.mockResolvedValue(false);
    mockHumanCapabilitiesService.listDocuments.mockResolvedValue({
      companyId,
      userId: targetUserId,
      documents: [{ id: "doc-1", filename: "skills.md", title: "Skills", content: "# Skills", isStandard: true }],
    });
    mockHumanCapabilitiesService.createDocument.mockResolvedValue({
      id: "doc-2",
      filename: "portfolio.md",
      title: "Portfolio",
      content: "# Portfolio",
      isStandard: false,
    });
    mockHumanCapabilitiesService.updateDocument.mockResolvedValue({
      id: "doc-1",
      filename: "skills.md",
      title: "Skills",
      content: "# Skills\n\n## Core Skills",
      isStandard: true,
    });
    mockHumanCapabilitiesService.deleteDocument.mockResolvedValue({ ok: true });
  });

  it("lists capability documents for company members", async () => {
    const app = createApp(makeActor());

    const res = await request(app)
      .get(`/api/companies/${companyId}/team/users/${targetUserId}/capabilities`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockHumanCapabilitiesService.listDocuments).toHaveBeenCalledWith(companyId, targetUserId, actorUserId);
    expect(res.body.documents[0].filename).toBe("skills.md");
  });

  it("rejects agent actors from the UI capability document list route", async () => {
    const app = createApp({ type: "agent", companyId, agentId: "agent-1" });

    const res = await request(app)
      .get(`/api/companies/${companyId}/team/users/${targetUserId}/capabilities`);

    expect(res.status).toBe(403);
    expect(mockHumanCapabilitiesService.listDocuments).not.toHaveBeenCalled();
  });

  it("rejects MCP actors from the UI capability document list route", async () => {
    const app = createApp({ type: "mcp", companyId, userId: actorUserId });

    const res = await request(app)
      .get(`/api/companies/${companyId}/team/users/${targetUserId}/capabilities`);

    expect(res.status).toBe(403);
    expect(mockHumanCapabilitiesService.listDocuments).not.toHaveBeenCalled();
  });

  it("allows self to update a capability document and logs activity", async () => {
    const app = createApp(makeActor());

    const res = await request(app)
      .patch(`/api/companies/${companyId}/team/users/${targetUserId}/capabilities/doc-1`)
      .send({ content: "# Skills\n\n## Core Skills" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockHumanCapabilitiesService.updateDocument).toHaveBeenCalledWith(
      companyId,
      targetUserId,
      "doc-1",
      { content: "# Skills\n\n## Core Skills" },
      actorUserId,
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId,
        actorType: "user",
        actorId: actorUserId,
        action: "team.capability_document_updated",
        entityType: "user_capability_document",
        entityId: "doc-1",
      }),
    );
  });

  it("allows self to create and delete custom capability documents", async () => {
    const app = createApp(makeActor());

    const createRes = await request(app)
      .post(`/api/companies/${companyId}/team/users/${targetUserId}/capabilities`)
      .send({ title: "Portfolio", filename: "portfolio.md", content: "# Portfolio" });

    expect(createRes.status, JSON.stringify(createRes.body)).toBe(200);
    expect(mockHumanCapabilitiesService.createDocument).toHaveBeenCalledWith(
      companyId,
      targetUserId,
      { title: "Portfolio", filename: "portfolio.md", content: "# Portfolio" },
      actorUserId,
    );

    const deleteRes = await request(app)
      .delete(`/api/companies/${companyId}/team/users/${targetUserId}/capabilities/doc-2`);

    expect(deleteRes.status, JSON.stringify(deleteRes.body)).toBe(200);
    expect(mockHumanCapabilitiesService.deleteDocument).toHaveBeenCalledWith(companyId, targetUserId, "doc-2");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "team.capability_document_created", entityId: "doc-2" }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "team.capability_document_deleted", entityId: "doc-2" }),
    );
  });

  it("rejects another regular member editing capabilities", async () => {
    const app = createApp(makeActor("other-user"));

    const res = await request(app)
      .patch(`/api/companies/${companyId}/team/users/${targetUserId}/capabilities/doc-1`)
      .send({ content: "# Nope" });

    expect(res.status).toBe(403);
    expect(mockHumanCapabilitiesService.updateDocument).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});
