import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";
import { setDeploymentMode } from "../config/deployment-mode.js";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  list: vi.fn().mockResolvedValue([]),
  orgForCompany: vi.fn().mockResolvedValue([]),
  listConfigRevisions: vi.fn().mockResolvedValue([]),
  getConfigRevision: vi.fn(),
  getChainOfCommand: vi.fn().mockResolvedValue([]),
  backfillParentFields: vi.fn().mockResolvedValue(0),
}));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => ({}),
  accessService: () => ({}),
  approvalService: () => ({}),
  companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
  heartbeatService: () => ({}),
  issueApprovalService: () => ({}),
  issueService: () => ({}),
  logActivity: vi.fn(),
  secretService: () => ({}),
  syncInstructionsBundleConfigFromFilePath: vi.fn((_a: unknown, c: Record<string, unknown>) => c),
}));

vi.mock("../adapters/index.js", () => ({
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

function makeSelectChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    orderBy: vi.fn((..._args: unknown[]) => Promise.resolve(rows)),
    limit: vi.fn().mockReturnThis(),
    then: vi.fn((fn: (r: unknown[]) => unknown) => Promise.resolve(fn(rows))),
  };
}

function makeDb(rows: unknown[]) {
  return {
    select: vi.fn(() => makeSelectChain(rows)),
  } as any;
}

function createApp(
  db: any,
  actorOverride: Partial<{
    isInstanceAdmin: boolean;
    operator: boolean;
    type: string;
    source: string;
  }> = {},
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: actorOverride.type ?? "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: actorOverride.source ?? "local_implicit",
      operator: actorOverride.operator ?? true,
      isInstanceAdmin: actorOverride.isInstanceAdmin ?? true,
    };
    next();
  });
  app.use("/api", agentRoutes(db));
  app.use(errorHandler);
  return app;
}

function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    agentName: "Alpha",
    role: "engineer",
    title: "Engineer",
    status: "active",
    adapterType: "claude_local",
    runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60 } },
    lastHeartbeatAt: new Date("2026-04-20T00:00:00Z"),
    companyName: "Acme",
    companyIssuePrefix: "ACM",
    ...overrides,
  };
}

describe("GET /api/instance/scheduler-heartbeats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setDeploymentMode("local_trusted");
  });

  it("returns derived scheduler agents with heartbeat policy", async () => {
    const rows = [makeRow()];
    const app = createApp(makeDb(rows));

    const res = await request(app).get("/api/instance/scheduler-heartbeats");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: "11111111-1111-4111-8111-111111111111",
      companyName: "Acme",
      companyIssuePrefix: "ACM",
      agentName: "Alpha",
      agentUrlKey: "alpha",
      intervalSec: 60,
      heartbeatEnabled: true,
      schedulerActive: true,
    });
  });

  it("marks heartbeat disabled when runtimeConfig.heartbeat is missing", async () => {
    const rows = [makeRow({ runtimeConfig: {} })];
    const app = createApp(makeDb(rows));

    const res = await request(app).get("/api/instance/scheduler-heartbeats");

    expect(res.status).toBe(200);
    expect(res.body[0].heartbeatEnabled).toBe(false);
    expect(res.body[0].intervalSec).toBe(0);
    expect(res.body[0].schedulerActive).toBe(false);
  });

  it("schedulerActive is false when status is paused even if policy enabled", async () => {
    const rows = [makeRow({ status: "paused" })];
    const app = createApp(makeDb(rows));

    const res = await request(app).get("/api/instance/scheduler-heartbeats");

    expect(res.status).toBe(200);
    // paused/terminated/pending_approval are filtered out entirely per Paperclip parity
    expect(res.body).toHaveLength(0);
  });

  it("sorts active agents before disabled within same company", async () => {
    const rows = [
      makeRow({ id: "disabled-id", agentName: "Bravo", runtimeConfig: {} }),
      makeRow({ id: "active-id", agentName: "Alpha" }),
    ];
    const app = createApp(makeDb(rows));

    const res = await request(app).get("/api/instance/scheduler-heartbeats");

    expect(res.status).toBe(200);
    expect(res.body.map((r: any) => r.id)).toEqual(["active-id", "disabled-id"]);
  });

  it("rejects non-instance-admin actors with 403", async () => {
    const app = createApp(makeDb([]), { isInstanceAdmin: false });

    const res = await request(app).get("/api/instance/scheduler-heartbeats");

    expect(res.status).toBe(403);
  });

  it("rejects non-board actors with 403", async () => {
    const app = createApp(makeDb([]), { type: "none", isInstanceAdmin: true });

    const res = await request(app).get("/api/instance/scheduler-heartbeats");

    expect(res.status).toBe(403);
  });

  it("rejects cloud operators before reading scheduler data", async () => {
    setDeploymentMode("cloud_auth");
    const db = { select: vi.fn() } as any;
    const app = createApp(db, {
      source: "session",
      operator: true,
      isInstanceAdmin: false,
    });

    const res = await request(app).get("/api/instance/scheduler-heartbeats");

    expect(res.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
  });
});
