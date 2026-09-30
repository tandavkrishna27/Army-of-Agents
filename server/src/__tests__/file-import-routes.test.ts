import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import supertest from "supertest";

// ── Mocks (hoisted by vitest before any imports) ───────────────────────────

vi.mock("../routes/authz.js", () => ({
  assertCompanyAccess: vi.fn(),
  getActorInfo: vi.fn(() => ({ actorId: "user-1", actorType: "user" })),
}));

vi.mock("../middleware/rbac.js", () => ({
  assertRole: vi.fn().mockResolvedValue(undefined),
  assertHumanRole: vi.fn().mockResolvedValue(undefined),
}));

const { mockCreateJob, mockGetJob } = vi.hoisted(() => ({
  mockCreateJob: vi.fn().mockResolvedValue({ id: "job-1", fileName: "doc.pdf" }),
  mockGetJob: vi.fn().mockResolvedValue({
    id: "job-1",
    status: "done",
    fileName: "doc.pdf",
    itemCount: 5,
    errorMessage: null,
    parserWarnings: null,
    createdAt: new Date("2025-01-01T00:00:00Z"),
    completedAt: new Date("2025-01-01T00:01:00Z"),
  }),
}));

vi.mock("../services/file-import.js", () => ({
  SUPPORTED_MIME_TYPES: [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/plain",
  ],
  fileImportService: vi.fn(() => ({
    createJob: mockCreateJob,
    getJob: mockGetJob,
  })),
}));

// ── Test helpers ───────────────────────────────────────────────────────────

const mockStorageService = {
  putFile: vi.fn().mockResolvedValue({ objectKey: "imports/123-doc.pdf" }),
};

async function makeApp() {
  const { fileImportRoutes } = await import("../routes/file-import.js");
  const app = express();
  app.use(fileImportRoutes({} as any, mockStorageService as any));
  return app;
}

// ── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Re-stub default return values cleared by clearAllMocks
  mockCreateJob.mockResolvedValue({ id: "job-1", fileName: "doc.pdf" });
  mockGetJob.mockResolvedValue({
    id: "job-1",
    status: "done",
    fileName: "doc.pdf",
    itemCount: 5,
    errorMessage: null,
    parserWarnings: null,
    createdAt: new Date("2025-01-01T00:00:00Z"),
    completedAt: new Date("2025-01-01T00:01:00Z"),
  });
  mockStorageService.putFile.mockResolvedValue({ objectKey: "imports/123-doc.pdf" });
});

describe("fileImportRoutes contract", () => {
  it("exports a fileImportRoutes factory function", async () => {
    const mod = await import("../routes/file-import.js");
    expect(typeof mod.fileImportRoutes).toBe("function");
  });
});

describe("POST /companies/:companyId/memory/import-file", () => {
  it("rejects unsupported MIME type with 400", async () => {
    const app = await makeApp();
    const res = await supertest(app)
      .post("/companies/co-1/memory/import-file")
      .attach("file", Buffer.from("fake image data"), {
        filename: "photo.gif",
        contentType: "image/gif",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unsupported file type/);
  });

  it("returns 202 with jobId and fileName on valid PDF upload", async () => {
    const app = await makeApp();
    const res = await supertest(app)
      .post("/companies/co-1/memory/import-file")
      .attach("file", Buffer.from("PDF content here."), {
        filename: "doc.pdf",
        contentType: "application/pdf",
      });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ jobId: "job-1", fileName: "doc.pdf" });
  });

  it("returns 400 when no file is attached", async () => {
    const app = await makeApp();
    // .field() sends a valid multipart request with no file attachment;
    // multer processes it fine and req.file is undefined → route returns 400.
    const res = await supertest(app)
      .post("/companies/co-1/memory/import-file")
      .field("unused", "value");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No file/);
  });
});

describe("GET /companies/:companyId/memory/import-jobs/:jobId", () => {
  it("returns the correct job status shape", async () => {
    const app = await makeApp();
    const res = await supertest(app).get(
      "/companies/co-1/memory/import-jobs/job-1",
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "job-1",
      status: "done",
      fileName: "doc.pdf",
      itemCount: 5,
      errorMessage: null,
      parserWarnings: null,
    });
    expect(res.body.createdAt).toBeDefined();
    expect(res.body.completedAt).toBeDefined();
  });

  it("returns 404 when the job does not exist", async () => {
    mockGetJob.mockResolvedValueOnce(null);
    const app = await makeApp();
    const res = await supertest(app).get(
      "/companies/co-1/memory/import-jobs/nonexistent",
    );
    expect(res.status).toBe(404);
  });
});
