import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { notFound } from "../errors.js";
import { errorHandler } from "../middleware/index.js";
import { teamRoutes } from "../routes/team.js";

const mockTeamService = vi.hoisted(() => ({
  getWorkload: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({}),
  humanCapabilitiesService: () => ({}),
  humanContextService: () => ({}),
  humanDiscoveryService: () => ({}),
  logActivity: vi.fn(),
  teamService: () => mockTeamService,
}));

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const TARGET_USER_ID = "target-user-1";

function makeWorkload() {
  return {
    companyId: COMPANY_ID,
    userId: TARGET_USER_ID,
    generatedAt: new Date("2026-07-09T00:00:00.000Z"),
    summary: {
      responsibleOpenTaskCount: 1,
      assignedOpenTaskCount: 0,
      managedAgentCount: 0,
      managedAgentOpenTaskCount: 0,
      attentionCount: 0,
    },
    responsibleTasks: [],
    assignedTasks: [],
    managedAgents: [],
    managedAgentTasks: [],
    attentionItems: [],
  };
}

function makeApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", teamRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe("GET /companies/:companyId/team/users/:userId/workload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTeamService.getWorkload.mockResolvedValue(makeWorkload());
  });

  it("returns workload for a board actor with company access", async () => {
    const app = makeApp({
      type: "board",
      source: "session",
      userId: "actor-user",
      companyIds: [COMPANY_ID],
      isInstanceAdmin: false,
    });

    const res = await request(app).get(`/api/companies/${COMPANY_ID}/team/users/${TARGET_USER_ID}/workload`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.summary.responsibleOpenTaskCount).toBe(1);
    expect(mockTeamService.getWorkload).toHaveBeenCalledWith(COMPANY_ID, TARGET_USER_ID);
  });

  it("rejects actors without company access", async () => {
    const app = makeApp({
      type: "board",
      source: "session",
      userId: "actor-user",
      companyIds: ["other-company"],
      isInstanceAdmin: false,
    });

    const res = await request(app).get(`/api/companies/${COMPANY_ID}/team/users/${TARGET_USER_ID}/workload`);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockTeamService.getWorkload).not.toHaveBeenCalled();
  });

  it("rejects same-company non-board actors before returning workload", async () => {
    const app = makeApp({
      type: "agent",
      companyId: COMPANY_ID,
      agentId: "agent-1",
      runId: "run-1",
    });

    const res = await request(app).get(`/api/companies/${COMPANY_ID}/team/users/${TARGET_USER_ID}/workload`);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body).toEqual({ error: "Board authentication required" });
    expect(mockTeamService.getWorkload).not.toHaveBeenCalled();
  });

  it("returns 404 through error middleware when service reports missing member", async () => {
    mockTeamService.getWorkload.mockRejectedValue(notFound("Team member not found"));
    const app = makeApp({
      type: "board",
      source: "session",
      userId: "actor-user",
      companyIds: [COMPANY_ID],
      isInstanceAdmin: false,
    });

    const res = await request(app).get(`/api/companies/${COMPANY_ID}/team/users/${TARGET_USER_ID}/workload`);

    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.error).toBe("Team member not found");
  });
});
