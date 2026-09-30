import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routineRoutes } from "../routes/routines.js";
import { errorHandler } from "../middleware/index.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const agentId = "11111111-1111-4111-8111-111111111111";
const routineId = "33333333-3333-4333-8333-333333333333";
const projectId = "44444444-4444-4444-8444-444444444444";
const otherAgentId = "55555555-5555-4555-8555-555555555555";

const routine = {
  id: routineId,
  companyId,
  projectId,
  goalId: null,
  parentIssueId: null,
  title: "Daily routine",
  description: null,
  assigneeAgentId: agentId,
  priority: "medium",
  status: "active",
  concurrencyPolicy: "coalesce_if_active",
  catchUpPolicy: "skip_missed",
  agentCompletionPolicyOverride: null,
  createdByAgentId: null,
  createdByUserId: null,
  updatedByAgentId: null,
  updatedByUserId: null,
  lastTriggeredAt: null,
  lastEnqueuedAt: null,
  latestRevisionId: null,
  createdAt: new Date("2026-03-20T00:00:00.000Z"),
  updatedAt: new Date("2026-03-20T00:00:00.000Z"),
};

const pausedRoutine = {
  ...routine,
  status: "paused",
};

const trigger = {
  id: "66666666-6666-4666-8666-666666666666",
  companyId,
  routineId,
  kind: "schedule",
  label: "weekday",
  enabled: false,
  cronExpression: "0 10 * * 1-5",
  timezone: "UTC",
  nextRunAt: null,
  lastFiredAt: null,
  publicId: null,
  secretId: null,
  signingMode: null,
  replayWindowSec: null,
  lastRotatedAt: null,
  lastResult: null,
  createdByAgentId: null,
  createdByUserId: null,
  updatedByAgentId: null,
  updatedByUserId: null,
  createdAt: new Date("2026-03-20T00:00:00.000Z"),
  updatedAt: new Date("2026-03-20T00:00:00.000Z"),
};

const mockRoutineService = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  getDetail: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  listRuns: vi.fn(),
  createTrigger: vi.fn(),
  getTrigger: vi.fn(),
  updateTrigger: vi.fn(),
  deleteTrigger: vi.fn(),
  rotateTriggerSecret: vi.fn(),
  runRoutine: vi.fn(),
  firePublicTrigger: vi.fn(),
  tickScheduledTriggers: vi.fn(),
  syncRunStatusForIssue: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  logActivity: mockLogActivity,
  routineService: () => mockRoutineService,
}));

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", routineRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("routine routes — authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRoutineService.create.mockResolvedValue(routine);
    mockRoutineService.get.mockResolvedValue(routine);
    mockRoutineService.getTrigger.mockResolvedValue(trigger);
    mockRoutineService.update.mockResolvedValue({ ...routine, assigneeAgentId: otherAgentId });
    mockRoutineService.runRoutine.mockResolvedValue({
      id: "run-1",
      source: "manual",
      status: "issue_created",
    });
    mockAccessService.canUser.mockResolvedValue(false);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("requires tasks:assign permission for non-admin board routine creation", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        projectId,
        title: "Daily routine",
        assigneeAgentId: agentId,
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
    expect(mockRoutineService.create).not.toHaveBeenCalled();
  });

  it("rejects an agent-supplied completion policy on routine creation", async () => {
    const app = createApp({ type: "agent", agentId, companyId });

    const res = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        title: "Agent routine",
        assigneeAgentId: agentId,
        agentCompletionPolicyOverride: "agent_can_complete",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Only human operators");
    expect(mockRoutineService.create).not.toHaveBeenCalled();
  });

  it("rejects an agent completion-policy change on an existing routine", async () => {
    const app = createApp({ type: "agent", agentId, companyId });

    const res = await request(app)
      .patch(`/api/routines/${routineId}`)
      .send({ agentCompletionPolicyOverride: "agent_can_complete" });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Only human operators");
    expect(mockRoutineService.update).not.toHaveBeenCalled();
  });

  it("requires tasks:assign permission to retarget a routine assignee", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .patch(`/api/routines/${routineId}`)
      .send({ assigneeAgentId: otherAgentId });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
    expect(mockRoutineService.update).not.toHaveBeenCalled();
  });

  it("requires tasks:assign whenever a board patch supplies an assignee", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .patch(`/api/routines/${routineId}`)
      .send({ assigneeAgentId: agentId });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
    expect(mockRoutineService.update).not.toHaveBeenCalled();
  });

  it("requires tasks:assign permission to reactivate a paused routine", async () => {
    mockRoutineService.get.mockResolvedValue(pausedRoutine);
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .patch(`/api/routines/${routineId}`)
      .send({ status: "active" });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
    expect(mockRoutineService.update).not.toHaveBeenCalled();
  });

  it("requires tasks:assign permission to create a trigger", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/routines/${routineId}/triggers`)
      .send({
        kind: "schedule",
        cronExpression: "0 10 * * *",
        timezone: "UTC",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
    expect(mockRoutineService.createTrigger).not.toHaveBeenCalled();
  });

  it("requires tasks:assign permission to update a trigger", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .patch(`/api/routine-triggers/${trigger.id}`)
      .send({ enabled: true });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
    expect(mockRoutineService.updateTrigger).not.toHaveBeenCalled();
  });

  it("requires tasks:assign permission to manually run a routine", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/routines/${routineId}/run`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
    expect(mockRoutineService.runRoutine).not.toHaveBeenCalled();
  });

  it("allows routine creation when the board user has tasks:assign", async () => {
    mockAccessService.canUser.mockResolvedValue(true);
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        projectId,
        title: "Daily routine",
        assigneeAgentId: agentId,
      });

    expect(res.status).toBe(201);
    expect(mockRoutineService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({ projectId, title: "Daily routine", assigneeAgentId: agentId }),
      expect.objectContaining({ userId: "board-user" }),
    );
  });

  it("allows routine run when the board user has tasks:assign", async () => {
    mockAccessService.canUser.mockResolvedValue(true);
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/routines/${routineId}/run`)
      .send({ source: "manual" });

    expect(res.status).toBe(202);
    expect(mockRoutineService.runRoutine).toHaveBeenCalledWith(
      routineId,
      expect.objectContaining({ source: "manual" }),
      expect.objectContaining({ agentId: null, userId: "board-user" }),
    );
  });

  it("allows instance admins to create routines without tasks:assign permission", async () => {
    // isInstanceAdmin bypasses canUser check
    const app = createApp({
      type: "board",
      userId: "admin-user",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        projectId,
        title: "Admin routine",
        assigneeAgentId: agentId,
      });

    expect(res.status).toBe(201);
    expect(mockRoutineService.create).toHaveBeenCalled();
  });

  it("rejects routine creation with an invalid body (missing title)", async () => {
    // Draft defaults (T11): assigneeAgentId and projectId are now optional — a
    // routine can be saved without them.  The only remaining hard-required field
    // at the zod layer is `title`.
    mockAccessService.canUser.mockResolvedValue(true);
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({}); // missing title → zod rejects

    expect(res.status).toBe(400);
    expect(mockRoutineService.create).not.toHaveBeenCalled();
  });

  it("returns 404 when routine does not exist on PATCH", async () => {
    mockRoutineService.get.mockResolvedValue(null);
    mockAccessService.canUser.mockResolvedValue(true);
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .patch(`/api/routines/${routineId}`)
      .send({ title: "Updated" });

    expect(res.status).toBe(404);
    expect(mockRoutineService.update).not.toHaveBeenCalled();
  });
});

describe("routine routes — list and detail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRoutineService.list.mockResolvedValue([routine]);
    mockRoutineService.get.mockResolvedValue(routine);
    mockRoutineService.getDetail.mockResolvedValue({
      ...routine,
      project: null,
      assignee: null,
      parentIssue: null,
      triggers: [trigger],
      recentRuns: [],
      activeIssue: null,
    });
    mockRoutineService.listRuns.mockResolvedValue([]);
    mockAccessService.canUser.mockResolvedValue(true);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("GET /companies/:companyId/routines returns list", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app).get(`/api/companies/${companyId}/routines`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(routineId);
  });

  it("GET /routines/:id returns routine detail with triggers", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app).get(`/api/routines/${routineId}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(routineId);
    expect(res.body.triggers).toHaveLength(1);
    expect(res.body.triggers[0].id).toBe(trigger.id);
  });

  it("GET /routines/:id/runs returns run list", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app).get(`/api/routines/${routineId}/runs`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
