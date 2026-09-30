import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { homeBoardLayoutRoutes } from "../routes/home-board-layout.js";

const mockService = vi.hoisted(() => ({
  get: vi.fn(),
  upsert: vi.fn(),
  reset: vi.fn(),
}));

vi.mock("../services/home-board-layout.js", () => ({
  homeBoardLayoutService: () => mockService,
}));

const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const COMPANY_B = "55555555-5555-5555-5555-555555555555";

const VALID_LAYOUT = [{ i: "budget", x: 0, y: 0, w: 1, h: 1 }];
const OVERSIZE_LAYOUT = [{ i: "agents-now", x: 0, y: 0, w: 2, h: 2 }];
const UNKNOWN_KEY_LAYOUT = [{ i: "not-a-widget", x: 0, y: 0, w: 1, h: 1 }];
const OVERLAPPING_LAYOUT = [
  { i: "agents-now", x: 0, y: 0, w: 1, h: 1 },
  { i: "budget", x: 0, y: 0, w: 1, h: 1 },
];

function createApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", homeBoardLayoutRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function boardActor(
  overrides: Partial<{
    userId: string | undefined;
    companyIds: string[];
    isInstanceAdmin: boolean;
    source: string;
  }> = {},
) {
  return {
    type: "board" as const,
    userId: "userId" in overrides ? overrides.userId : "user-1",
    source: overrides.source ?? "session",
    companyIds: overrides.companyIds ?? [COMPANY_A],
    isInstanceAdmin: overrides.isInstanceAdmin ?? false,
  };
}

function agentActor(companyId: string) {
  return { type: "agent" as const, source: "agent-key", companyId, agentId: "agent-1" };
}

function mcpActor(companyId: string) {
  return { type: "mcp" as const, source: "mcp-key", companyId };
}

describe("home board layout routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET returns the current user's layout for a company", async () => {
    mockService.get.mockResolvedValue({ layout: VALID_LAYOUT, schemaVersion: 1 });
    const app = createApp(boardActor());
    const res = await request(app).get(`/api/companies/${COMPANY_A}/home-board-layout/me`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ layout: VALID_LAYOUT, schemaVersion: 1 });
    expect(mockService.get).toHaveBeenCalledWith("user-1", COMPANY_A);
  });

  it("GET returns null for a fresh user with no saved layout", async () => {
    mockService.get.mockResolvedValue(null);
    const app = createApp(boardActor());
    const res = await request(app).get(`/api/companies/${COMPANY_A}/home-board-layout/me`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toBeNull();
  });

  it("GET rejects an unauthenticated (none) actor with 401", async () => {
    const app = createApp({ type: "none", source: "none" });
    const res = await request(app).get(`/api/companies/${COMPANY_A}/home-board-layout/me`);
    expect(res.status).toBe(401);
    expect(mockService.get).not.toHaveBeenCalled();
  });

  it("GET rejects a board session with no userId with 401", async () => {
    const app = createApp(boardActor({ userId: undefined }));
    const res = await request(app).get(`/api/companies/${COMPANY_A}/home-board-layout/me`);
    expect(res.status).toBe(401);
    expect(mockService.get).not.toHaveBeenCalled();
  });

  it("GET forbids access to a company the user does not belong to (403)", async () => {
    const app = createApp(boardActor({ companyIds: [COMPANY_B] }));
    const res = await request(app).get(`/api/companies/${COMPANY_A}/home-board-layout/me`);
    expect(res.status).toBe(403);
    expect(mockService.get).not.toHaveBeenCalled();
  });

  it("GET rejects an agent actor with 403 (board-only)", async () => {
    const app = createApp(agentActor(COMPANY_A));
    const res = await request(app).get(`/api/companies/${COMPANY_A}/home-board-layout/me`);
    expect(res.status).toBe(403);
    expect(mockService.get).not.toHaveBeenCalled();
  });

  it("GET rejects an mcp actor with 403 (board-only)", async () => {
    const app = createApp(mcpActor(COMPANY_A));
    const res = await request(app).get(`/api/companies/${COMPANY_A}/home-board-layout/me`);
    expect(res.status).toBe(403);
    expect(mockService.get).not.toHaveBeenCalled();
  });

  it("PATCH persists a valid layout and returns it", async () => {
    mockService.upsert.mockResolvedValue({ layout: VALID_LAYOUT, schemaVersion: 1 });
    const app = createApp(boardActor());
    const res = await request(app)
      .patch(`/api/companies/${COMPANY_A}/home-board-layout/me`)
      .send({ layout: VALID_LAYOUT });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ layout: VALID_LAYOUT, schemaVersion: 1 });
    expect(mockService.upsert).toHaveBeenCalledWith("user-1", COMPANY_A, VALID_LAYOUT);
  });

  it("PATCH rejects a body with a client-supplied userId (400, .strict())", async () => {
    const app = createApp(boardActor());
    const res = await request(app)
      .patch(`/api/companies/${COMPANY_A}/home-board-layout/me`)
      .send({ layout: VALID_LAYOUT, userId: "someone-else" });
    expect(res.status).toBe(400);
    expect(mockService.upsert).not.toHaveBeenCalled();
  });

  it("PATCH rejects a body with a client-supplied schemaVersion (400, .strict())", async () => {
    const app = createApp(boardActor());
    const res = await request(app)
      .patch(`/api/companies/${COMPANY_A}/home-board-layout/me`)
      .send({ layout: VALID_LAYOUT, schemaVersion: 99 });
    expect(res.status).toBe(400);
    expect(mockService.upsert).not.toHaveBeenCalled();
  });

  it("PATCH rejects an oversize (disallowed-size) footprint with 400", async () => {
    const app = createApp(boardActor());
    const res = await request(app)
      .patch(`/api/companies/${COMPANY_A}/home-board-layout/me`)
      .send({ layout: OVERSIZE_LAYOUT });
    expect(res.status).toBe(400);
    expect(mockService.upsert).not.toHaveBeenCalled();
  });

  it("PATCH rejects an unknown widget key with 400", async () => {
    const app = createApp(boardActor());
    const res = await request(app)
      .patch(`/api/companies/${COMPANY_A}/home-board-layout/me`)
      .send({ layout: UNKNOWN_KEY_LAYOUT });
    expect(res.status).toBe(400);
    expect(mockService.upsert).not.toHaveBeenCalled();
  });

  it("PATCH rejects overlapping items with 400", async () => {
    const app = createApp(boardActor());
    const res = await request(app)
      .patch(`/api/companies/${COMPANY_A}/home-board-layout/me`)
      .send({ layout: OVERLAPPING_LAYOUT });
    expect(res.status).toBe(400);
    expect(mockService.upsert).not.toHaveBeenCalled();
  });

  it("PATCH rejects a cross-company request with 403", async () => {
    const app = createApp(boardActor({ companyIds: [COMPANY_B] }));
    const res = await request(app)
      .patch(`/api/companies/${COMPANY_A}/home-board-layout/me`)
      .send({ layout: VALID_LAYOUT });
    expect(res.status).toBe(403);
    expect(mockService.upsert).not.toHaveBeenCalled();
  });

  it("PATCH rejects an agent actor with 403", async () => {
    const app = createApp(agentActor(COMPANY_A));
    const res = await request(app)
      .patch(`/api/companies/${COMPANY_A}/home-board-layout/me`)
      .send({ layout: VALID_LAYOUT });
    expect(res.status).toBe(403);
    expect(mockService.upsert).not.toHaveBeenCalled();
  });

  it("POST /reset clears the layout, and a subsequent GET returns null", async () => {
    mockService.reset.mockResolvedValue(undefined);
    const app = createApp(boardActor());

    const resetRes = await request(app).post(`/api/companies/${COMPANY_A}/home-board-layout/me/reset`);
    expect(resetRes.status, JSON.stringify(resetRes.body)).toBe(200);
    expect(resetRes.body).toEqual({ ok: true });
    expect(mockService.reset).toHaveBeenCalledWith("user-1", COMPANY_A);

    mockService.get.mockResolvedValue(null);
    const getRes = await request(app).get(`/api/companies/${COMPANY_A}/home-board-layout/me`);
    expect(getRes.status, JSON.stringify(getRes.body)).toBe(200);
    expect(getRes.body).toBeNull();
  });

  it("POST /reset rejects a cross-company request with 403", async () => {
    const app = createApp(boardActor({ companyIds: [COMPANY_B] }));
    const res = await request(app).post(`/api/companies/${COMPANY_A}/home-board-layout/me/reset`);
    expect(res.status).toBe(403);
    expect(mockService.reset).not.toHaveBeenCalled();
  });
});
