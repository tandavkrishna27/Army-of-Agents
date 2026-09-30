import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routineRoutes } from "../routes/routines.js";
import { errorHandler } from "../middleware/index.js";
import { HttpError } from "../errors.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const agentId = "11111111-1111-4111-8111-111111111111";
const routineId = "33333333-3333-4333-8333-333333333333";
const projectId = "44444444-4444-4444-8444-444444444444";
const revisionId = "77777777-7777-4777-8777-777777777777";

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

const revision = {
  id: revisionId,
  routineId,
  snapshot: { title: "Daily routine", description: null },
  createdByAgentId: null,
  createdByUserId: "board-user",
  createdAt: new Date("2026-03-20T00:00:00.000Z"),
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
  listRevisions: vi.fn(),
  restoreRevision: vi.fn(),
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

const boardActor = {
  type: "board",
  userId: "board-user",
  source: "session",
  isInstanceAdmin: false,
  companyIds: [companyId],
};

describe("GET /routines/:id/revisions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRoutineService.get.mockResolvedValue(routine);
    mockRoutineService.listRevisions.mockResolvedValue([revision]);
    mockAccessService.canUser.mockResolvedValue(true);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("returns 200 with revisions list when routine exists", async () => {
    const app = createApp(boardActor);

    const res = await request(app).get(`/api/routines/${routineId}/revisions`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(revisionId);
    expect(mockRoutineService.listRevisions).toHaveBeenCalledWith(routineId, companyId);
  });

  it("returns 404 when routine not found", async () => {
    mockRoutineService.get.mockResolvedValue(null);
    const app = createApp(boardActor);

    const res = await request(app).get(`/api/routines/${routineId}/revisions`);

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("Routine not found");
    expect(mockRoutineService.listRevisions).not.toHaveBeenCalled();
  });
});

describe("POST /routines/:id/revisions/restore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRoutineService.get.mockResolvedValue(routine);
    mockRoutineService.restoreRevision.mockResolvedValue(routine);
    mockAccessService.canUser.mockResolvedValue(true);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("returns 200 with updated routine when revision exists", async () => {
    const app = createApp(boardActor);

    const res = await request(app)
      .post(`/api/routines/${routineId}/revisions/restore`)
      .send({ revisionId, baseRevisionId: null });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(routineId);
    expect(mockRoutineService.restoreRevision).toHaveBeenCalledWith(
      routineId,
      revisionId,
      null,
      expect.objectContaining({ userId: "board-user", agentId: null }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "routine.restored",
        entityType: "routine",
        entityId: routineId,
        details: expect.objectContaining({ revisionId }),
      }),
    );
  });

  it("accepts legacy restore requests without a base revision token", async () => {
    const app = createApp(boardActor);

    const res = await request(app)
      .post(`/api/routines/${routineId}/revisions/restore`)
      .send({ revisionId });

    expect(res.status).toBe(200);
    expect(mockRoutineService.restoreRevision).toHaveBeenCalledWith(
      routineId,
      revisionId,
      undefined,
      expect.objectContaining({ userId: "board-user", agentId: null }),
    );
  });

  it("returns 404 when routine not found", async () => {
    mockRoutineService.get.mockResolvedValue(null);
    const app = createApp(boardActor);

    const res = await request(app)
      .post(`/api/routines/${routineId}/revisions/restore`)
      .send({ revisionId, baseRevisionId: null });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("Routine not found");
    expect(mockRoutineService.restoreRevision).not.toHaveBeenCalled();
  });

  it("returns 404 when revision not found (service returns null)", async () => {
    mockRoutineService.restoreRevision.mockResolvedValue(null);
    const app = createApp(boardActor);

    const res = await request(app)
      .post(`/api/routines/${routineId}/revisions/restore`)
      .send({ revisionId, baseRevisionId: null });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("Revision not found");
  });

  it("rejects an agent restoring a revision", async () => {
    const app = createApp({ type: "agent", agentId, companyId });

    const res = await request(app)
      .post(`/api/routines/${routineId}/revisions/restore`)
      .send({ revisionId, baseRevisionId: null });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Only human operators");
    expect(mockRoutineService.restoreRevision).not.toHaveBeenCalled();
  });

  it("returns 400 when revisionId is missing from body", async () => {
    const app = createApp(boardActor);

    const res = await request(app)
      .post(`/api/routines/${routineId}/revisions/restore`)
      .send({});

    expect(res.status).toBe(400);
    expect(mockRoutineService.restoreRevision).not.toHaveBeenCalled();
  });
});

describe("PATCH /routines/:id with stale baseRevisionId returns 409", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRoutineService.get.mockResolvedValue(routine);
    mockAccessService.canUser.mockResolvedValue(true);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("returns 409 when baseRevisionId is stale", async () => {
    mockRoutineService.update.mockRejectedValue(
      new HttpError(409, "Routine has been modified since your last load. Reload and retry."),
    );
    const app = createApp(boardActor);

    const staleRevisionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const res = await request(app)
      .patch(`/api/routines/${routineId}`)
      .send({ title: "Updated", baseRevisionId: staleRevisionId });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("modified since your last load");
  });
});
