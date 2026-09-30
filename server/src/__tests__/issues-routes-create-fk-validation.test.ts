import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { unprocessable } from "../errors.js";
import { errorHandler } from "../middleware/index.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "99999999-9999-4999-8999-999999999999";
const agentId = "22222222-2222-4222-8222-222222222222";
const projectId = "33333333-3333-4333-8333-333333333333";
const goalId = "44444444-4444-4444-8444-444444444444";
const parentId = "55555555-5555-4555-8555-555555555555";
const workspaceSourceId = "66666666-6666-4666-8666-666666666666";
const sourceDiscussionId = "77777777-7777-4777-8777-777777777777";

const validAgent = {
  id: agentId,
  companyId,
  name: "Test Agent",
  status: "idle",
  role: "engineer",
  permissions: {},
  adapterType: "claude_local",
};

const validProject = {
  id: projectId,
  companyId,
  name: "Test Project",
  type: "project" as const,
};

const validGoal = {
  id: goalId,
  companyId,
  title: "Test Goal",
  status: "active",
};

const validParentIssue = {
  id: parentId,
  companyId,
  title: "Parent",
  status: "todo",
};

const createdIssue = {
  id: "issue-1",
  identifier: "AOA-1",
  companyId,
  title: "Test",
  status: "todo",
  assigneeAgentId: null,
  projectId: null,
  goalId: null,
  parentId: null,
  labels: [],
  labelIds: [],
};

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  checkout: vi.fn(),
  release: vi.fn(),
  listLabels: vi.fn(),
  getLabelById: vi.fn(),
  createLabel: vi.fn(),
  deleteLabel: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
  getComment: vi.fn(),
  createAttachment: vi.fn(),
  listAttachments: vi.fn(),
  getAttachmentById: vi.fn(),
  removeAttachment: vi.fn(),
  findMentionedAgents: vi.fn(),
  findMentionedProjectIds: vi.fn(),
  getAncestors: vi.fn(),
  staleCount: vi.fn(),
  countUnreadTouchedByUser: vi.fn(),
  markRead: vi.fn(),
  assertCheckoutOwner: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockGoalService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  listApprovalsForIssue: vi.fn(),
  link: vi.fn(),
  unlink: vi.fn(),
}));

const mockDocumentService = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  upsert: vi.fn(),
  listRevisions: vi.fn(),
  restoreRevision: vi.fn(),
}));

const mockRoutineService = vi.hoisted(() => ({}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  goalService: () => mockGoalService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
  routineService: () => mockRoutineService,
}));

vi.mock("../services/documents.js", () => ({
  documentService: () => mockDocumentService,
}));

const { issueRoutes } = await import("../routes/issues.js");

function discussionDb(discussionCompanyId: string | null = companyId) {
  const rows = discussionCompanyId ? [{ companyId: discussionCompanyId }] : [];
  const chain: any = {
    from: () => chain,
    where: () => Promise.resolve(rows),
  };
  return { select: () => chain };
}

function createApp(actor: Record<string, unknown> = {
  type: "board",
  userId: "board-user",
  source: "session",
  isInstanceAdmin: true,
  companyIds: [companyId],
}, db: Record<string, unknown> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes(db as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("POST /companies/:companyId/issues — FK validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAgentService.getById.mockResolvedValue(validAgent);
    mockProjectService.getById.mockResolvedValue(validProject);
    mockGoalService.getById.mockResolvedValue(validGoal);
    mockIssueService.getById.mockResolvedValue(validParentIssue);
    mockIssueService.create.mockResolvedValue(createdIssue);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("converts API due-date strings to Date values before persistence", async () => {
    const dueDate = "2026-07-10T18:30:00.000Z";

    const res = await request(createApp())
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Due today", dueDate });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({ dueDate: new Date(dueDate) }),
    );
  });

  it("returns 422 with field=assigneeAgentId when assignee agent does not exist", async () => {
    mockAgentService.getById.mockResolvedValue(null);

    const res = await request(createApp())
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Test", assigneeAgentId: agentId });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: "Assignee agent not found",
      details: { field: "assigneeAgentId", id: agentId },
    });
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("returns 422 with field=assigneeAgentId when assignee agent belongs to a different company", async () => {
    mockAgentService.getById.mockResolvedValue({ ...validAgent, companyId: otherCompanyId });

    const res = await request(createApp())
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Test", assigneeAgentId: agentId });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: "Assignee agent not found",
      details: { field: "assigneeAgentId", id: agentId },
    });
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("returns 422 with field=projectId when project does not exist", async () => {
    mockProjectService.getById.mockResolvedValue(null);

    const res = await request(createApp())
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Test", projectId });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: "Project not found",
      details: { field: "projectId", id: projectId },
    });
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("returns 422 with field=projectId when project belongs to a different company", async () => {
    mockProjectService.getById.mockResolvedValue({ ...validProject, companyId: otherCompanyId });

    const res = await request(createApp())
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Test", projectId });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: "Project not found",
      details: { field: "projectId", id: projectId },
    });
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("returns 422 with field=goalId when goal does not exist", async () => {
    mockGoalService.getById.mockResolvedValue(null);

    const res = await request(createApp())
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Test", goalId });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: "Goal not found",
      details: { field: "goalId", id: goalId },
    });
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("returns 422 with field=parentId when parent task does not exist", async () => {
    mockIssueService.getById.mockResolvedValue(null);

    const res = await request(createApp())
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Test", parentId });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: "Parent task not found",
      details: { field: "parentId", id: parentId },
    });
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("returns 422 with field=inheritExecutionWorkspaceFromIssueId when source task does not exist", async () => {
    mockIssueService.getById.mockResolvedValue(null);

    const res = await request(createApp())
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Test", inheritExecutionWorkspaceFromIssueId: workspaceSourceId });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: "Workspace inheritance task not found",
      details: { field: "inheritExecutionWorkspaceFromIssueId", id: workspaceSourceId },
    });
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("persists a source discussion when it belongs to the same company", async () => {
    const res = await request(createApp(undefined, discussionDb()))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Discussion task", sourceDiscussionId });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({ sourceDiscussionId }),
    );
  });

  it("rejects a source discussion outside the company boundary", async () => {
    const res = await request(createApp(undefined, discussionDb(null)))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Foreign discussion task", sourceDiscussionId });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: "Source Discussion not found",
      details: { field: "sourceDiscussionId", id: sourceDiscussionId },
    });
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("creates issue when all FKs are valid", async () => {
    const res = await request(createApp())
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Test",
        assigneeAgentId: agentId,
        projectId,
        goalId,
        parentId,
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        title: "Test",
        assigneeAgentId: agentId,
        projectId,
        goalId,
        parentId,
      }),
    );
  });

  it("skips FK lookups when no FK fields are provided", async () => {
    const res = await request(createApp())
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Standalone task" });

    expect(res.status).toBe(201);
    expect(mockAgentService.getById).not.toHaveBeenCalled();
    expect(mockProjectService.getById).not.toHaveBeenCalled();
    expect(mockGoalService.getById).not.toHaveBeenCalled();
    expect(mockIssueService.getById).not.toHaveBeenCalled();
    expect(mockIssueService.create).toHaveBeenCalled();
  });

  it("returns 422 when creating a task with workspace override violates project policy", async () => {
    mockIssueService.create.mockRejectedValue(
      unprocessable("Project workspace policy does not allow task-level overrides"),
    );

    const res = await request(createApp())
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Override disallowed",
        projectId,
        executionWorkspaceSettings: { mode: "isolated_workspace" },
      });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: "Project workspace policy does not allow task-level overrides",
    });
  });

  it("returns 403 when an agent actor creates a task with workspace override fields", async () => {
    const res = await request(createApp({
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
    }))
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Worker override attempt",
        projectId,
        executionWorkspaceSettings: { mode: "isolated_workspace" },
      });

    expect(res.status).toBe(403);
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });
});

describe("PATCH /issues/:id workspace policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockIssueService.getById.mockResolvedValue({
      ...createdIssue,
      id: "77777777-7777-4777-8777-777777777777",
      companyId,
      projectId,
      workMode: "standard",
      assigneeAgentId: null,
      assigneeUserId: null,
      executionRunId: null,
    });
    mockIssueService.update.mockRejectedValue(
      unprocessable("Project workspace policy does not allow task-level overrides"),
    );
  });

  it("returns 422 when issue PATCH workspace fields violate project policy", async () => {
    const res = await request(createApp())
      .patch("/api/issues/77777777-7777-4777-8777-777777777777")
      .send({
        executionWorkspaceSettings: {
          mode: "isolated_workspace",
        },
      });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: "Project workspace policy does not allow task-level overrides",
    });
  });

  it("returns 403 when an agent actor PATCHes workspace override fields", async () => {
    mockIssueService.update.mockResolvedValue(null);

    const res = await request(createApp({
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
      runId: null,
    }))
      .patch("/api/issues/77777777-7777-4777-8777-777777777777")
      .send({
        executionWorkspaceSettings: {
          mode: "isolated_workspace",
        },
      });

    expect(res.status).toBe(403);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });
});
