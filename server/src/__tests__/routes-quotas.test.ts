import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { quotaRoutes } from "../routes/quotas.js";

const mockService = vi.hoisted(() => ({
  list: vi.fn(),
  refresh: vi.fn(),
  refreshAll: vi.fn(),
}));

vi.mock("../services/quota-windows.js", () => ({
  quotaWindowsService: () => mockService,
}));

const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const COMPANY_B = "55555555-5555-5555-5555-555555555555";

function createApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", quotaRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function boardActor(overrides: Partial<{ userId: string; companyIds: string[]; isInstanceAdmin: boolean; source: string }> = {}) {
  return {
    type: "board" as const,
    userId: overrides.userId ?? "user-1",
    source: overrides.source ?? "session",
    companyIds: overrides.companyIds ?? [COMPANY_A],
    isInstanceAdmin: overrides.isInstanceAdmin ?? false,
  };
}

describe("quota routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET /companies/:companyId/quotas returns list of snapshots", async () => {
    mockService.list.mockResolvedValue([
      {
        id: "w1",
        companyId: COMPANY_A,
        provider: "anthropic",
        model: "sonnet",
        windowKind: "5h",
        usedPercent: 42,
      },
    ]);
    const app = createApp(boardActor());
    const res = await request(app).get(`/api/companies/${COMPANY_A}/quotas`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].provider).toBe("anthropic");
    expect(mockService.list).toHaveBeenCalledWith(COMPANY_A);
  });

  it("GET forbids access to companies the user does not belong to", async () => {
    const app = createApp(boardActor({ companyIds: [COMPANY_B] }));
    const res = await request(app).get(`/api/companies/${COMPANY_A}/quotas`);
    expect(res.status).toBe(403);
    expect(mockService.list).not.toHaveBeenCalled();
  });

  it("GET rejects anonymous actors with 401", async () => {
    const app = createApp({ type: "none", source: "none" });
    const res = await request(app).get(`/api/companies/${COMPANY_A}/quotas`);
    expect(res.status).toBe(401);
    expect(mockService.list).not.toHaveBeenCalled();
  });

  it("POST /companies/:companyId/quotas/refresh without body triggers refreshAll", async () => {
    mockService.refreshAll.mockResolvedValue([
      { id: "w1", provider: "anthropic", windowKind: "5h" },
      { id: "w2", provider: "openai", windowKind: "Credits" },
    ]);
    const app = createApp(boardActor());
    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/quotas/refresh`)
      .send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    expect(mockService.refreshAll).toHaveBeenCalledWith(COMPANY_A);
    expect(mockService.refresh).not.toHaveBeenCalled();
  });

  it("POST /companies/:companyId/quotas/refresh with adapterType calls refresh for that adapter", async () => {
    mockService.refresh.mockResolvedValue([
      { id: "w1", provider: "anthropic", windowKind: "5h" },
    ]);
    const app = createApp(boardActor());
    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/quotas/refresh`)
      .send({ adapterType: "claude_local" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(mockService.refresh).toHaveBeenCalledWith(COMPANY_A, "claude_local");
    expect(mockService.refreshAll).not.toHaveBeenCalled();
  });

  it("POST refresh forbids cross-company access", async () => {
    const app = createApp(boardActor({ companyIds: [COMPANY_B] }));
    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/quotas/refresh`)
      .send({});
    expect(res.status).toBe(403);
    expect(mockService.refreshAll).not.toHaveBeenCalled();
  });
});
