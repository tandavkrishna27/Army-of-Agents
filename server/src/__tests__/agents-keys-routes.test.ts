import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock drizzle-orm to avoid the ESM cycle that route imports trigger on Windows.
vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  not: vi.fn((v: unknown) => ({ not: v })),
  desc: vi.fn((col: unknown) => ({ desc: col })),
  asc: vi.fn((col: unknown) => ({ asc: col })),
  gte: vi.fn((a: unknown, b: unknown) => ({ gte: [a, b] })),
  lt: vi.fn((a: unknown, b: unknown) => ({ lt: [a, b] })),
  lte: vi.fn((a: unknown, b: unknown) => ({ lte: [a, b] })),
  isNull: vi.fn((col: unknown) => ({ isNull: col })),
  isNotNull: vi.fn((col: unknown) => ({ isNotNull: col })),
  or: vi.fn((...args: unknown[]) => ({ or: args })),
  inArray: vi.fn((col: unknown, vals: unknown) => ({ inArray: [col, vals] })),
  sql: new Proxy(() => ({ sql: true }), {
    get: () => () => ({ sql: true }),
    apply: () => ({ sql: true }),
  }),
}));

vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) => {
    const cols: Record<string, symbol> = {};
    return new Proxy({} as Record<string, unknown>, {
      get(_t, prop) {
        if (prop === "_") return { name };
        if (prop === "$inferSelect" || prop === "$inferInsert") return {};
        if (typeof prop === "string") {
          if (!cols[prop]) cols[prop] = Symbol(`${name}.${prop}`);
          return cols[prop];
        }
        return undefined;
      },
    });
  };
  return {
    agents: makeTable("agents"),
    companies: makeTable("companies"),
    heartbeatRuns: makeTable("heartbeat_runs"),
  };
});

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  listKeys: vi.fn(),
  createApiKey: vi.fn(),
  revokeKey: vi.fn(),
  getKeyById: vi.fn(),
  // Stub the rest of the methods agentRoutes touches via factory construction.
  list: vi.fn().mockResolvedValue([]),
  resolveByReference: vi.fn(),
  update: vi.fn(),
  orgForCompany: vi.fn().mockResolvedValue([]),
  listConfigRevisions: vi.fn().mockResolvedValue([]),
  getConfigRevision: vi.fn(),
  getChainOfCommand: vi.fn().mockResolvedValue([]),
  backfillParentFields: vi.fn().mockResolvedValue(0),
}));

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

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
  heartbeatService: () => ({}),
  issueApprovalService: () => ({}),
  issueService: () => ({}),
  logActivity: mockLogActivity,
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

const AGENT_A_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_B_ID = "22222222-2222-4222-8222-222222222222";
const KEY_ID = "33333333-3333-4333-8333-333333333333";

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

describe("/agents/:id/keys cross-tenant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("403 GET keys for foreign-company agent", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: AGENT_A_ID,
      companyId: "company-B",
    });
    const res = await request(makeApp(companyAActor)).get(`/api/agents/${AGENT_A_ID}/keys`);
    expect(res.status).toBe(403);
    expect(mockAgentService.listKeys).not.toHaveBeenCalled();
  });

  it("403 POST keys for foreign-company agent", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: AGENT_A_ID,
      companyId: "company-B",
    });
    const res = await request(makeApp(companyAActor))
      .post(`/api/agents/${AGENT_A_ID}/keys`)
      .send({ name: "k" });
    expect(res.status).toBe(403);
    expect(mockAgentService.createApiKey).not.toHaveBeenCalled();
  });

  it("403 DELETE for foreign-company agent", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: AGENT_A_ID,
      companyId: "company-B",
    });
    const res = await request(makeApp(companyAActor)).delete(
      `/api/agents/${AGENT_A_ID}/keys/${KEY_ID}`,
    );
    expect(res.status).toBe(403);
    expect(mockAgentService.revokeKey).not.toHaveBeenCalled();
  });

  it("404 DELETE when key belongs to a different agent in same company", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: AGENT_A_ID,
      companyId: "company-A",
    });
    mockAgentService.getKeyById.mockResolvedValue({
      id: KEY_ID,
      agentId: AGENT_B_ID,
      name: "k",
      createdAt: new Date(),
    });
    const res = await request(makeApp(companyAActor)).delete(
      `/api/agents/${AGENT_A_ID}/keys/${KEY_ID}`,
    );
    expect(res.status).toBe(404);
    expect(mockAgentService.revokeKey).not.toHaveBeenCalled();
  });

  it("200 GET keys for own-company agent (regression guard)", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: AGENT_A_ID,
      companyId: "company-A",
    });
    mockAgentService.listKeys.mockResolvedValue([]);
    const res = await request(makeApp(companyAActor)).get(`/api/agents/${AGENT_A_ID}/keys`);
    expect(res.status).toBe(200);
    expect(mockAgentService.listKeys).toHaveBeenCalledWith(AGENT_A_ID);
  });
});

describe("/agents/:id/keys activity log shape", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("POST /agents/:id/keys logs agent.key_created with canonical actor shape", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: AGENT_A_ID,
      companyId: "company-A",
    });
    mockAgentService.createApiKey.mockResolvedValue({
      id: KEY_ID,
      agentId: AGENT_A_ID,
      name: "k",
      createdAt: new Date(),
    });

    const res = await request(makeApp(companyAActor))
      .post(`/api/agents/${AGENT_A_ID}/keys`)
      .send({ name: "k" });
    expect(res.status).toBe(201);

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "agent.key_created",
        entityType: "agent",
        entityId: AGENT_A_ID,
        actorType: "user",
        actorId: "user-A",
        agentId: null,
        runId: null,
        details: expect.objectContaining({ keyId: KEY_ID, name: "k" }),
      }),
    );
  });

  it("DELETE /agents/:id/keys/:keyId emits agent.key_revoked activity log", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: AGENT_A_ID,
      companyId: "company-A",
    });
    mockAgentService.getKeyById.mockResolvedValue({
      id: KEY_ID,
      agentId: AGENT_A_ID,
      name: "k",
      createdAt: new Date(),
    });
    mockAgentService.revokeKey.mockResolvedValue(undefined);

    const res = await request(makeApp(companyAActor)).delete(
      `/api/agents/${AGENT_A_ID}/keys/${KEY_ID}`,
    );
    expect(res.status).toBe(200);

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "agent.key_revoked",
        entityType: "agent",
        entityId: AGENT_A_ID,
        actorType: "user",
        actorId: "user-A",
        agentId: null,
        runId: null,
        details: expect.objectContaining({ keyId: KEY_ID }),
      }),
    );
  });
});
