import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { drizzleOperatorStubs, makeTableProxy } from "./helpers/drizzle-mock.js";

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
  list: vi.fn().mockResolvedValue([]),
  resolveByReference: vi.fn(),
  update: vi.fn(),
  orgForCompany: vi.fn().mockResolvedValue([]),
  listConfigRevisions: vi.fn().mockResolvedValue([]),
  getConfigRevision: vi.fn(),
  getChainOfCommand: vi.fn().mockResolvedValue([]),
  backfillParentFields: vi.fn().mockResolvedValue(0),
  listKeys: vi.fn(),
  createApiKey: vi.fn(),
  revokeKey: vi.fn(),
  getKeyById: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  getRun: vi.fn(),
  cancelRun: vi.fn(),
  cancelActiveForAgent: vi.fn().mockResolvedValue(undefined),
  wakeup: vi.fn(),
  listEvents: vi.fn(),
  list: vi.fn(),
  listLive: vi.fn(),
  listRecent: vi.fn(),
  readLog: vi.fn(),
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

const RUN_ID = "22222222-2222-4222-8222-222222222222";

const companyAActor = {
  type: "board" as const,
  source: "session" as const,
  userId: "user-A",
  companyIds: ["company-A"],
  isInstanceAdmin: false,
};

function makeApp(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("POST /heartbeat-runs/:runId/cancel cross-tenant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("403 for foreign-company run", async () => {
    mockHeartbeatService.getRun.mockResolvedValue({
      id: RUN_ID,
      companyId: "company-B",
    });
    const res = await request(makeApp(companyAActor))
      .post(`/api/heartbeat-runs/${RUN_ID}/cancel`)
      .send({});
    expect(res.status).toBe(403);
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
  });

  it("404 for unknown run", async () => {
    mockHeartbeatService.getRun.mockResolvedValue(null);
    const res = await request(makeApp(companyAActor))
      .post(`/api/heartbeat-runs/${RUN_ID}/cancel`)
      .send({});
    expect(res.status).toBe(404);
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
  });

  it("200 for own-company run (regression guard)", async () => {
    mockHeartbeatService.getRun.mockResolvedValue({
      id: RUN_ID,
      companyId: "company-A",
    });
    mockHeartbeatService.cancelRun.mockResolvedValue({
      id: RUN_ID,
      companyId: "company-A",
      status: "cancelled",
      agentId: "agent-1",
    });
    const res = await request(makeApp(companyAActor))
      .post(`/api/heartbeat-runs/${RUN_ID}/cancel`)
      .send({});
    expect(res.status).toBe(200);
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith(RUN_ID);
  });
});
