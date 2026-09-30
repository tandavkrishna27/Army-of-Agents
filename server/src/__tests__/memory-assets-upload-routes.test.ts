import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ── Mocks (hoisted by vitest before any imports) ─────────────────────────────

vi.mock("../routes/authz.js", () => ({
  assertCompanyAccess: () => undefined,
  getActorInfo: () => ({ actorId: "u-1", actorType: "user" }),
}));

vi.mock("../middleware/rbac.js", () => ({
  assertRole: async () => undefined,
}));

// Stub service modules to break the drizzle-orm ESM cycle
const { mockAssetsCreate } = vi.hoisted(() => ({
  mockAssetsCreate: vi.fn().mockImplementation(async (input: unknown) => ({ id: "a-1", ...(input as object) })),
}));

// The route reads the upload allowlist from memory-asset-upload-types.ts,
// which sources SUPPORTED_MIME_TYPES from the dependency-free
// file-import-mime-types.ts — NOT from file-import.js (which the route no
// longer imports at all). Mocking file-import.js here was dead: the suite
// silently exercised the REAL allowlist and only passed because the real
// list is a superset of this one.
vi.mock("../services/file-import-mime-types.js", () => ({
  SUPPORTED_MIME_TYPES: [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/plain",
  ],
}));

vi.mock("../services/memory-assets.js", () => ({
  memoryAssetsService: vi.fn(() => ({
    create: mockAssetsCreate,
  })),
}));

// ── Test helpers ─────────────────────────────────────────────────────────────

const mockStorage = {
  putFile: vi.fn().mockResolvedValue({
    objectKey: "co-1/file-imports/abc-x.pdf",
    size: 12,
    sha256: "deadbeef",
  }),
};

async function buildApp() {
  const { memoryAssetsUploadRoutes } = await import("../routes/memory-assets-upload.js");
  const app = express();
  app.use(express.json());
  app.use(memoryAssetsUploadRoutes({ storageService: mockStorage as never }));
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("memory-assets upload route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssetsCreate.mockImplementation(async (input: unknown) => ({ id: "a-1", ...(input as object) }));
    mockStorage.putFile.mockResolvedValue({
      objectKey: "co-1/file-imports/abc-x.pdf",
      size: 12,
      sha256: "deadbeef",
    });
  });

  it("uploads a file, creates an asset row, and returns it (no job created)", async () => {
    const app = await buildApp();

    const res = await request(app)
      .post("/companies/co-1/memory/assets/upload")
      .field("departmentId", "dept-1")
      .field("folderPath", "Engineering/Files")
      .attach("file", Buffer.from("hello"), {
        filename: "x.pdf",
        contentType: "application/pdf",
      });

    expect(res.status).toBe(201);
    expect(res.body.asset).toMatchObject({
      fileName: "x.pdf",
      mimeType: "application/pdf",
      folderPath: "Engineering/Files",
      importJobId: null,
    });
    expect(res.body.jobId).toBeUndefined();
    expect(mockStorage.putFile).toHaveBeenCalled();
    expect(mockAssetsCreate).toHaveBeenCalled();
  });

  it("rejects unsupported mime types with 400", async () => {
    const app = await buildApp();

    const res = await request(app)
      .post("/companies/co-1/memory/assets/upload")
      .field("folderPath", "Files")
      .attach("file", Buffer.from("hi"), {
        filename: "x.exe",
        contentType: "application/x-msdownload",
      });

    expect(res.status).toBe(400);
    expect(mockAssetsCreate).not.toHaveBeenCalled();
  });
});
