import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { Readable } from "node:stream";

vi.mock("../routes/authz.js", () => ({
  assertCompanyAccess: () => undefined,
  getActorInfo: () => ({ userId: "u-1", actorType: "user" }),
}));
vi.mock("../middleware/rbac.js", () => ({
  assertRole: async () => undefined,
}));
// Stub the service module to break the drizzle-orm ESM cycle
vi.mock("../services/memory-assets.js", () => ({
  memoryAssetsService: vi.fn(() => ({})),
}));

import { memoryAssetsRoutes } from "../routes/memory-assets.js";

function buildApp(svc: unknown, storage: unknown) {
  const app = express();
  app.use(express.json());
  app.use(memoryAssetsRoutes({ svc: svc as never, storage: storage as never }));
  return app;
}

describe("memory-assets routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("GET /companies/:cid/memory/assets returns the list", async () => {
    const svc = {
      list: vi.fn(async () => [{ id: "a-1", fileName: "rfc.pdf" }]),
    };
    const app = buildApp(svc, {});
    const res = await request(app).get("/companies/co-1/memory/assets");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: "a-1", fileName: "rfc.pdf" }]);
  });

  it("GET /assets supports folderPath filter", async () => {
    const svc = { list: vi.fn(async () => []) };
    const app = buildApp(svc, {});
    await request(app).get(
      "/companies/co-1/memory/assets?folderPath=Engineering/Files&mimeType=application/pdf",
    );
    expect(svc.list).toHaveBeenCalledWith({
      companyId: "co-1",
      departmentId: undefined,
      folderPath: "Engineering/Files",
      mimeType: "application/pdf",
    });
  });

  it("GET /assets/:id returns a single asset", async () => {
    const svc = {
      get: vi.fn(async () => ({ id: "a-1", fileName: "rfc.pdf" })),
    };
    const app = buildApp(svc, {});
    const res = await request(app).get("/companies/co-1/memory/assets/a-1");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("a-1");
  });

  it("GET /assets/:id returns 404 when missing", async () => {
    const svc = { get: vi.fn(async () => null) };
    const app = buildApp(svc, {});
    const res = await request(app).get("/companies/co-1/memory/assets/missing");
    expect(res.status).toBe(404);
  });

  it("GET /assets/:id/content streams from StorageService", async () => {
    const svc = {
      get: vi.fn(async () => ({
        id: "a-1",
        fileName: "rfc.pdf",
        mimeType: "application/pdf",
        storageKey: "co-1/file-imports/abc-rfc.pdf",
      })),
    };
    const storage = {
      getObject: vi.fn(async () => ({
        stream: Readable.from(["chunk1", "chunk2"]),
        contentLength: 12,
        lastModified: new Date(),
      })),
    };
    const app = buildApp(svc, storage);
    const res = await request(app).get("/companies/co-1/memory/assets/a-1/content");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(storage.getObject).toHaveBeenCalledWith(null, "co-1", "co-1/file-imports/abc-rfc.pdf");
  });

  it("PATCH /assets/:id updates fileName + folderPath", async () => {
    const svc = {
      update: vi.fn(async () => ({ id: "a-1", fileName: "new.pdf", folderPath: "Y/Z" })),
    };
    const app = buildApp(svc, {});
    const res = await request(app)
      .patch("/companies/co-1/memory/assets/a-1")
      .send({ fileName: "new.pdf", folderPath: "Y/Z" });
    expect(res.status).toBe(200);
    expect(svc.update).toHaveBeenCalledWith("a-1", "co-1", { fileName: "new.pdf", folderPath: "Y/Z" });
  });

  it("DELETE /assets/:id removes", async () => {
    const svc = { remove: vi.fn(async () => undefined) };
    const app = buildApp(svc, {});
    const res = await request(app).delete("/companies/co-1/memory/assets/a-1");
    expect(res.status).toBe(204);
  });
});
