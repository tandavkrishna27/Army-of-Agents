import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HUB_AUTOPILOT_POLICY } from "../services/hub-autopilot.js";
import { errorHandler } from "../middleware/index.js";
import { hubAutopilotRoutes } from "../routes/hub-autopilot.js";

const mockAutopilot = vi.hoisted(() => ({
  get: vi.fn(),
  upsert: vi.fn(),
  reset: vi.fn(),
  listRecentActions: vi.fn(),
}));

const mockPerms = vi.hoisted(() => ({
  isFounder: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../services/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/index.js")>()),
  hubAutopilotService: () => mockAutopilot,
  permissionService: () => mockPerms,
  logActivity: mockLogActivity,
}));

const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const COMPANY_B = "55555555-5555-5555-5555-555555555555";

function boardActor(
  overrides: Partial<{
    userId: string;
    companyIds: string[];
    isInstanceAdmin: boolean;
    source: string;
  }> = {},
) {
  return {
    type: "board" as const,
    userId: overrides.userId ?? "user-1",
    source: overrides.source ?? "session",
    companyIds: overrides.companyIds ?? [COMPANY_A],
    isInstanceAdmin: overrides.isInstanceAdmin ?? false,
  };
}

function createApp(actor: unknown = boardActor()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", hubAutopilotRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe("hub autopilot routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAutopilot.get.mockResolvedValue(DEFAULT_HUB_AUTOPILOT_POLICY);
    mockAutopilot.upsert.mockResolvedValue({ ...DEFAULT_HUB_AUTOPILOT_POLICY, mode: "drive" });
    mockAutopilot.reset.mockResolvedValue(DEFAULT_HUB_AUTOPILOT_POLICY);
    mockAutopilot.listRecentActions.mockResolvedValue({ items: [] });
    mockPerms.isFounder.mockResolvedValue(true);
  });

  it("GET policy returns the company policy for board users", async () => {
    const res = await request(createApp()).get(`/api/companies/${COMPANY_A}/hub-autopilot/policy`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.mode).toBe("off");
    expect(mockAutopilot.get).toHaveBeenCalledWith(COMPANY_A);
  });

  it("PATCH policy requires founder authority", async () => {
    mockPerms.isFounder.mockResolvedValue(false);

    const res = await request(createApp())
      .patch(`/api/companies/${COMPANY_A}/hub-autopilot/policy`)
      .send({ mode: "drive" });

    expect(res.status).toBe(403);
    expect(mockAutopilot.upsert).not.toHaveBeenCalled();
  });

  it("PATCH policy logs an activity row", async () => {
    const res = await request(createApp())
      .patch(`/api/companies/${COMPANY_A}/hub-autopilot/policy`)
      .send({ mode: "drive" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAutopilot.upsert).toHaveBeenCalledWith(COMPANY_A, { mode: "drive" });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: COMPANY_A,
        actorType: "user",
        actorId: "user-1",
        action: "hub_autopilot_policy.updated",
      }),
    );
  });

  it("PATCH policy rejects founder-gated auto-handle rules", async () => {
    const res = await request(createApp())
      .patch(`/api/companies/${COMPANY_A}/hub-autopilot/policy`)
      .send({
        rules: [
          {
            semanticType: "approval_request",
            action: "resolve",
            minTrustScore: 0,
            enabled: true,
          },
        ],
      });

    expect(res.status).toBe(400);
    expect(mockAutopilot.upsert).not.toHaveBeenCalled();
  });

  it("POST reset restores off defaults", async () => {
    const res = await request(createApp())
      .post(`/api/companies/${COMPANY_A}/hub-autopilot/policy/reset`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.mode).toBe("off");
    expect(mockAutopilot.reset).toHaveBeenCalledWith(COMPANY_A);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: COMPANY_A,
        action: "hub_autopilot_policy.reset",
      }),
    );
  });

  it("GET actions returns recent autonomous actions with undo metadata", async () => {
    mockAutopilot.listRecentActions.mockResolvedValue({
      items: [
        {
          auditId: "audit-1",
          hubItemId: "hub-1",
          title: "Run complete",
          semanticType: "run_complete",
          action: "resolve",
          autonomyLevel: "drive",
          reason: "trusted",
          decisionContext: {},
          undoDeadline: "2026-07-01T12:00:00.000Z",
          itemStatus: "resolved",
          itemVersion: 3,
          createdAt: "2026-07-01T11:59:00.000Z",
        },
      ],
    });

    const res = await request(createApp()).get(`/api/companies/${COMPANY_A}/hub-autopilot/actions`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.items[0]).toMatchObject({ auditId: "audit-1", itemVersion: 3 });
    expect(mockAutopilot.listRecentActions).toHaveBeenCalledWith(COMPANY_A, { limit: 10 });
  });

  it("GET actions never returns another company's autonomy audit rows", async () => {
    const res = await request(createApp(boardActor({ companyIds: [COMPANY_B] })))
      .get(`/api/companies/${COMPANY_A}/hub-autopilot/actions`);

    expect(res.status).toBe(403);
    expect(mockAutopilot.listRecentActions).not.toHaveBeenCalled();
  });
});
