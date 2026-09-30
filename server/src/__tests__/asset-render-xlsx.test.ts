import express from "express";
import request from "supertest";
import { Readable } from "node:stream";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import { drizzleOperatorStubs, makeTableProxy } from "./helpers/drizzle-mock.js";

// Real XLSX bytes (no mock): a hostile javascript: hyperlink + a benign https
// one, driving the REAL exceljs → sanitize path through the /render route.
let fixtureBuffer: Buffer;
beforeAll(async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.getCell("A1").value = "Cell-One";
  ws.getCell("B1").value = { text: "hostile", hyperlink: "javascript:alert(1)" };
  ws.getCell("C1").value = { text: "ok", hyperlink: "https://example.com" };
  fixtureBuffer = (await wb.xlsx.writeBuffer()) as unknown as Buffer;
});

const { mockService } = vi.hoisted(() => ({
  mockService: { getById: vi.fn(), create: vi.fn() },
}));

vi.mock("drizzle-orm", () => drizzleOperatorStubs());
vi.mock("@armyofagents/db", () => ({ companies: makeTableProxy("companies") }));
vi.mock("../services/index.js", () => ({
  assetService: () => mockService,
  logActivity: vi.fn(),
}));

import { assetRoutes } from "../routes/assets.js";

const companyId = "company-1";
const assetId = "asset-xlsx-1";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

type Actor = {
  type: string;
  source?: string;
  userId?: string;
  companyId?: string;
  agentId?: string;
  runId?: string | null;
};

function makeStorage(getBuffer: () => Buffer) {
  return {
    getObject: vi.fn(async () => ({
      stream: Readable.from([getBuffer()]),
      contentLength: getBuffer().byteLength,
      contentType: XLSX_MIME,
    })),
  };
}

function makeApp(opts: { actor?: Actor; storage?: ReturnType<typeof makeStorage> } = {}) {
  const actor: Actor = opts.actor ?? { type: "board", source: "local_implicit", userId: "board-user" };
  const storage = opts.storage ?? makeStorage(() => fixtureBuffer);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { actor: Actor }).actor = actor;
    next();
  });
  app.use("/api", assetRoutes({} as never, storage as never));
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(err.status ?? 500).json({ error: err.message ?? "Internal Server Error" });
    },
  );
  return { app, storage };
}

function assetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: assetId,
    companyId,
    provider: "local",
    objectKey: "objects/asset-xlsx-1.xlsx",
    contentType: XLSX_MIME,
    byteSize: fixtureBuffer.byteLength,
    sha256: "deadbeef",
    originalFilename: "sheet.xlsx",
    createdByAgentId: null,
    createdByUserId: "user-1",
    createdAt: new Date("2026-07-25T00:00:00.000Z"),
    updatedAt: new Date("2026-07-25T00:00:00.000Z"),
    ...overrides,
  };
}

describe("GET /assets/:assetId/render (XLSX render + sanitization)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a real XLSX to a sanitized table with safe headers", async () => {
    mockService.getById.mockResolvedValue(assetRow());

    const res = await request(makeApp().app).get(`/api/assets/${assetId}/render`);

    expect(res.status).toBe(200);
    // Headers match the DOCX render route exactly.
    expect(res.headers["content-type"]).toMatch(/text\/html; charset=utf-8/);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    // The render is a pure function of the immutable asset bytes, so it is
    // browser-cacheable — a re-viewed doc renders once instead of re-parsing.
    expect(res.headers["cache-control"]).toBe("private, max-age=300");
    // Wrapped in the xlsx shell, with the cell content rendered.
    expect(res.text).toMatch(/<div class="xlsx-rendered">/);
    expect(res.text).toContain("Cell-One");
    // Hostile hyperlink neutralized; benign https survives.
    expect(res.text).not.toMatch(/javascript:/i);
    expect(res.text).toMatch(/href="https:\/\/example\.com"/);
  });

  it("reads storage via the asset's OWN companyId + objectKey (auth no wider than /content)", async () => {
    mockService.getById.mockResolvedValue(assetRow());
    const { app, storage } = makeApp();

    const res = await request(app).get(`/api/assets/${assetId}/render`);

    expect(res.status).toBe(200);
    expect(storage.getObject).toHaveBeenCalledWith(null, companyId, "objects/asset-xlsx-1.xlsx");
  });

  it("rejects a non-office asset with 415 and never reads storage", async () => {
    mockService.getById.mockResolvedValue(assetRow({ contentType: "text/plain" }));
    const { app, storage } = makeApp();

    const res = await request(app).get(`/api/assets/${assetId}/render`);

    expect(res.status).toBe(415);
    expect(storage.getObject).not.toHaveBeenCalled();
  });

  // Resource-exhaustion guard: an asset whose recorded size exceeds the render
  // cap is refused with 413 BEFORE its bytes are fetched — the parse never runs.
  it("rejects an oversized office asset with 413 before reading storage", async () => {
    mockService.getById.mockResolvedValue(assetRow({ byteSize: 50 * 1024 * 1024 }));
    const { app, storage } = makeApp();

    const res = await request(app).get(`/api/assets/${assetId}/render`);

    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/Download to view/i);
    expect(storage.getObject).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown asset", async () => {
    mockService.getById.mockResolvedValue(null);

    const res = await request(makeApp().app).get(`/api/assets/does-not-exist/render`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Asset not found");
  });

  it("blocks an agent from rendering another company's XLSX (403) before any storage read", async () => {
    mockService.getById.mockResolvedValue(assetRow({ companyId: "other-company" }));
    const { app, storage } = makeApp({
      actor: { type: "agent", companyId, agentId: "agent-1", runId: null },
    });

    const res = await request(app).get(`/api/assets/${assetId}/render`);

    expect(res.status).toBe(403);
    expect(storage.getObject).not.toHaveBeenCalled();
  });
});
