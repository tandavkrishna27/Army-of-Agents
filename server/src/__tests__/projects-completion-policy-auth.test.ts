import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  canUser: vi.fn(),
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  logActivity: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({ canUser: mocks.canUser }),
  projectService: () => ({
    create: mocks.create,
    getById: mocks.getById,
    update: mocks.update,
    resolveByReference: vi.fn().mockResolvedValue({ project: null, ambiguous: false }),
  }),
  instanceSettingsService: () => ({
    getExperimental: vi.fn().mockResolvedValue({ enableIsolatedWorkspaces: true }),
  }),
  secretService: () => ({}),
  logActivity: mocks.logActivity,
}));

import { errorHandler } from "../middleware/error-handler.js";
import { projectRoutes } from "../routes/projects.js";

const companyId = "company-A";
const projectId = "11111111-1111-4111-8111-111111111111";

function boardActor(overrides: Record<string, unknown> = {}) {
  return {
    type: "board",
    source: "session",
    userId: "user-1",
    companyIds: [companyId],
    isInstanceAdmin: false,
    ...overrides,
  };
}

function makeApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & { actor: Record<string, unknown> }).actor = actor;
    next();
  });
  app.use("/api", projectRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe("project completion-policy authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.canUser.mockResolvedValue(false);
    mocks.create.mockResolvedValue({
      id: projectId,
      companyId,
      name: "Research",
      agentCompletionPolicyDefault: null,
    });
    mocks.getById.mockResolvedValue({
      id: projectId,
      companyId,
      name: "Research",
      agentCompletionPolicyDefault: null,
    });
    mocks.update.mockResolvedValue({
      id: projectId,
      companyId,
      name: "Renamed",
      executionWorkspacePolicy: null,
      agentCompletionPolicyDefault: null,
    });
  });

  it("allows ordinary project creation without tasks:assign", async () => {
    const res = await request(makeApp(boardActor()))
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: "Research" });

    expect(res.status).toBe(201);
    expect(mocks.canUser).not.toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledOnce();
  });

  it("rejects a project completion default on create without tasks:assign", async () => {
    const res = await request(makeApp(boardActor()))
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: "Research", agentCompletionPolicyDefault: "agent_can_complete" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Missing permission: tasks:assign");
    expect(mocks.canUser).toHaveBeenCalledWith(companyId, "user-1", "tasks:assign");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("allows a project completion default on create with tasks:assign", async () => {
    mocks.canUser.mockResolvedValue(true);

    const res = await request(makeApp(boardActor()))
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: "Research", agentCompletionPolicyDefault: "review_required" });

    expect(res.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({ agentCompletionPolicyDefault: "review_required" }),
    );
  });

  it("rejects agent-created project completion defaults", async () => {
    const res = await request(makeApp({
      type: "agent",
      source: "agent_key",
      agentId: "agent-1",
      companyId,
    }))
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: "Research", agentCompletionPolicyDefault: "agent_can_complete" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Only human operators may set project scope policy");
    expect(mocks.canUser).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rejects changing or clearing a project completion default without tasks:assign", async () => {
    const res = await request(makeApp(boardActor()))
      .patch(`/api/projects/${projectId}`)
      .send({ agentCompletionPolicyDefault: null });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Missing permission: tasks:assign");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("allows changing a project completion default with tasks:assign", async () => {
    mocks.canUser.mockResolvedValue(true);

    const res = await request(makeApp(boardActor()))
      .patch(`/api/projects/${projectId}`)
      .send({ agentCompletionPolicyDefault: "agent_can_complete" });

    expect(res.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(
      projectId,
      expect.objectContaining({ agentCompletionPolicyDefault: "agent_can_complete" }),
    );
  });

  it("rejects a project question SLA on create without tasks:assign", async () => {
    const res = await request(makeApp(boardActor()))
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: "Research", humanQuestionSlaHours: 12 });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Missing permission: tasks:assign");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("allows a project question SLA on create with tasks:assign", async () => {
    mocks.canUser.mockResolvedValue(true);

    const res = await request(makeApp(boardActor()))
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: "Research", humanQuestionSlaHours: 12 });

    expect(res.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({ humanQuestionSlaHours: 12 }),
    );
  });

  it.each([
    {
      type: "agent",
      source: "agent_key",
      agentId: "agent-1",
      companyId,
    },
    {
      type: "mcp",
      source: "mcp_key",
      userId: "user-1",
      companyId,
      keyId: "key-1",
    },
  ])("rejects non-board project question SLA updates", async (actor) => {
    const res = await request(makeApp(actor))
      .patch(`/api/projects/${projectId}`)
      .send({ humanQuestionSlaHours: 8 });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Only human operators may set project scope policy");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("gates clearing a project question SLA", async () => {
    const res = await request(makeApp(boardActor()))
      .patch(`/api/projects/${projectId}`)
      .send({ humanQuestionSlaHours: null });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Missing permission: tasks:assign");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("allows changing a project question SLA with tasks:assign", async () => {
    mocks.canUser.mockResolvedValue(true);

    const res = await request(makeApp(boardActor()))
      .patch(`/api/projects/${projectId}`)
      .send({ humanQuestionSlaHours: 8 });

    expect(res.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(
      projectId,
      expect.objectContaining({ humanQuestionSlaHours: 8 }),
    );
  });

  it("allows ordinary project updates without tasks:assign", async () => {
    const res = await request(makeApp(boardActor()))
      .patch(`/api/projects/${projectId}`)
      .send({ name: "Renamed" });

    expect(res.status).toBe(200);
    expect(mocks.canUser).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "local implicit SLA",
      overrides: { source: "local_implicit", companyIds: [] },
      update: { humanQuestionSlaHours: 6 },
    },
    {
      label: "instance-admin SLA",
      overrides: { isInstanceAdmin: true },
      update: { humanQuestionSlaHours: 6 },
    },
    {
      label: "local implicit completion policy",
      overrides: { source: "local_implicit", companyIds: [] },
      update: { agentCompletionPolicyDefault: "review_required" },
    },
  ])("preserves the privileged bypass for $label", async ({ overrides, update }) => {
    const res = await request(makeApp(boardActor(overrides)))
      .patch(`/api/projects/${projectId}`)
      .send(update);

    expect(res.status).toBe(200);
    expect(mocks.canUser).not.toHaveBeenCalled();
  });
});
