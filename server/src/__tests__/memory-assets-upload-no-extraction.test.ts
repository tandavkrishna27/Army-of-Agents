import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Mock storage and dependencies before importing the route module.
const createJobMock = vi.fn();
const assetCreateMock = vi.fn();
const storageUploadMock = vi.fn();

vi.mock("../routes/authz.js", () => ({
  assertCompanyAccess: () => undefined,
  getActorInfo: () => ({ actorId: "user-1" }),
}));

vi.mock("../middleware/rbac.js", () => ({
  assertRole: async () => undefined,
}));

vi.mock("../services/file-import.js", () => ({
  fileImportService: vi.fn(() => ({
    createJob: createJobMock,
  })),
}));

// The route reads the upload allowlist from memory-asset-upload-types.ts,
// which sources SUPPORTED_MIME_TYPES from the dependency-free
// file-import-mime-types.ts — NOT from file-import.js. The SUPPORTED_MIME_TYPES
// export above was dead: the route never imports it, so this suite silently
// exercised the REAL allowlist and only passed because the real list is a
// superset of this one.
vi.mock("../services/file-import-mime-types.js", () => ({
  SUPPORTED_MIME_TYPES: ["text/plain", "application/pdf"],
}));

vi.mock("../services/memory-assets.js", () => ({
  memoryAssetsService: vi.fn(() => ({
    create: assetCreateMock,
  })),
}));

const mockStorage = {
  putFile: storageUploadMock,
};

beforeEach(() => {
  createJobMock.mockClear();
  assetCreateMock.mockClear();
  storageUploadMock.mockClear();
  storageUploadMock.mockResolvedValue({ objectKey: "obj-key-123", byteSize: 5, sha256: "abc" });
  assetCreateMock.mockResolvedValue({
    id: "asset-1",
    importJobId: null,
    fileName: "test.txt",
  });
});

describe("memory-assets-upload route — Phase 6.2e (no auto-extraction)", () => {
  it("does NOT call fileImport.createJob on upload", async () => {
    const { memoryAssetsUploadRoutes } = await import("../routes/memory-assets-upload.js");
    const app = express();
    app.use(memoryAssetsUploadRoutes({ storageService: mockStorage as never }));

    const res = await request(app)
      .post("/companies/co-1/memory/assets/upload")
      .field("departmentId", "d-eng")
      .attach("file", Buffer.from("hello world"), {
        filename: "test.txt",
        contentType: "text/plain",
      });

    expect(res.status).toBe(201);
    expect(createJobMock).not.toHaveBeenCalled();
  });

  it("creates the asset with importJobId set to null", async () => {
    const { memoryAssetsUploadRoutes } = await import("../routes/memory-assets-upload.js");
    const app = express();
    app.use(memoryAssetsUploadRoutes({ storageService: mockStorage as never }));

    await request(app)
      .post("/companies/co-1/memory/assets/upload")
      .field("departmentId", "d-eng")
      .attach("file", Buffer.from("hello"), {
        filename: "test.txt",
        contentType: "text/plain",
      });

    expect(assetCreateMock).toHaveBeenCalled();
    const createArgs = assetCreateMock.mock.calls[0][0];
    expect(createArgs.importJobId).toBeNull();
    expect(createArgs.fileName).toBe("test.txt");
  });

  it("returns the asset without a jobId in the response", async () => {
    const { memoryAssetsUploadRoutes } = await import("../routes/memory-assets-upload.js");
    const app = express();
    app.use(memoryAssetsUploadRoutes({ storageService: mockStorage as never }));

    const res = await request(app)
      .post("/companies/co-1/memory/assets/upload")
      .field("departmentId", "d-eng")
      .attach("file", Buffer.from("test"), {
        filename: "test.txt",
        contentType: "text/plain",
      });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(expect.objectContaining({ asset: expect.any(Object) }));
    expect(res.body.jobId).toBeUndefined();
  });
});
