import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { drizzleOperatorStubs, makeTableProxy } from "./helpers/drizzle-mock.js";

const { mockService, mockBackfillService, mockLogActivity } = vi.hoisted(() => ({
  mockService: {
    listForIssue: vi.fn(),
    getById: vi.fn(),
    upsertForIssue: vi.fn(),
    updateMutable: vi.fn(),
  },
  mockBackfillService: {
    backfillIssueIfEmpty: vi.fn(),
  },
  mockLogActivity: vi.fn(),
}));

vi.mock("drizzle-orm", () => drizzleOperatorStubs());
vi.mock("@armyofagents/db", () => ({
  issues: makeTableProxy("issues"),
  taskOutputs: makeTableProxy("task_outputs"),
}));
vi.mock("../services/index.js", () => ({
  taskOutputService: () => mockService,
  taskOutputBackfillService: () => mockBackfillService,
  logActivity: mockLogActivity,
}));
vi.mock("../routes/issue-param-normalizer.js", () => ({
  registerIssueParamNormalizer: vi.fn(),
}));

import { taskOutputRoutes } from "../routes/task-outputs.js";

type MockRow = Record<string, unknown>;

const companyId = "company-1";
const issueId = "issue-1";
const outputId = "output-1";

function makeDb(selectRows: MockRow[][] = []) {
  let selectIdx = 0;
  const chain = () => {
    const obj: Record<string, unknown> = {};
    for (const method of ["from", "where"]) obj[method] = () => obj;
    obj.then = (resolve: (value: MockRow[]) => unknown) =>
      Promise.resolve(resolve(selectRows[selectIdx++] ?? []));
    return obj;
  };
  return { select: chain };
}

function makeApp(db: unknown, actor: Express.Request["actor"] = {
  type: "board",
  source: "local_implicit",
  userId: "board-user",
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", taskOutputRoutes(db as never));
  app.use((err: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "Internal Server Error" });
  });
  return app;
}

function outputRow(overrides: MockRow = {}) {
  return {
    id: outputId,
    companyId,
    issueId,
    projectId: "project-1",
    type: "preview_url",
    title: "Preview",
    url: "https://preview.example.test",
    status: "active",
    reviewState: "none",
    isPrimary: true,
    healthStatus: "ready",
    ...overrides,
  };
}

describe("taskOutputRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists outputs for a task after checking company access", async () => {
    const rows = [outputRow()];
    mockService.listForIssue.mockResolvedValue(rows);
    const app = makeApp(makeDb([[{ companyId }]]));

    const res = await request(app).get(`/api/issues/${issueId}/outputs`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(rows);
    expect(mockBackfillService.backfillIssueIfEmpty).toHaveBeenCalledWith(companyId, issueId);
    expect(mockService.listForIssue).toHaveBeenCalledWith(companyId, issueId);
  });

  it("creates a task output and logs the mutation", async () => {
    const created = outputRow({ type: "pull_request", title: "PR #42" });
    mockService.upsertForIssue.mockResolvedValue(created);
    const app = makeApp(makeDb([[{ companyId }]]));

    const res = await request(app)
      .post(`/api/issues/${issueId}/outputs`)
      .send({
        type: "pull_request",
        provider: "github",
        externalId: "pr-42",
        title: "PR #42",
        url: "https://github.com/acme/repo/pull/42",
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: outputId, title: "PR #42" });
    expect(mockService.upsertForIssue).toHaveBeenCalledWith(companyId, issueId, expect.objectContaining({
      type: "pull_request",
      provider: "github",
      externalId: "pr-42",
    }));
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId,
      action: "task_output.upserted",
      entityType: "task_output",
      entityId: outputId,
    }));
  });

  it("patches a mutable task output only after checking output company access", async () => {
    const updated = outputRow({ title: "Ready preview" });
    mockService.updateMutable.mockResolvedValue(updated);
    const app = makeApp(makeDb([[{ companyId }]]));

    const res = await request(app)
      .patch(`/api/task-outputs/${outputId}`)
      .send({ title: "Ready preview", reviewState: "approved" });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Ready preview");
    expect(mockService.updateMutable).toHaveBeenCalledWith(companyId, outputId, {
      title: "Ready preview",
      reviewState: "approved",
    });
  });

  it("blocks agent access to another company's task output", async () => {
    const app = makeApp(makeDb([[{ companyId: "other-company" }]]), {
      type: "agent",
      companyId,
      agentId: "agent-1",
      runId: null,
    });

    const res = await request(app)
      .patch(`/api/task-outputs/${outputId}`)
      .send({ title: "Nope" });

    expect(res.status).toBe(403);
    expect(mockService.updateMutable).not.toHaveBeenCalled();
  });
});
