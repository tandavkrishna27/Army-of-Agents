import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { workflowTemplateRoutes } from "../routes/workflow-templates.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const templateId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";

const mockWorkflowTemplateService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  instantiate: vi.fn(),
  delete: vi.fn(),
}));
const mockCanUser = vi.hoisted(() => vi.fn());
const mockAssertRole = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => ({ canUser: mockCanUser }),
  workflowTemplateService: () => mockWorkflowTemplateService,
  logActivity: vi.fn(),
}));

vi.mock("../middleware/rbac.js", () => ({
  assertRole: (...args: unknown[]) => mockAssertRole(...args),
  assertHumanRole: (...args: unknown[]) => mockAssertRole(...args),
}));

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", workflowTemplateRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("workflow-template completion-policy authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanUser.mockResolvedValue(false);
    mockAssertRole.mockResolvedValue(undefined);
    mockWorkflowTemplateService.create.mockResolvedValue({ id: templateId, companyId, name: "Template" });
    mockWorkflowTemplateService.update.mockResolvedValue({ id: templateId, companyId, name: "Template" });
  });

  it("rejects an agent-supplied override on create", async () => {
    const res = await request(createApp({ type: "agent", agentId, companyId }))
      .post(`/api/companies/${companyId}/workflow-templates`)
      .send({
        name: "Agent template",
        steps: [{ order: 1, title: "Run" }],
        agentCompletionPolicyOverride: "agent_can_complete",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Only human operators");
    expect(mockWorkflowTemplateService.create).not.toHaveBeenCalled();
  });

  it("rejects an agent-supplied override on update", async () => {
    const res = await request(createApp({ type: "agent", agentId, companyId }))
      .patch(`/api/companies/${companyId}/workflow-templates/${templateId}`)
      .send({ agentCompletionPolicyOverride: "agent_can_complete" });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Only human operators");
    expect(mockWorkflowTemplateService.update).not.toHaveBeenCalled();
  });

  it("rejects a board override on create without tasks:assign", async () => {
    const res = await request(createApp({
      type: "board",
      userId: "team-lead-1",
      source: "session",
      companyIds: [companyId],
      isInstanceAdmin: false,
    }))
      .post(`/api/companies/${companyId}/workflow-templates`)
      .send({
        name: "Governed template",
        steps: [{ order: 1, title: "Run" }],
        agentCompletionPolicyOverride: "agent_can_complete",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Missing permission: tasks:assign");
    expect(mockCanUser).toHaveBeenCalledWith(companyId, "team-lead-1", "tasks:assign");
    expect(mockWorkflowTemplateService.create).not.toHaveBeenCalled();
  });

  it("rejects clearing an override on update without tasks:assign", async () => {
    const res = await request(createApp({
      type: "board",
      userId: "team-lead-1",
      source: "session",
      companyIds: [companyId],
      isInstanceAdmin: false,
    }))
      .patch(`/api/companies/${companyId}/workflow-templates/${templateId}`)
      .send({ agentCompletionPolicyOverride: null });

    expect(res.status).toBe(403);
    expect(mockWorkflowTemplateService.update).not.toHaveBeenCalled();
  });

  it("allows an override with tasks:assign", async () => {
    mockCanUser.mockResolvedValue(true);

    const res = await request(createApp({
      type: "board",
      userId: "workflow-admin",
      source: "session",
      companyIds: [companyId],
      isInstanceAdmin: false,
    }))
      .patch(`/api/companies/${companyId}/workflow-templates/${templateId}`)
      .send({ agentCompletionPolicyOverride: "review_required" });

    expect(res.status).toBe(200);
    expect(mockWorkflowTemplateService.update).toHaveBeenCalledWith(
      companyId,
      templateId,
      expect.objectContaining({ agentCompletionPolicyOverride: "review_required" }),
    );
  });

  it("does not require tasks:assign for ordinary template updates", async () => {
    const res = await request(createApp({
      type: "board",
      userId: "team-lead-1",
      source: "session",
      companyIds: [companyId],
      isInstanceAdmin: false,
    }))
      .patch(`/api/companies/${companyId}/workflow-templates/${templateId}`)
      .send({ description: "Updated description" });

    expect(res.status).toBe(200);
    expect(mockCanUser).not.toHaveBeenCalled();
  });

  it("preserves the trusted local operator bypass", async () => {
    const res = await request(createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      companyIds: [],
      isInstanceAdmin: false,
    }))
      .patch(`/api/companies/${companyId}/workflow-templates/${templateId}`)
      .send({ agentCompletionPolicyOverride: "agent_can_complete" });

    expect(res.status).toBe(200);
    expect(mockCanUser).not.toHaveBeenCalled();
  });
});
