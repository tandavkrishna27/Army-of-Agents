import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { userNoteRoutes } from "../routes/user-notes.js";

const mockService = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  userNotesService: () => mockService,
}));

const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const NOTE_ID = "22222222-2222-2222-2222-222222222222";

function createApp(actor: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", userNoteRoutes({} as any));
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

function fakeNote(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: NOTE_ID,
    companyId: COMPANY_A,
    userId: "user-1",
    title: "Daily triage",
    body: "Check approvals before standup",
    color: "yellow",
    createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z",
    ...overrides,
  };
}

describe("user note routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET returns current user's company notes", async () => {
    mockService.list.mockResolvedValue([fakeNote()]);
    const app = createApp(boardActor());

    const res = await request(app).get(`/api/companies/${COMPANY_A}/user-notes`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(mockService.list).toHaveBeenCalledWith(COMPANY_A, "user-1");
  });

  it("GET rejects non-board actors", async () => {
    const app = createApp({ type: "none", source: "none" });

    const res = await request(app).get(`/api/companies/${COMPANY_A}/user-notes`);

    expect(res.status).toBe(401);
    expect(mockService.list).not.toHaveBeenCalled();
  });

  it("GET forbids access outside the user's companies", async () => {
    const app = createApp(boardActor({ companyIds: ["55555555-5555-5555-5555-555555555555"] }));

    const res = await request(app).get(`/api/companies/${COMPANY_A}/user-notes`);

    expect(res.status).toBe(403);
    expect(mockService.list).not.toHaveBeenCalled();
  });

  it("POST creates a note and returns 201", async () => {
    mockService.create.mockResolvedValue(fakeNote({ body: "Remember launch tasks", color: "blue" }));
    const app = createApp(boardActor());

    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/user-notes`)
      .send({ body: "Remember launch tasks", color: "blue" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.body).toBe("Remember launch tasks");
    expect(mockService.create).toHaveBeenCalledWith(
      COMPANY_A,
      "user-1",
      expect.objectContaining({ body: "Remember launch tasks", color: "blue" }),
    );
  });

  it("POST rejects unknown fields", async () => {
    const app = createApp(boardActor());

    const res = await request(app)
      .post(`/api/companies/${COMPANY_A}/user-notes`)
      .send({ body: "note", extra: true });

    expect(res.status).toBe(400);
    expect(mockService.create).not.toHaveBeenCalled();
  });

  it("PATCH updates a current user's note", async () => {
    mockService.update.mockResolvedValue(fakeNote({ body: "Updated", color: "green" }));
    const app = createApp(boardActor());

    const res = await request(app)
      .patch(`/api/companies/${COMPANY_A}/user-notes/${NOTE_ID}`)
      .send({ body: "Updated", color: "green" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.body).toBe("Updated");
    expect(mockService.update).toHaveBeenCalledWith(
      COMPANY_A,
      "user-1",
      NOTE_ID,
      expect.objectContaining({ body: "Updated", color: "green" }),
    );
  });

  it("PATCH rejects empty bodies", async () => {
    const app = createApp(boardActor());

    const res = await request(app)
      .patch(`/api/companies/${COMPANY_A}/user-notes/${NOTE_ID}`)
      .send({});

    expect(res.status).toBe(400);
    expect(mockService.update).not.toHaveBeenCalled();
  });

  it("DELETE archives a current user's note", async () => {
    mockService.archive.mockResolvedValue(undefined);
    const app = createApp(boardActor());

    const res = await request(app).delete(`/api/companies/${COMPANY_A}/user-notes/${NOTE_ID}`);

    expect(res.status).toBe(204);
    expect(mockService.archive).toHaveBeenCalledWith(COMPANY_A, "user-1", NOTE_ID);
  });
});
