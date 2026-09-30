import express from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";

const getById = vi.fn();
const approve = vi.fn();
const reject = vi.fn();
const requestRevision = vi.fn();
const create = vi.fn();
const resubmit = vi.fn();
const {
  emitHubItem,
  reconcile,
  buildApprovalHubEmit,
} = vi.hoisted(() => ({
  emitHubItem: vi.fn(),
  reconcile: vi.fn(),
  buildApprovalHubEmit: vi.fn((approval) => ({ sourceType: "approval", sourceId: approval.id })),
}));

vi.mock("../services/index.js", () => ({
  approvalService: () => ({
    getById,
    approve,
    reject,
    requestRevision,
    list: vi.fn(),
    listComments: vi.fn(),
    addComment: vi.fn(),
    resubmit,
    create,
  }),
  issueApprovalService: () => ({ listIssuesForApproval: vi.fn().mockResolvedValue([]) }),
  trustScoreService: () => ({ updateOnReview: vi.fn() }),
  heartbeatService: () => ({ wakeup: vi.fn().mockResolvedValue(null) }),
  secretService: () => ({
    normalizeHireApprovalPayloadForPersistence: vi.fn(),
  }),
  logActivity: vi.fn(),
}));

vi.mock("../services/hub-source-producers.js", () => ({
  buildApprovalHubEmit,
  emitHubItem,
}));

vi.mock("../services/hub-items.js", () => ({
  hubItemsService: () => ({
    reconcile,
  }),
}));

import { approvalRoutes } from "../routes/approvals.js";
import { errorHandler } from "../middleware/error-handler.js";

function makeApp(actor: any) {
  const app = express();
  const db = {
    transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback({ __tx: true })),
  };
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", approvalRoutes(db as any));
  app.use(errorHandler);
  return app;
}

const companyAActor = {
  type: "board",
  source: "session",
  userId: "user-A",
  companyIds: ["company-A"],
  isInstanceAdmin: false,
};
const companyBActor = { ...companyAActor, userId: "user-B", companyIds: ["company-B"] };

describe("/approvals cross-tenant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    emitHubItem.mockResolvedValue({ id: "hub-1", version: 0 });
    reconcile.mockResolvedValue({ healed: 1, closed: 1, refreshed: 0 });
  });

  it("403 when companyA user tries to approve a companyB approval", async () => {
    getById.mockResolvedValue({
      id: "ap1",
      companyId: "company-B",
      status: "pending",
      type: "test",
      requestedByAgentId: null,
    });
    const app = makeApp(companyAActor);
    const res = await request(app).post("/api/approvals/ap1/approve").send({});
    expect(res.status).toBe(403);
    expect(approve).not.toHaveBeenCalled();
  });

  it("403 cross-tenant on /reject", async () => {
    getById.mockResolvedValue({
      id: "ap1",
      companyId: "company-B",
      status: "pending",
      type: "test",
      requestedByAgentId: null,
    });
    const app = makeApp(companyAActor);
    const res = await request(app).post("/api/approvals/ap1/reject").send({});
    expect(res.status).toBe(403);
    expect(reject).not.toHaveBeenCalled();
  });

  it("403 cross-tenant on /request-revision", async () => {
    getById.mockResolvedValue({
      id: "ap1",
      companyId: "company-B",
      status: "pending",
      type: "test",
      requestedByAgentId: null,
    });
    const app = makeApp(companyAActor);
    const res = await request(app).post("/api/approvals/ap1/request-revision").send({});
    expect(res.status).toBe(403);
    expect(requestRevision).not.toHaveBeenCalled();
  });

  it("404 on unknown approval id", async () => {
    getById.mockResolvedValue(null);
    const app = makeApp(companyAActor);
    const res = await request(app).post("/api/approvals/missing/approve").send({});
    expect(res.status).toBe(404);
  });

  it("200 same-company; decidedByUserId derived from actor", async () => {
    getById.mockResolvedValue({
      id: "ap1",
      companyId: "company-A",
      status: "pending",
      requestedByAgentId: null,
      type: "test",
    });
    approve.mockResolvedValue({
      id: "ap1",
      companyId: "company-A",
      status: "approved",
      type: "test",
      requestedByAgentId: null,
      payload: {},
    });
    const app = makeApp(companyAActor);
    const res = await request(app).post("/api/approvals/ap1/approve").send({ decisionNote: "ok" });
    expect(res.status).toBe(200);
    // companyId is now threaded through as the second arg (defense-in-depth
    // for the service-layer companyId WHERE clause).
    expect(approve).toHaveBeenCalledWith("ap1", "company-A", "user-A", "ok");
  });

  it("emits a hub item when an approval is created", async () => {
    create.mockResolvedValue({
      id: "ap-created",
      companyId: "company-A",
      status: "pending",
      type: "hire_agent",
      requestedByAgentId: null,
      requestedByUserId: "user-A",
      payload: { name: "Scout" },
      updatedAt: new Date("2026-06-29T00:00:00Z"),
    });
    const app = makeApp(companyAActor);

    const res = await request(app)
      .post("/api/companies/company-A/approvals")
      .send({ type: "hire_agent", payload: { name: "Scout" } });

    expect(res.status).toBe(201);
    expect(buildApprovalHubEmit).toHaveBeenCalledWith(expect.objectContaining({ id: "ap-created" }));
    expect(emitHubItem).toHaveBeenCalledWith(expect.anything(), { sourceType: "approval", sourceId: "ap-created" });
  });

  it("reconciles approval hub rows after terminal approval decisions", async () => {
    getById.mockResolvedValue({
      id: "ap1",
      companyId: "company-A",
      status: "pending",
      requestedByAgentId: null,
      type: "test",
    });
    approve.mockResolvedValue({
      id: "ap1",
      companyId: "company-A",
      status: "approved",
      type: "test",
      requestedByAgentId: null,
      payload: {},
    });
    const app = makeApp(companyAActor);

    const res = await request(app).post("/api/approvals/ap1/approve").send({ decisionNote: "ok" });

    expect(res.status).toBe(200);
    expect(reconcile).toHaveBeenCalledWith("company-A", { sourceType: "approval", sourceId: "ap1" });
  });

  it("400 when body contains decidedByUserId (strict schema rejects)", async () => {
    const app = makeApp(companyAActor);
    const res = await request(app)
      .post("/api/approvals/ap1/approve")
      .send({ decisionNote: "ok", decidedByUserId: "alice@evil.com" });
    expect(res.status).toBe(400);
  });
});
