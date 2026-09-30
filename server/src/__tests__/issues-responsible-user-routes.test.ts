import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const issueId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const nextAgentId = "44444444-4444-4444-8444-444444444444";

const baseIssue = {
  id: issueId,
  identifier: "AOA-1",
  companyId,
  title: "Prepare launch plan",
  status: "todo",
  workMode: "standard",
  assigneeAgentId: agentId,
  assigneeUserId: null,
  responsibleUserId: "user-old",
  createdByUserId: "creator-user",
  projectId: null,
  goalId: null,
  parentId: null,
  executionRunId: null,
  updatedAt: new Date("2026-07-14T00:00:00.000Z"),
  labels: [],
  labelIds: [],
};

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  // Round-18 #4: request-changes with a submission key exercises the early-replay
  // + control-effect markers.
  getCommentByClientSubmissionId: vi.fn(),
  markCommentControlEffectsCompleted: vi.fn(),
  markCommentWakeupsReady: vi.fn(),
  findMentionedAgents: vi.fn(),
  notifyMentionedHumans: vi.fn(),
  resolveAgentKinds: vi.fn(),
  // Round-16: the route enqueues per-target wakeups here (durable outbox). This
  // mock inlines the worker drain (resolve kind → heartbeat.wakeup / aoa) so the
  // existing heartbeat.wakeup assertions still hold.
  enqueueCommentWakeups: vi.fn(async (input: { companyId: string; targets: Array<{ agentId: string; wakeup: any }> }) => {
    const kinds: Map<string, string> = await mockIssueService.resolveAgentKinds(
      input.targets.map((t) => t.agentId),
    );
    for (const t of input.targets) {
      if (kinds.get(t.agentId) === "aoa") {
        const w = t.wakeup ?? {};
        await mockIssueService.enqueueAoaMentionWakeup?.(input.companyId, t.agentId, {
          source: w.source,
          reason: w.reason,
          payload: w.payload,
        });
      } else {
        await mockHeartbeatService.wakeup(t.agentId, t.wakeup);
      }
    }
  }),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockEnqueueIssueAssigneeWakeup = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  goalService: () => ({ getById: vi.fn() }),
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  memoryLifecycleService: () => ({ onTaskCompleted: vi.fn() }),
  projectService: () => ({ getById: vi.fn() }),
  routineService: () => ({ syncRunStatusForIssue: vi.fn() }),
}));

vi.mock("../services/documents.js", () => ({
  documentService: () => ({}),
}));

vi.mock("../services/eager-workspace.js", () => ({
  createEagerWorkspaceForIssue: vi.fn(),
}));

vi.mock("../services/issue-assignee-wakeup.js", () => ({
  enqueueIssueAssigneeWakeup: mockEnqueueIssueAssigneeWakeup,
}));

vi.mock("../services/issue-context-bundles.js", () => ({
  listIssueContextBundlesForIssue: vi.fn(),
  setIssueContextBundleItemIncluded: vi.fn(),
}));

const { issueRoutes } = await import("../routes/issues.js");

function createApp(actor: Record<string, unknown> = {
  type: "board",
  userId: "board-user",
  source: "session",
  companyIds: [companyId],
}) {
  const db = {
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({})),
  };
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

describe("issue responsible user routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAgentService.getById.mockResolvedValue({
      id: agentId,
      companyId,
      status: "idle",
      role: "engineer",
      reportsTo: null,
      permissions: {},
    });
    mockIssueService.list.mockResolvedValue([]);
    mockIssueService.getById.mockResolvedValue(baseIssue);
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.create.mockImplementation(async (_companyId: string, data: Record<string, unknown>) => ({
      ...baseIssue,
      id: "created-issue",
      assigneeAgentId: null,
      responsibleUserId: data.responsibleUserId ?? null,
      ...data,
    }));
    mockIssueService.update.mockImplementation(async (_id: string, data: Record<string, unknown>) => ({
      ...baseIssue,
      ...data,
    }));
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.notifyMentionedHumans.mockResolvedValue(0);
    mockIssueService.resolveAgentKinds.mockResolvedValue(new Map());
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
    mockEnqueueIssueAssigneeWakeup.mockResolvedValue(undefined);
  });

  it("gives a suspended MCP key the same 404 for existing and absent bare identifiers", async () => {
    // actorMiddleware leaves a cloud MCP key owner with inactive membership as
    // `none`, so bare lookup receives an empty authorized-company snapshot.
    mockIssueService.getByIdentifier.mockImplementation(
      async (_identifier: string, allowedCompanyIds?: string[]) =>
        allowedCompanyIds?.includes(companyId) ? baseIssue : null,
    );
    mockIssueService.getById.mockResolvedValue(null);
    const app = createApp({ type: "none", source: "none" });

    const existing = await request(app).get("/api/issues/AOA-1");
    const absent = await request(app).get("/api/issues/AOA-999");

    expect(existing.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(mockIssueService.getByIdentifier).toHaveBeenNthCalledWith(1, "AOA-1", []);
    expect(mockIssueService.getByIdentifier).toHaveBeenNthCalledWith(2, "AOA-999", []);
  });

  it("requires feedback when review changes are requested", async () => {
    mockIssueService.getById.mockResolvedValue({ ...baseIssue, status: "in_review" });

    const res = await request(createApp())
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_progress", comment: "   " });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Requesting changes requires feedback");
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("persists review feedback and wakes the assignee exactly once", async () => {
    mockIssueService.getById.mockResolvedValue({ ...baseIssue, status: "in_review" });
    mockIssueService.update.mockResolvedValue({ ...baseIssue, status: "in_progress" });
    // Round-17 #1: addComment enqueues the review-changes wakeup IN ITS TX via the
    // buildWakeupTargets callback; the mock invokes it + routes to
    // enqueueCommentWakeups (whose inline-drain dispatches heartbeat.wakeup).
    mockIssueService.addComment.mockImplementation(
      async (
        issueIdArg: string,
        body: string,
        actor: {
          agentId?: string;
          buildWakeupTargets?: (comment: {
            id: string;
            authorAgentId: string | null;
          }) => Promise<Array<{ agentId: string; wakeup: unknown }>>;
        },
      ) => {
        const comment = {
          id: "review-comment",
          issueId: issueIdArg,
          companyId,
          body,
          authorAgentId: actor?.agentId ?? null,
          authorUserId: "board-user",
        };
        if (actor?.buildWakeupTargets) {
          const targets = await actor.buildWakeupTargets({ id: comment.id, authorAgentId: comment.authorAgentId });
          await mockIssueService.enqueueCommentWakeups({
            companyId,
            issueId: issueIdArg,
            commentId: comment.id,
            targets,
          });
        }
        return comment;
      },
    );
    mockIssueService.findMentionedAgents.mockResolvedValue([agentId]);

    const res = await request(createApp())
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "in_progress",
        comment: "  Add a measurable success criterion.  ",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      issueId,
      "Add a measurable success criterion.",
      expect.objectContaining({ userId: "board-user" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({
        source: "automation",
        reason: "issue_review_changes_requested",
        payload: {
          issueId,
          commentId: "review-comment",
          mutation: "request_changes",
        },
        contextSnapshot: expect.objectContaining({
          taskId: issueId,
          wakeCommentId: "review-comment",
          source: "task.review",
        }),
      }),
    );
  });

  it("threads clientSubmissionId into the request-changes feedback comment (round-18 #4)", async () => {
    mockIssueService.getById.mockResolvedValue({ ...baseIssue, status: "in_review" });
    mockIssueService.update.mockResolvedValue({ ...baseIssue, status: "in_progress" });
    mockIssueService.getCommentByClientSubmissionId.mockResolvedValue(null);
    mockIssueService.addComment.mockImplementation(async (issueIdArg: string, body: string) => ({
      id: "review-comment",
      issueId: issueIdArg,
      companyId,
      body,
      authorAgentId: null,
      authorUserId: "board-user",
    }));

    const res = await request(createApp())
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "in_progress",
        comment: "Add a measurable success criterion.",
        clientSubmissionId: "rc-key-1",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The feedback comment is keyed → a lost-response retry replays it instead of
    // creating a second feedback comment.
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      issueId,
      "Add a measurable success criterion.",
      expect.objectContaining({ clientSubmissionId: "rc-key-1" }),
    );
  });

  it("replays the request-changes feedback comment on a same-key retry — no duplicate (round-18 #4)", async () => {
    // The retry arrives after the transition already ran (task now in_progress);
    // the early-replay lookup finds the KEYED feedback comment and short-circuits,
    // so addComment is never called again.
    mockIssueService.getById.mockResolvedValue({ ...baseIssue, status: "in_progress" });
    mockIssueService.getCommentByClientSubmissionId.mockResolvedValue({
      id: "review-comment",
      issueId,
      companyId,
      body: "Add a measurable success criterion.",
      authorAgentId: null,
    });

    const res = await request(createApp())
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "in_progress",
        comment: "Add a measurable success criterion.",
        clientSubmissionId: "rc-key-1",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("lets board users with tasks:assign create and update responsibleUserId", async () => {
    const app = createApp();

    const createRes = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Prepare launch plan", responsibleUserId: "user-new" });

    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    expect(mockAccessService.canUser).toHaveBeenCalledWith(companyId, "board-user", "tasks:assign");
    expect(mockIssueService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({ responsibleUserId: "user-new" }),
    );

    const updateRes = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ responsibleUserId: "user-next" });

    expect(updateRes.status, JSON.stringify(updateRes.body)).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      issueId,
      expect.objectContaining({ responsibleUserId: "user-next" }),
      { actorType: "board", expectedUpdatedAt: baseIssue.updatedAt },
    );
  });

  it("passes board user as responsible fallback when creating an unassigned task", async () => {
    const app = createApp();

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Operator-owned unassigned task" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({ responsibleFallbackUserId: "board-user" }),
    );
  });

  it("rejects board users without tasks:assign when they change responsibleUserId", async () => {
    mockAccessService.canUser.mockResolvedValue(false);

    const res = await request(createApp())
      .patch(`/api/issues/${issueId}`)
      .send({ responsibleUserId: "user-new" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Missing permission: tasks:assign");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects assigned agents without tasks:assign when return-to-creator also changes responsibleUserId", async () => {
    const res = await request(createApp({
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
      runId: "run-1",
    }))
      .patch(`/api/issues/${issueId}`)
      .send({
        assigneeAgentId: null,
        assigneeUserId: "creator-user",
        responsibleUserId: "some-user",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Missing permission: tasks:assign");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects board users without tasks:assign when they create with responsibleUserId", async () => {
    mockAccessService.canUser.mockResolvedValue(false);

    const res = await request(createApp())
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Prepare launch plan", responsibleUserId: "user-new" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Missing permission: tasks:assign");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("does not wake the assigned agent for a responsible-only update", async () => {
    const res = await request(createApp())
      .patch(`/api/issues/${issueId}`)
      .send({ responsibleUserId: "user-new" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockEnqueueIssueAssigneeWakeup).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("logs previous and next responsibleUserId in issue.updated activity details", async () => {
    const res = await request(createApp())
      .patch(`/api/issues/${issueId}`)
      .send({ responsibleUserId: "user-new" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        details: expect.objectContaining({
          responsibleUserId: "user-new",
          previousResponsibleUserId: "user-old",
        }),
      }),
    );
  });

  it("logs persisted responsible owner when reassignment auto-recomputes it", async () => {
    mockIssueService.update.mockResolvedValueOnce({
      ...baseIssue,
      assigneeAgentId: nextAgentId,
      assigneeUserId: null,
      responsibleUserId: "manager-user",
    });

    const res = await request(createApp())
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: nextAgentId, assigneeUserId: null });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        details: expect.objectContaining({
          responsibleUserId: "manager-user",
          previousResponsibleUserId: "user-old",
        }),
      }),
    );
    const details = mockLogActivity.mock.calls.find(([, payload]) => payload.action === "issue.updated")?.[1].details;
    expect(details.responsibleUserId).not.toBe("__omitted__");
  });

  it("does not add responsible fields to unrelated update activity details", async () => {
    const res = await request(createApp())
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Retitled task" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const details = mockLogActivity.mock.calls.find(([, payload]) => payload.action === "issue.updated")?.[1].details;
    expect(details).toEqual(expect.objectContaining({ title: "Retitled task", identifier: "AOA-1" }));
    expect(details).not.toHaveProperty("responsibleUserId");
    expect(details).not.toHaveProperty("previousResponsibleUserId");
  });

  it("passes responsibleUserId list filters to the issue service", async () => {
    const res = await request(createApp())
      .get(`/api/companies/${companyId}/issues`)
      .query({ responsibleUserId: "user-1" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({ responsibleUserId: "user-1" }),
    );
  });

  it("resolves responsibleUserId=me for board actors", async () => {
    const res = await request(createApp())
      .get(`/api/companies/${companyId}/issues`)
      .query({ responsibleUserId: "me" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({ responsibleUserId: "board-user" }),
    );
  });

  it("rejects responsibleUserId=me for non-board actors", async () => {
    const res = await request(createApp({
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
    }))
      .get(`/api/companies/${companyId}/issues`)
      .query({ responsibleUserId: "me" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("responsibleUserId=me requires board authentication");
    expect(mockIssueService.list).not.toHaveBeenCalled();
  });

  it("prevents agents from defining acceptance criteria on their own tasks", async () => {
    const res = await request(createApp({
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
    }))
      .patch(`/api/issues/${issueId}`)
      .send({ acceptanceCriteria: ["Agent says the work is complete"] });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Agents cannot define their own task acceptance criteria");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("prevents agents from elevating task completion policy", async () => {
    const res = await request(createApp({
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
    }))
      .patch(`/api/issues/${issueId}`)
      .send({ agentCompletionPolicyOverride: "agent_can_complete" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Only human operators may override task completion policy");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects an agent-supplied completion override even when it matches the stored value", async () => {
    mockIssueService.getById.mockResolvedValue({
      ...baseIssue,
      agentCompletionPolicyOverride: null,
    });

    const res = await request(createApp({
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
    }))
      .patch(`/api/issues/${issueId}`)
      .send({ agentCompletionPolicyOverride: null });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Only human operators may override task completion policy");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });
});
