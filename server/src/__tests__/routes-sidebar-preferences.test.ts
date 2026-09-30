import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { sidebarPreferencesRoutes } from "../routes/sidebar-preferences.js";

const mockService = vi.hoisted(() => ({
  get: vi.fn(),
  upsert: vi.fn(),
  reset: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  sidebarPreferencesService: () => mockService,
}));

const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const DEPT_1 = "22222222-2222-2222-2222-222222222222";
const DEPT_2 = "33333333-3333-3333-3333-333333333333";
const PROJ_1 = "44444444-4444-4444-4444-444444444444";

function createApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", sidebarPreferencesRoutes({} as any));
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

describe("sidebar preferences routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET returns current user's sidebar preferences for a company", async () => {
    mockService.get.mockResolvedValue({
      departmentOrder: [DEPT_1, DEPT_2],
      projectOrder: [PROJ_1],
      updatedAt: new Date("2026-04-20T00:00:00Z"),
    });
    const app = createApp(boardActor());
    const res = await request(app).get(`/api/companies/${COMPANY_A}/sidebar-preferences/me`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.departmentOrder).toEqual([DEPT_1, DEPT_2]);
    expect(res.body.projectOrder).toEqual([PROJ_1]);
    expect(mockService.get).toHaveBeenCalledWith("user-1", COMPANY_A);
  });

  it("GET rejects non-board actors", async () => {
    const app = createApp({ type: "none", source: "none" });
    const res = await request(app).get(`/api/companies/${COMPANY_A}/sidebar-preferences/me`);
    expect(res.status).toBe(401);
  });

  it("GET forbids access to a company the user does not belong to", async () => {
    const app = createApp(boardActor({ companyIds: ["55555555-5555-5555-5555-555555555555"] }));
    const res = await request(app).get(`/api/companies/${COMPANY_A}/sidebar-preferences/me`);
    expect(res.status).toBe(403);
    expect(mockService.get).not.toHaveBeenCalled();
  });

  it("PATCH persists departmentOrder", async () => {
    mockService.upsert.mockResolvedValue({
      departmentOrder: [DEPT_2, DEPT_1],
      projectOrder: [],
      updatedAt: new Date(),
    });
    const app = createApp(boardActor());
    const res = await request(app)
      .patch(`/api/companies/${COMPANY_A}/sidebar-preferences/me`)
      .send({ departmentOrder: [DEPT_2, DEPT_1] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.departmentOrder).toEqual([DEPT_2, DEPT_1]);
    expect(mockService.upsert).toHaveBeenCalledWith("user-1", COMPANY_A, { departmentOrder: [DEPT_2, DEPT_1] });
  });

  it("PATCH persists projectOrder and departmentOrder together", async () => {
    mockService.upsert.mockResolvedValue({
      departmentOrder: [DEPT_1],
      projectOrder: [PROJ_1],
      updatedAt: new Date(),
    });
    const app = createApp(boardActor());
    const res = await request(app)
      .patch(`/api/companies/${COMPANY_A}/sidebar-preferences/me`)
      .send({ departmentOrder: [DEPT_1], projectOrder: [PROJ_1] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockService.upsert).toHaveBeenCalledWith("user-1", COMPANY_A, {
      departmentOrder: [DEPT_1],
      projectOrder: [PROJ_1],
    });
  });

  it("PATCH rejects non-UUID ids with 400", async () => {
    const app = createApp(boardActor());
    const res = await request(app)
      .patch(`/api/companies/${COMPANY_A}/sidebar-preferences/me`)
      .send({ departmentOrder: ["not-a-uuid"] });
    expect(res.status).toBe(400);
    expect(mockService.upsert).not.toHaveBeenCalled();
  });

  it("PATCH rejects unknown fields (strict)", async () => {
    const app = createApp(boardActor());
    const res = await request(app)
      .patch(`/api/companies/${COMPANY_A}/sidebar-preferences/me`)
      .send({ collapsed: true });
    expect(res.status).toBe(400);
  });

  it("POST /reset clears order for current user + company", async () => {
    mockService.reset.mockResolvedValue({
      departmentOrder: [],
      projectOrder: [],
      updatedAt: new Date(),
    });
    const app = createApp(boardActor());
    const res = await request(app).post(`/api/companies/${COMPANY_A}/sidebar-preferences/me/reset`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.departmentOrder).toEqual([]);
    expect(res.body.projectOrder).toEqual([]);
    expect(mockService.reset).toHaveBeenCalledWith("user-1", COMPANY_A);
  });
});
