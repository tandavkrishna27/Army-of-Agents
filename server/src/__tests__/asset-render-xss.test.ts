import express from "express";
import request from "supertest";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { drizzleOperatorStubs, makeTableProxy } from "./helpers/drizzle-mock.js";

// Real DOCX fixture: two hyperlinks — one javascript: (hostile), one https: (safe).
// Reused from the memory render XSS suite so the real mammoth → sanitize path is
// proven identically here.
const fixtureBuffer = await readFile(
  new URL("./__fixtures__/docx-with-javascript-href.docx", import.meta.url),
);

const { mockService } = vi.hoisted(() => ({
  mockService: {
    getById: vi.fn(),
    create: vi.fn(),
  },
}));
// mammoth.convertToHtml is mocked so a test can inject a hostile HTML payload at
// the DOCX→HTML boundary. A real DOCX cannot make mammoth emit <script>/onerror
// (mammoth's output tag set is constrained), so injecting there is the only way
// to exercise the endpoint's DOMPurify config against the full XSS surface. One
// test below delegates back to the REAL mammoth to prove the end-to-end path.
const { mockConvert } = vi.hoisted(() => ({ mockConvert: vi.fn() }));

vi.mock("drizzle-orm", () => drizzleOperatorStubs());
vi.mock("@armyofagents/db", () => ({
  companies: makeTableProxy("companies"),
}));
vi.mock("../services/index.js", () => ({
  assetService: () => mockService,
  logActivity: vi.fn(),
}));
vi.mock("mammoth", () => ({ default: { convertToHtml: mockConvert } }));

import { assetRoutes } from "../routes/assets.js";

const companyId = "company-1";
const assetId = "asset-1";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

type Actor = {
  type: string;
  source?: string;
  userId?: string;
  companyId?: string;
  agentId?: string;
  runId?: string | null;
};

function makeStorage(buffer: Buffer = fixtureBuffer) {
  return {
    getObject: vi.fn(async () => ({
      stream: Readable.from([buffer]),
      contentLength: buffer.byteLength,
      contentType: DOCX_MIME,
    })),
  };
}

function makeApp(opts: { actor?: Actor; storage?: ReturnType<typeof makeStorage> } = {}) {
  const actor: Actor = opts.actor ?? {
    type: "board",
    source: "local_implicit",
    userId: "board-user",
  };
  const storage = opts.storage ?? makeStorage();
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
    objectKey: "objects/asset-1.docx",
    contentType: DOCX_MIME,
    byteSize: fixtureBuffer.byteLength,
    sha256: "deadbeef",
    originalFilename: "doc.docx",
    createdByAgentId: null,
    createdByUserId: "user-1",
    createdAt: new Date("2026-07-25T00:00:00.000Z"),
    updatedAt: new Date("2026-07-25T00:00:00.000Z"),
    ...overrides,
  };
}

describe("GET /assets/:assetId/render (generic DOCX render + XSS sanitization)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Route-level integration: the endpoint returns HTML injected via
  // dangerouslySetInnerHTML, so it MUST run the shared sanitizer AND set the
  // safe-serving headers + article wrap. The FULL sanitizer battery (including
  // the out-of-FORBID default-deny payloads that prove the real boundary) lives
  // in docx-render.test.ts, which tests the shared helper directly; here we only
  // prove the route wires it and sends the right headers.
  it("runs the shared sanitizer and sets safe headers on a hostile payload", async () => {
    const HOSTILE = [
      "<script>alert(1)</script>",
      '<img src=x onerror="alert(2)">',
      '<a href="javascript:alert(3)">click</a>',
      '<a href="https://example.com" onclick="steal()">safe</a>',
    ].join("");
    mockConvert.mockResolvedValue({ value: HOSTILE, messages: [] });
    mockService.getById.mockResolvedValue(assetRow());

    const res = await request(makeApp().app).get(`/api/assets/${assetId}/render`);

    expect(res.status).toBe(200);
    // Headers match the memory render route exactly.
    expect(res.headers["content-type"]).toMatch(/text\/html; charset=utf-8/);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    // Sanitized (representative checks; full battery in docx-render.test.ts).
    expect(res.text).not.toMatch(/<script/i);
    expect(res.text).not.toMatch(/onerror/i);
    expect(res.text).not.toMatch(/onclick/i);
    expect(res.text).not.toMatch(/javascript:/i);
    // Regression guard: benign https link survives.
    expect(res.text).toMatch(/href="https:\/\/example\.com"/);
    // Wrapped in the shared article shell.
    expect(res.text).toMatch(/<article class="docx-rendered">/);
  });

  // Proves the REAL end-to-end path (real mammoth → real sanitize) strips a
  // javascript: hyperlink and preserves the https one — identical to the memory
  // render route's XSS test, so this endpoint is at least as strong.
  it("strips a javascript: href from a real DOCX via real mammoth", async () => {
    const actual = await vi.importActual<{
      default: { convertToHtml: (o: { buffer: Buffer }) => Promise<{ value: string }> };
    }>("mammoth");
    mockConvert.mockImplementation((arg: { buffer: Buffer }) => actual.default.convertToHtml(arg));
    mockService.getById.mockResolvedValue(assetRow());

    const res = await request(makeApp().app).get(`/api/assets/${assetId}/render`);

    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(/javascript:/i);
    expect(res.text).toMatch(/href="https:\/\/example\.com"/);
  });

  it("reads storage via the asset's OWN companyId + objectKey (auth no wider than /content)", async () => {
    mockConvert.mockResolvedValue({ value: "<p>ok</p>", messages: [] });
    mockService.getById.mockResolvedValue(assetRow());
    const { app, storage } = makeApp();

    const res = await request(app).get(`/api/assets/${assetId}/render`);

    expect(res.status).toBe(200);
    expect(mockService.getById).toHaveBeenCalledWith(assetId);
    expect(storage.getObject).toHaveBeenCalledWith(null, companyId, "objects/asset-1.docx");
  });

  it("rejects a non-DOCX asset with 415 and never attempts conversion", async () => {
    mockService.getById.mockResolvedValue(assetRow({ contentType: "text/plain" }));

    const res = await request(makeApp().app).get(`/api/assets/${assetId}/render`);

    expect(res.status).toBe(415);
    expect(mockConvert).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown asset", async () => {
    mockService.getById.mockResolvedValue(null);

    const res = await request(makeApp().app).get(`/api/assets/does-not-exist/render`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Asset not found");
  });

  it("blocks an agent from rendering another company's asset (403), before any storage/conversion", async () => {
    mockService.getById.mockResolvedValue(assetRow({ companyId: "other-company" }));
    const { app, storage } = makeApp({
      actor: { type: "agent", companyId, agentId: "agent-1", runId: null },
    });

    const res = await request(app).get(`/api/assets/${assetId}/render`);

    expect(res.status).toBe(403);
    // Company scoping is enforced before the asset is read or converted.
    expect(storage.getObject).not.toHaveBeenCalled();
    expect(mockConvert).not.toHaveBeenCalled();
  });
});
