import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { userEntityPinRoutes } from "../routes/user-entity-pins.js";

const mockService = vi.hoisted(() => ({
  list: vi.fn(),
  pin: vi.fn(),
  unpin: vi.fn(),
  entityExistsInCompany: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  userEntityPinService: () => mockService,
}));

const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const TASK_ID = "22222222-2222-2222-2222-222222222222";

function createApp(actor: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", userEntityPinRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function boardActor(
  overrides: Partial<{
    userId: string;
    companyIds: string[];
    isInstanceAdmin: boolean;
    source: string;
  }> = {},
) {
  return {
    type: "board" as const,
    userId: overrides.userId ?? "user-1",
    source: overrides.source ?? "session",
    companyIds: overrides.companyIds ?? [COMPANY_A],
    isInstanceAdmin: overrides.isInstanceAdmin ?? false,
  };
}

function fakePin(overrides: Partial<Record<string, unknown>> = {}) {
  const now = new Date("2026-06-15T00:00:00Z");
  return {
    id: "pin-1",
    userId: "user-1",
    companyId: COMPANY_A,
    entityType: "task",
    entityId: TASK_ID,
    pinnedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("user entity pin routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── GET /companies/:companyId/pins ──────────────────────────────────────────

  it("GET returns current user's pins for the company (200)", async () => {
    mockService.list.mockResolvedValue([fakePin(), fakePin({ id: "pin-2", entityType: "goal" })]);
    const app = createApp(boardActor());
    const res = await request(app).get(`/api/companies/${COMPANY_A}/pins`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(mockService.list).toHaveBeenCalledWith("user-1", COMPANY_A);
  });

  it("GET rejects non-board actors (401)", async () => {
    const app = createApp({ type: "none", source: "none" });
    const res = await request(app).get(`/api/companies/${COMPANY_A}/pins`);
    expect(res.status).toBe(401);
    expect(mockService.list).not.toHaveBeenCalled();
  });

  it("GET forbids access to a company the user does not belong to (403)", async () => {
    const app = createApp(boardActor({ companyIds: ["55555555-5555-5555-5555-555555555555"] }));
    const res = await request(app).get(`/api/companies/${COMPANY_A}/pins`);
    expect(res.status).toBe(403);
    expect(mockService.list).not.toHaveBeenCalled();
  });

  // ── POST /companies/:companyId/pins ─────────────────────────────────────────

  it("POST pins an entity and returns 201", async () => {
    mockService.entityExistsInCompany.mockResolvedValue(true);
    mockService.pin.mockResolvedValue(fakePin());
    const app = createApp(boardActor());
    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/pins`)
      .send({ entityType: "task", entityId: TASK_ID });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.entityType).toBe("task");
    expect(res.body.entityId).toBe(TASK_ID);
    expect(mockService.entityExistsInCompany).toHaveBeenCalledWith(COMPANY_A, "task", TASK_ID);
    expect(mockService.pin).toHaveBeenCalledWith("user-1", COMPANY_A, "task", TASK_ID);
  });

  it("POST returns 404 when entity does not exist in company", async () => {
    mockService.entityExistsInCompany.mockResolvedValue(false);
    const app = createApp(boardActor());
    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/pins`)
      .send({ entityType: "task", entityId: TASK_ID });
    expect(res.status).toBe(404);
    expect(mockService.pin).not.toHaveBeenCalled();
  });

  it("POST rejects invalid entityType with 400", async () => {
    const app = createApp(boardActor());
    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/pins`)
      .send({ entityType: "widget", entityId: TASK_ID });
    expect(res.status).toBe(400);
    expect(mockService.entityExistsInCompany).not.toHaveBeenCalled();
    expect(mockService.pin).not.toHaveBeenCalled();
  });

  it("POST rejects non-uuid entityId with 400", async () => {
    const app = createApp(boardActor());
    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/pins`)
      .send({ entityType: "task", entityId: "not-a-uuid" });
    expect(res.status).toBe(400);
    expect(mockService.entityExistsInCompany).not.toHaveBeenCalled();
    expect(mockService.pin).not.toHaveBeenCalled();
  });

  it("POST rejects unknown fields (strict) with 400", async () => {
    const app = createApp(boardActor());
    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/pins`)
      .send({ entityType: "task", entityId: TASK_ID, extra: true });
    expect(res.status).toBe(400);
  });

  it("POST rejects non-board actors (401)", async () => {
    const app = createApp({ type: "none", source: "none" });
    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/pins`)
      .send({ entityType: "task", entityId: TASK_ID });
    expect(res.status).toBe(401);
    expect(mockService.pin).not.toHaveBeenCalled();
  });

  it("POST forbids access to a company the user does not belong to (403)", async () => {
    const app = createApp(boardActor({ companyIds: ["55555555-5555-5555-5555-555555555555"] }));
    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/pins`)
      .send({ entityType: "task", entityId: TASK_ID });
    expect(res.status).toBe(403);
    expect(mockService.pin).not.toHaveBeenCalled();
  });

  it("POST accepts all 3 valid entity types", async () => {
    mockService.entityExistsInCompany.mockResolvedValue(true);
    mockService.pin.mockImplementation(async (_u, _c, entityType, entityId) =>
      fakePin({ entityType, entityId }),
    );
    const GOAL_ID = "33333333-3333-3333-3333-333333333333";
    const ARTIFACT_ID = "44444444-4444-4444-4444-444444444444";
    const app = createApp(boardActor());
    for (const [entityType, entityId] of [
      ["task", TASK_ID],
      ["artifact", ARTIFACT_ID],
      ["goal", GOAL_ID],
    ] as [string, string][]) {
      const res = await request(app)
        .post(`/api/companies/${COMPANY_A}/pins`)
        .send({ entityType, entityId });
      expect(res.status, `${entityType}: ${JSON.stringify(res.body)}`).toBe(201);
    }
  });

  // ── DELETE /companies/:companyId/pins/:entityType/:entityId ─────────────────

  it("DELETE unpins an entity and returns 204", async () => {
    mockService.unpin.mockResolvedValue(undefined);
    const app = createApp(boardActor());
    const res = await request(app).delete(
      `/api/companies/${COMPANY_A}/pins/task/${TASK_ID}`,
    );
    expect(res.status).toBe(204);
    expect(mockService.unpin).toHaveBeenCalledWith("user-1", COMPANY_A, "task", TASK_ID);
  });

  it("DELETE rejects non-board actors (401)", async () => {
    const app = createApp({ type: "none", source: "none" });
    const res = await request(app).delete(
      `/api/companies/${COMPANY_A}/pins/task/${TASK_ID}`,
    );
    expect(res.status).toBe(401);
    expect(mockService.unpin).not.toHaveBeenCalled();
  });

  it("DELETE forbids access to a company the user does not belong to (403)", async () => {
    const app = createApp(boardActor({ companyIds: ["55555555-5555-5555-5555-555555555555"] }));
    const res = await request(app).delete(
      `/api/companies/${COMPANY_A}/pins/task/${TASK_ID}`,
    );
    expect(res.status).toBe(403);
    expect(mockService.unpin).not.toHaveBeenCalled();
  });
});
