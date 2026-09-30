import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { drizzleOperatorStubs, makeTableProxy } from "./helpers/drizzle-mock.js";

const { mockService, mockLogActivity } = vi.hoisted(() => ({
  mockService: {
    getById: vi.fn(),
    create: vi.fn(),
  },
  mockLogActivity: vi.fn(),
}));

vi.mock("drizzle-orm", () => drizzleOperatorStubs());
vi.mock("@armyofagents/db", () => ({
  companies: makeTableProxy("companies"),
}));
vi.mock("../services/index.js", () => ({
  assetService: () => mockService,
  logActivity: mockLogActivity,
}));

import { assetRoutes } from "../routes/assets.js";

const companyId = "company-1";
const assetId = "asset-1";

const storageStub = {} as never;

function makeApp(actor: Express.Request["actor"] = {
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
  app.use("/api", assetRoutes({} as never, storageStub));
  app.use((err: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "Internal Server Error" });
  });
  return app;
}

function assetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: assetId,
    companyId,
    provider: "local",
    objectKey: "objects/asset-1.bin",
    contentType: "text/markdown",
    byteSize: 1234,
    sha256: "deadbeef",
    originalFilename: "plan.md",
    createdByAgentId: null,
    createdByUserId: "user-1",
    createdAt: new Date("2026-07-19T00:00:00.000Z"),
    updatedAt: new Date("2026-07-19T00:00:00.000Z"),
    ...overrides,
  };
}

describe("GET /assets/:assetId/meta", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns presentation-safe metadata for an accessible asset", async () => {
    mockService.getById.mockResolvedValue(assetRow());
    const app = makeApp();

    const res = await request(app).get(`/api/assets/${assetId}/meta`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: assetId,
      originalFilename: "plan.md",
      contentType: "text/markdown",
      byteSize: 1234,
      createdAt: "2026-07-19T00:00:00.000Z",
    });
    // Never leak storage internals.
    expect(res.body.objectKey).toBeUndefined();
    expect(res.body.sha256).toBeUndefined();
    expect(mockService.getById).toHaveBeenCalledWith(assetId);
  });

  it("returns 404 when the asset does not exist", async () => {
    mockService.getById.mockResolvedValue(null);
    const app = makeApp();

    const res = await request(app).get(`/api/assets/${assetId}/meta`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Asset not found");
  });

  it("blocks an agent from reading another company's asset (403)", async () => {
    mockService.getById.mockResolvedValue(assetRow({ companyId: "other-company" }));
    const app = makeApp({ type: "agent", companyId, agentId: "agent-1", runId: null });

    const res = await request(app).get(`/api/assets/${assetId}/meta`);

    expect(res.status).toBe(403);
  });
});
