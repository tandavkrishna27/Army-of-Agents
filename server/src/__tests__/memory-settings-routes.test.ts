import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { memorySettingsRoutes } from "../routes/memory-settings.js";

const mockService = vi.hoisted(() => ({
  list: vi.fn(),
  getDepartment: vi.fn(),
  upsert: vi.fn(),
  deleteOverride: vi.fn(),
}));

const logActivity = vi.hoisted(() => vi.fn());
vi.mock("../services/index.js", () => ({ logActivity }));

vi.mock("../services/memory-settings.js", () => ({
  memorySettingsService: () => mockService,
}));

// assertRole → permissionService(db).getEffectiveRole for non-local actors.
const getEffectiveRole = vi.hoisted(() => vi.fn());
const isFounder = vi.hoisted(() => vi.fn());
const isTeamLeadForDepartment = vi.hoisted(() => vi.fn());
vi.mock("../services/permissions.js", () => ({
  permissionService: () => ({ getEffectiveRole, isFounder, isTeamLeadForDepartment }),
}));

const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const DEPT_A = "22222222-2222-2222-2222-222222222222";

function createApp(actor: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", memorySettingsRoutes({} as never));
  app.use(errorHandler);
  return app;
}

/** local_trusted board actor — bypasses the role lookup (assertRole short-circuits). */
function localBoardActor() {
  return {
    type: "board" as const,
    userId: "user-1",
    source: "local_implicit",
    companyIds: [COMPANY_A],
    isInstanceAdmin: false,
  };
}

/** Authenticated session actor whose effective role is resolved via permissionService. */
function sessionActor() {
  return {
    type: "board" as const,
    userId: "user-9",
    source: "session",
    companyIds: [COMPANY_A],
    isInstanceAdmin: false,
  };
}

describe("memory-settings routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockService.getDepartment.mockResolvedValue({ id: DEPT_A });
    isFounder.mockResolvedValue(false);
    isTeamLeadForDepartment.mockResolvedValue(false);
  });

  it("GET returns the company's memory settings", async () => {
    mockService.list.mockResolvedValue([
      { departmentId: null, autonomyLevel: "supervised", activeContextTier: "durable" },
    ]);
    const res = await request(createApp(localBoardActor())).get(
      `/api/companies/${COMPANY_A}/memory-settings`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(mockService.list).toHaveBeenCalledWith(COMPANY_A);
  });

  it("GET rejects an unauthenticated actor", async () => {
    const res = await request(createApp({ type: "none", source: "none" })).get(
      `/api/companies/${COMPANY_A}/memory-settings`,
    );
    expect(res.status).toBe(401);
    expect(mockService.list).not.toHaveBeenCalled();
  });

  it("PUT upserts the company default (departmentId null)", async () => {
    mockService.upsert.mockResolvedValue({ id: "row-1", autonomyLevel: "trusted" });
    const res = await request(createApp(localBoardActor()))
      .put(`/api/companies/${COMPANY_A}/memory-settings`)
      .send({ autonomyLevel: "trusted" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockService.upsert).toHaveBeenCalledWith(
      COMPANY_A,
      null,
      expect.objectContaining({ autonomyLevel: "trusted" }),
    );
  });

  it("PUT upserts a department override", async () => {
    mockService.upsert.mockResolvedValue({ id: "row-2", departmentId: DEPT_A });
    const res = await request(createApp(localBoardActor()))
      .put(`/api/companies/${COMPANY_A}/memory-settings`)
      .send({ departmentId: DEPT_A, autonomyLevel: "manual" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockService.upsert).toHaveBeenCalledWith(
      COMPANY_A,
      DEPT_A,
      expect.objectContaining({ autonomyLevel: "manual" }),
    );
  });

  it("PUT rejects an invalid autonomy level (400)", async () => {
    const res = await request(createApp(localBoardActor()))
      .put(`/api/companies/${COMPANY_A}/memory-settings`)
      .send({ autonomyLevel: "bogus" });
    expect(res.status).toBe(400);
    expect(mockService.upsert).not.toHaveBeenCalled();
  });

  it("PUT forbids a team_member (founder/team_lead gated)", async () => {
    getEffectiveRole.mockResolvedValue("team_member");
    const res = await request(createApp(sessionActor()))
      .put(`/api/companies/${COMPANY_A}/memory-settings`)
      .send({ autonomyLevel: "trusted" });
    expect(res.status).toBe(403);
    expect(mockService.upsert).not.toHaveBeenCalled();
  });

  it("PUT forbids a team_lead from changing the company default", async () => {
    getEffectiveRole.mockResolvedValue("team_lead");
    mockService.upsert.mockResolvedValue({ id: "row-3" });
    const res = await request(createApp(sessionActor()))
      .put(`/api/companies/${COMPANY_A}/memory-settings`)
      .send({ autonomyLevel: "trusted" });
    expect(res.status).toBe(403);
    expect(mockService.upsert).not.toHaveBeenCalled();
  });

  it("PUT allows a team_lead to change their own department override", async () => {
    getEffectiveRole.mockResolvedValue("team_lead");
    isTeamLeadForDepartment.mockResolvedValue(true);
    mockService.upsert.mockResolvedValue({ id: "row-3", departmentId: DEPT_A });
    const res = await request(createApp(sessionActor()))
      .put(`/api/companies/${COMPANY_A}/memory-settings`)
      .send({ departmentId: DEPT_A, autonomyLevel: "trusted" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockService.upsert).toHaveBeenCalled();
    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "memory.settings_updated", entityId: "row-3" }),
    );
  });

  it("PUT rejects agent actors even within their company", async () => {
    const agent = { type: "agent", source: "agent", companyId: COMPANY_A, agentId: "agent-1" };
    const res = await request(createApp(agent))
      .put(`/api/companies/${COMPANY_A}/memory-settings`)
      .send({ autonomyLevel: "trusted" });
    expect(res.status).toBe(403);
    expect(mockService.upsert).not.toHaveBeenCalled();
  });

  it("PUT rejects a department outside the company", async () => {
    mockService.getDepartment.mockResolvedValue(null);
    const res = await request(createApp(localBoardActor()))
      .put(`/api/companies/${COMPANY_A}/memory-settings`)
      .send({ departmentId: DEPT_A, autonomyLevel: "trusted" });
    expect(res.status).toBe(404);
    expect(mockService.upsert).not.toHaveBeenCalled();
  });

  it("DELETE removes a department override (204)", async () => {
    mockService.deleteOverride.mockResolvedValue(undefined);
    const res = await request(createApp(localBoardActor())).delete(
      `/api/companies/${COMPANY_A}/memory-settings/departments/${DEPT_A}`,
    );
    expect(res.status).toBe(204);
    expect(mockService.deleteOverride).toHaveBeenCalledWith(COMPANY_A, DEPT_A);
    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "memory.settings_override_deleted", entityId: DEPT_A }),
    );
  });

  it("DELETE rejects a malformed department id", async () => {
    const res = await request(createApp(localBoardActor())).delete(
      `/api/companies/${COMPANY_A}/memory-settings/departments/not-a-uuid`,
    );
    expect(res.status).toBe(400);
    expect(mockService.deleteOverride).not.toHaveBeenCalled();
  });
});
