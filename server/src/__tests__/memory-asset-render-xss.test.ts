import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { memoryAssetRenderRoutes } from "../routes/memory-asset-render.js";
import { errorHandler } from "../middleware/error-handler.js";

const fixtureBuffer = await readFile(
  new URL("./__fixtures__/docx-with-javascript-href.docx", import.meta.url),
);

// Bypass authz so the test focuses on sanitization behavior.
vi.mock("../routes/authz.js", () => ({
  assertCompanyAccess: () => undefined,
}));

// Stub the service module to break the drizzle-orm ESM cycle.
vi.mock("../services/memory-assets.js", () => ({
  memoryAssetsService: vi.fn(() => ({})),
}));

function buildApp() {
  const svc = {
    get: vi.fn(async () => ({
      id: "asset-1",
      fileName: "doc.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      storageKey: "company-A/imports/asset-1.docx",
    })),
  };
  const storage = {
    getObject: vi.fn(async () => ({
      stream: Readable.from([fixtureBuffer]),
      contentLength: fixtureBuffer.byteLength,
    })),
  };
  const app = express();
  app.use(memoryAssetRenderRoutes({ svc: svc as never, storage: storage as never }));
  app.use(errorHandler);
  return app;
}

describe("memory asset render DOCX XSS sanitization", () => {
  it("strips javascript: href", async () => {
    const res = await request(buildApp())
      .get("/companies/company-A/memory/assets/asset-1/render");
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(/javascript:/i);
  });

  it("preserves https: hyperlink (regression guard)", async () => {
    const res = await request(buildApp())
      .get("/companies/company-A/memory/assets/asset-1/render");
    expect(res.text).toMatch(/href="https:\/\/example\.com"/);
  });

  it("includes X-Content-Type-Options: nosniff", async () => {
    const res = await request(buildApp())
      .get("/companies/company-A/memory/assets/asset-1/render");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});
