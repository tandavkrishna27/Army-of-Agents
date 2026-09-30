import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../routes/authz.js", () => ({
  assertCompanyAccess: () => undefined,
  getActorInfo: () => ({ userId: "u-1", actorType: "user" }),
}));
vi.mock("../middleware/rbac.js", () => ({
  assertRole: async () => undefined,
}));
// Stub the service module to break the drizzle-orm ESM cycle
vi.mock("../services/memory-folders.js", () => ({
  memoryFoldersService: vi.fn(() => ({})),
}));

import { memoryFoldersRoutes } from "../routes/memory-folders.js";

function buildApp(mockSvc: unknown) {
  const app = express();
  app.use(express.json());
  app.use(memoryFoldersRoutes({ svc: mockSvc as never }));
  return app;
}

describe("memory-folders routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("GET /companies/:cid/memory/folders returns the list", async () => {
    const svc = {
      list: vi.fn(async () => [{ id: "f-1", path: "Engineering/Decisions" }]),
    };
    const app = buildApp(svc);
    const res = await request(app).get("/companies/co-1/memory/folders");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: "f-1", path: "Engineering/Decisions" }]);
    expect(svc.list).toHaveBeenCalledWith({ companyId: "co-1", departmentId: undefined });
  });

  it("POST /companies/:cid/memory/folders creates a folder", async () => {
    const svc = {
      create: vi.fn(async (input: unknown) => ({ id: "f-new", ...(input as object) })),
    };
    const app = buildApp(svc);
    const res = await request(app)
      .post("/companies/co-1/memory/folders")
      .send({
        departmentId: "00000000-0000-0000-0000-000000000001",
        path: "Engineering/Decisions",
        displayName: "Decisions",
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe("f-new");
    expect(svc.create).toHaveBeenCalled();
  });

  it("POST rejects invalid path with 400", async () => {
    const svc = { create: vi.fn() };
    const app = buildApp(svc);
    const res = await request(app)
      .post("/companies/co-1/memory/folders")
      .send({
        departmentId: null,
        path: "/Engineering",
        displayName: "Decisions",
      });
    expect(res.status).toBe(400);
    expect(svc.create).not.toHaveBeenCalled();
  });

  it("PATCH /companies/:cid/memory/folders/:id updates", async () => {
    const svc = {
      update: vi.fn(async () => ({ id: "f-1", path: "Engineering/Renamed" })),
    };
    const app = buildApp(svc);
    const res = await request(app)
      .patch("/companies/co-1/memory/folders/f-1")
      .send({ path: "Engineering/Renamed" });
    expect(res.status).toBe(200);
    expect(svc.update).toHaveBeenCalledWith("f-1", "co-1", { path: "Engineering/Renamed" });
  });

  it("PATCH returns 404 if service returns null", async () => {
    const svc = { update: vi.fn(async () => null) };
    const app = buildApp(svc);
    const res = await request(app)
      .patch("/companies/co-1/memory/folders/missing")
      .send({ displayName: "x" });
    expect(res.status).toBe(404);
  });

  it("DELETE /companies/:cid/memory/folders/:id removes", async () => {
    const svc = { remove: vi.fn(async () => undefined) };
    const app = buildApp(svc);
    const res = await request(app).delete("/companies/co-1/memory/folders/f-1");
    expect(res.status).toBe(204);
    expect(svc.remove).toHaveBeenCalledWith("f-1", "co-1");
  });
});
