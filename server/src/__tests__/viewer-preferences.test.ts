import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { viewerPreferencesRoutes } from "../routes/viewer-preferences.js";

const mockServices = vi.hoisted(() => ({
  getViewerPreference: vi.fn(),
  upsertViewerPreference: vi.fn(),
  resolveViewerControl: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  getViewerPreference: mockServices.getViewerPreference,
  upsertViewerPreference: mockServices.upsertViewerPreference,
  resolveViewerControl: mockServices.resolveViewerControl,
}));

const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const COMPANY_B = "55555555-5555-5555-5555-555555555555";

function createApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", viewerPreferencesRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function boardActor(
  overrides: Partial<{ userId: string; companyIds: string[]; isInstanceAdmin: boolean; source: string }> = {},
) {
  return {
    type: "board" as const,
    userId: overrides.userId ?? "user-1",
    source: overrides.source ?? "session",
    companyIds: overrides.companyIds ?? [COMPANY_A],
    isInstanceAdmin: overrides.isInstanceAdmin ?? false,
  };
}

describe("viewer preferences routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET returns raw override + resolved effective level", async () => {
    mockServices.getViewerPreference.mockResolvedValue({
      viewerControlLevel: "manual",
      updatedAt: new Date("2026-04-20T00:00:00Z"),
    });
    mockServices.resolveViewerControl.mockResolvedValue({ level: "manual", source: "user" });
    const app = createApp(boardActor());
    const res = await request(app).get(`/api/companies/${COMPANY_A}/viewer-preferences/me`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      viewerControlLevel: "manual",
      effectiveLevel: "manual",
      source: "user",
    });
    expect(mockServices.getViewerPreference).toHaveBeenCalledWith({}, "user-1", COMPANY_A);
    expect(mockServices.resolveViewerControl).toHaveBeenCalledWith({}, COMPANY_A, "user-1");
  });

  it("GET with no pref row falls back to the company default (fail-safe)", async () => {
    mockServices.getViewerPreference.mockResolvedValue(null);
    mockServices.resolveViewerControl.mockResolvedValue({ level: "own_output", source: "company" });
    const app = createApp(boardActor());
    const res = await request(app).get(`/api/companies/${COMPANY_A}/viewer-preferences/me`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      viewerControlLevel: null,
      effectiveLevel: "own_output",
      source: "company",
    });
  });

  it("PATCH upserts and returns the re-resolved effective level", async () => {
    mockServices.upsertViewerPreference.mockResolvedValue({
      viewerControlLevel: "full",
      updatedAt: new Date(),
    });
    mockServices.resolveViewerControl.mockResolvedValue({ level: "full", source: "user" });
    const app = createApp(boardActor());
    const res = await request(app)
      .patch(`/api/companies/${COMPANY_A}/viewer-preferences/me`)
      .send({ viewerControlLevel: "full" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      viewerControlLevel: "full",
      effectiveLevel: "full",
      source: "user",
    });
    expect(mockServices.upsertViewerPreference).toHaveBeenCalledWith({}, "user-1", COMPANY_A, "full");
  });

  it("PATCH with a per-user override wins over the company level (source=user)", async () => {
    // Company sits at "own_output"; the user override to "manual" must win.
    mockServices.upsertViewerPreference.mockResolvedValue({
      viewerControlLevel: "manual",
      updatedAt: new Date(),
    });
    mockServices.resolveViewerControl.mockResolvedValue({ level: "manual", source: "user" });
    const app = createApp(boardActor());
    const res = await request(app)
      .patch(`/api/companies/${COMPANY_A}/viewer-preferences/me`)
      .send({ viewerControlLevel: "manual" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.effectiveLevel).toBe("manual");
    expect(res.body.source).toBe("user");
  });

  it("PATCH with null clears the override (inherit company default)", async () => {
    mockServices.upsertViewerPreference.mockResolvedValue({
      viewerControlLevel: null,
      updatedAt: new Date(),
    });
    mockServices.resolveViewerControl.mockResolvedValue({ level: "own_output", source: "company" });
    const app = createApp(boardActor());
    const res = await request(app)
      .patch(`/api/companies/${COMPANY_A}/viewer-preferences/me`)
      .send({ viewerControlLevel: null });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      viewerControlLevel: null,
      effectiveLevel: "own_output",
      source: "company",
    });
    expect(mockServices.upsertViewerPreference).toHaveBeenCalledWith({}, "user-1", COMPANY_A, null);
  });

  it("PATCH rejects an invalid level with 400", async () => {
    const app = createApp(boardActor());
    const res = await request(app)
      .patch(`/api/companies/${COMPANY_A}/viewer-preferences/me`)
      .send({ viewerControlLevel: "bogus" });
    expect(res.status).toBe(400);
    expect(mockServices.upsertViewerPreference).not.toHaveBeenCalled();
  });

  it("PATCH rejects unknown fields (strict)", async () => {
    const app = createApp(boardActor());
    const res = await request(app)
      .patch(`/api/companies/${COMPANY_A}/viewer-preferences/me`)
      .send({ nope: true });
    expect(res.status).toBe(400);
  });

  it("GET rejects non-board actors", async () => {
    const app = createApp({ type: "none", source: "none" });
    const res = await request(app).get(`/api/companies/${COMPANY_A}/viewer-preferences/me`);
    expect(res.status).toBe(401);
  });

  it("GET forbids access to a company the user does not belong to", async () => {
    const app = createApp(boardActor({ companyIds: [COMPANY_B] }));
    const res = await request(app).get(`/api/companies/${COMPANY_A}/viewer-preferences/me`);
    expect(res.status).toBe(403);
    expect(mockServices.getViewerPreference).not.toHaveBeenCalled();
  });
});
