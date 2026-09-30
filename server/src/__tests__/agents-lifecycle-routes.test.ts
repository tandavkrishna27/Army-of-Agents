import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzleOperatorStubs, makeTableProxy } from "./helpers/drizzle-mock.js";
import { setDeploymentMode } from "../config/deployment-mode.js";

vi.mock("drizzle-orm", () => drizzleOperatorStubs());

vi.mock("@armyofagents/db", () => ({
  agents: makeTableProxy("agents"),
  companies: makeTableProxy("companies"),
  heartbeatRuns: makeTableProxy("heartbeat_runs"),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  terminate: vi.fn(),
  // Stub the rest of the methods agentRoutes touches via factory construction.
  list: vi.fn().mockResolvedValue([]),
  resolveByReference: vi.fn(),
  update: vi.fn(),
  orgForCompany: vi.fn().mockResolvedValue([]),
  listConfigRevisions: vi.fn().mockResolvedValue([]),
  getConfigRevision: vi.fn(),
  getChainOfCommand: vi.fn().mockResolvedValue([]),
  backfillParentFields: vi.fn().mockResolvedValue(0),
  backfillHumanAtTop: vi.fn().mockResolvedValue(0),
  listKeys: vi.fn(),
  createApiKey: vi.fn(),
  revokeKey: vi.fn(),
  getKeyById: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  cancelActiveForAgent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => ({
    getBundle: vi.fn(),
    readFile: vi.fn(),
    updateBundle: vi.fn(),
    writeFile: vi.fn(),
    deleteFile: vi.fn(),
    exportFiles: vi.fn(),
    ensureManagedBundle: vi.fn(),
    materializeManagedBundle: vi.fn(),
  }),
  accessService: () => ({ canUser: vi.fn(), hasPermission: vi.fn() }),
  approvalService: () => ({}),
  companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => ({}),
  issueService: () => ({}),
  logActivity: vi.fn(),
  secretService: () => ({
    resolveAdapterConfigForRuntime: vi.fn(),
    normalizeAdapterConfigForPersistence: vi.fn(
      async (_companyId: string, config: Record<string, unknown>) => config,
    ),
  }),
  syncInstructionsBundleConfigFromFilePath: vi.fn(
    (_agent: unknown, config: Record<string, unknown>) => config,
  ),
}));

vi.mock("../adapters/index.js", () => ({
  findActiveServerAdapter: vi.fn(),
  findServerAdapter: vi.fn(),
  listAdapterModels: vi.fn(),
}));

vi.mock("@armyofagents/adapter-claude-local/server", () => ({
  runClaudeLogin: vi.fn(),
}));

vi.mock("@armyofagents/adapter-codex-local", () => ({
  DEFAULT_CODEX_LOCAL_BYPASS_APPROVALS_AND_SANDBOX: false,
  DEFAULT_CODEX_LOCAL_MODEL: "gpt-4.1",
}));

vi.mock("@armyofagents/adapter-cursor-local", () => ({
  DEFAULT_CURSOR_LOCAL_MODEL: "claude-sonnet-4-20250514",
}));

vi.mock("@armyofagents/adapter-opencode-local/server", () => ({
  ensureOpenCodeModelConfiguredAndAvailable: vi.fn(),
}));

import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";

const companyAActor = {
  type: "board" as const,
  source: "session" as const,
  userId: "user-A",
  companyIds: ["company-A"],
  isInstanceAdmin: false,
};

function makeApp(actor: any, db: any = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentRoutes(db));
  app.use(errorHandler);
  return app;
}

describe("/agents/:id/{pause,resume,terminate} cross-tenant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("403 PAUSE for foreign-company agent", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: AGENT_ID,
      companyId: "company-B",
    });
    const res = await request(makeApp(companyAActor))
      .post(`/api/agents/${AGENT_ID}/pause`)
      .send({});
    expect(res.status).toBe(403);
    expect(mockAgentService.pause).not.toHaveBeenCalled();
  });

  it("403 RESUME for foreign-company agent", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: AGENT_ID,
      companyId: "company-B",
    });
    const res = await request(makeApp(companyAActor))
      .post(`/api/agents/${AGENT_ID}/resume`)
      .send({});
    expect(res.status).toBe(403);
    expect(mockAgentService.resume).not.toHaveBeenCalled();
  });

  it("403 TERMINATE for foreign-company agent", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: AGENT_ID,
      companyId: "company-B",
    });
    const res = await request(makeApp(companyAActor))
      .post(`/api/agents/${AGENT_ID}/terminate`)
      .send({});
    expect(res.status).toBe(403);
    expect(mockAgentService.terminate).not.toHaveBeenCalled();
  });

  it("404 PAUSE on unknown agent", async () => {
    mockAgentService.getById.mockResolvedValue(null);
    const res = await request(makeApp(companyAActor))
      .post(`/api/agents/${AGENT_ID}/pause`)
      .send({});
    expect(res.status).toBe(404);
    expect(mockAgentService.pause).not.toHaveBeenCalled();
  });

  it("200 PAUSE for own-company agent (regression guard)", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: AGENT_ID,
      companyId: "company-A",
    });
    mockAgentService.pause.mockResolvedValue({
      id: AGENT_ID,
      companyId: "company-A",
      status: "paused",
    });
    const res = await request(makeApp(companyAActor))
      .post(`/api/agents/${AGENT_ID}/pause`)
      .send({});
    expect(res.status).toBe(200);
    expect(mockAgentService.pause).toHaveBeenCalledWith(AGENT_ID);
    expect(mockHeartbeatService.cancelActiveForAgent).toHaveBeenCalledWith(AGENT_ID);
  });

  it("200 RESUME for own-company agent (regression guard)", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: AGENT_ID,
      companyId: "company-A",
    });
    mockAgentService.resume.mockResolvedValue({
      id: AGENT_ID,
      companyId: "company-A",
      status: "idle",
    });
    const res = await request(makeApp(companyAActor))
      .post(`/api/agents/${AGENT_ID}/resume`)
      .send({});
    expect(res.status).toBe(200);
    expect(mockAgentService.resume).toHaveBeenCalledWith(AGENT_ID);
  });

  it("200 TERMINATE for own-company agent (regression guard)", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: AGENT_ID,
      companyId: "company-A",
    });
    mockAgentService.terminate.mockResolvedValue({
      id: AGENT_ID,
      companyId: "company-A",
      status: "terminated",
    });
    const res = await request(makeApp(companyAActor))
      .post(`/api/agents/${AGENT_ID}/terminate`)
      .send({});
    expect(res.status).toBe(200);
    expect(mockAgentService.terminate).toHaveBeenCalledWith(AGENT_ID);
    expect(mockHeartbeatService.cancelActiveForAgent).toHaveBeenCalledWith(AGENT_ID);
  });
});

describe("agent global backfill authorization", () => {
  beforeEach(() => {
    setDeploymentMode("local_trusted");
    vi.clearAllMocks();
    mockAgentService.backfillParentFields.mockResolvedValue(2);
    mockAgentService.backfillHumanAtTop.mockReset().mockResolvedValue(0);
  });
  afterEach(() => setDeploymentMode("local_trusted"));

  const backfillPaths = [
    "/api/agents/admin/backfill-parent-fields",
    "/api/agents/admin/backfill-human-at-top",
  ];

  for (const actor of [
    {
      label: "ordinary cloud board",
      value: {
        type: "board",
        source: "session",
        userId: "tenant-user",
        companyIds: ["company-A"],
        organizationIds: ["org-A"],
        isInstanceAdmin: false,
        operator: false,
      },
    },
    {
      label: "data-plane admin without operator authority",
      value: {
        type: "board",
        source: "session",
        userId: "tenant-admin",
        companyIds: ["company-A"],
        organizationIds: ["org-A"],
        isInstanceAdmin: true,
        operator: false,
      },
    },
  ]) {
    for (const path of backfillPaths) {
      it(`rejects ${actor.label} at ${path} before any global write`, async () => {
        const select = vi.fn();
        const res = await request(makeApp(actor.value, { select })).post(path).send({});

        expect(res.status).toBe(403);
        expect(mockAgentService.backfillParentFields).not.toHaveBeenCalled();
        expect(mockAgentService.backfillHumanAtTop).not.toHaveBeenCalled();
        expect(select).not.toHaveBeenCalled();
      });
    }
  }

  it.each([
    ["operator", { type: "board", source: "session", userId: "operator", operator: true }],
    ["local implicit board", { type: "board", source: "local_implicit", userId: "local-board" }],
  ])("allows %s to run the parent-field backfill", async (_label, actor) => {
    const res = await request(makeApp(actor))
      .post("/api/agents/admin/backfill-parent-fields")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, backfilledCount: 2 });
    expect(mockAgentService.backfillParentFields).toHaveBeenCalledTimes(1);
  });

  it("allows an operator to enumerate companies and sums human-at-top repairs", async () => {
    mockAgentService.backfillHumanAtTop
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2);
    const from = vi.fn().mockResolvedValue([{ id: "company-A" }, { id: "company-B" }]);
    const select = vi.fn(() => ({ from }));
    const actor = { type: "board", source: "session", userId: "operator", operator: true };

    const res = await request(makeApp(actor, { select }))
      .post("/api/agents/admin/backfill-human-at-top")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reparented: 3 });
    expect(select).toHaveBeenCalledTimes(1);
    expect(mockAgentService.backfillHumanAtTop).toHaveBeenNthCalledWith(1, "company-A");
    expect(mockAgentService.backfillHumanAtTop).toHaveBeenNthCalledWith(2, "company-B");
  });

  it.each(backfillPaths)("rejects cloud operators at %s before global tenant work", async (path) => {
    setDeploymentMode("cloud_auth");
    const select = vi.fn();
    const actor = { type: "board", source: "session", userId: "operator", operator: true };
    const res = await request(makeApp(actor, { select })).post(path).send({});
    expect(res.status).toBe(403);
    expect(mockAgentService.backfillParentFields).not.toHaveBeenCalled();
    expect(mockAgentService.backfillHumanAtTop).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });
});
