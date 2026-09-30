/**
 * D3 — Budget auto-pause + config revisions + audit wired for kind='aoa'
 *
 * Test A — Budget auto-pause: emitting a cost_event for a kind='aoa' agent
 *   whose budgetMonthlyCents > 0 and whose total spent >= budget flips
 *   agent.status to 'paused'.
 *
 * Test B — Paused-skip: listEnabledOutboxAgents does NOT return a paused AoA agent.
 *
 * Test C — Config revision: the standard PATCH /agents/:id route with
 *   recordRevision writes an agent_config_revisions row for aoa agents too.
 *
 * Test D — Activity log: AoA agent create logs aoa_agent.created; pause logs
 *   aoa_agent.paused; trigger change logs aoa_agent.trigger_changed.
 *   These are route-level tests using supertest + mockLogActivity.
 */

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── DB / drizzle stubs ─────────────────────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  desc: vi.fn((col: unknown) => ({ desc: col })),
  asc: vi.fn((col: unknown) => ({ asc: col })),
  gte: vi.fn((a: unknown, b: unknown) => ({ gte: [a, b] })),
  lte: vi.fn((a: unknown, b: unknown) => ({ lte: [a, b] })),
  lt: vi.fn((a: unknown, b: unknown) => ({ lt: [a, b] })),
  isNull: vi.fn((col: unknown) => ({ isNull: col })),
  isNotNull: vi.fn((col: unknown) => ({ isNotNull: col })),
  or: vi.fn((...args: unknown[]) => ({ or: args })),
  inArray: vi.fn((col: unknown, vals: unknown) => ({ inArray: [col, vals] })),
  notInArray: vi.fn((col: unknown, vals: unknown) => ({ notInArray: [col, vals] })),
  ne: vi.fn((a: unknown, b: unknown) => ({ ne: [a, b] })),
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
    costEvents: makeTable("cost_events"),
    agents: makeTable("agents"),
    companies: makeTable("companies"),
    agentConfigRevisions: makeTable("agent_config_revisions"),
    aoaAgentTriggers: makeTable("aoa_agent_triggers"),
    activityLog: makeTable("activity_log"),
    heartbeatRuns: makeTable("heartbeat_runs"),
    internalAgentRuns: makeTable("internal_agent_runs"),
    issues: makeTable("issues"),
    projects: makeTable("projects"),
  };
});

const mockEvaluateCostEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../services/budgets.js", () => ({
  budgetService: () => ({ evaluateCostEvent: mockEvaluateCostEvent }),
}));
vi.mock("../middleware/logger.js", () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
  },
}));
vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));
vi.mock("../redaction.js", () => ({
  sanitizeRecord: (r: unknown) => r,
  redactEventPayload: (r: unknown) => r,
}));

// ── Services mock (for route-level tests D) ───────────────────────────────────
const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  create: vi.fn(),
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
  rollbackConfigRevision: vi.fn(),
  updatePermissions: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  cancelActiveForAgent: vi.fn().mockResolvedValue(undefined),
  wakeup: vi.fn(),
  list: vi.fn().mockResolvedValue([]),
  getRun: vi.fn(),
  getActiveRunForAgent: vi.fn(),
  cancelRun: vi.fn(),
  getRuntimeState: vi.fn(),
  listTaskSessions: vi.fn().mockResolvedValue([]),
  resetRuntimeSession: vi.fn(),
  listEvents: vi.fn().mockResolvedValue([]),
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
  companySkillService: () => ({ listRuntimeSkillEntries: vi.fn(), resolveSkillKeys: vi.fn().mockResolvedValue([]) }),
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => ({}),
  issueService: () => ({}),
  logActivity: mockLogActivity,
  secretService: () => ({
    resolveAdapterConfigForRuntime: vi.fn(),
    normalizeAdapterConfigForPersistence: vi.fn(
      async (_companyId: string, config: Record<string, unknown>) => config,
    ),
    syncEnvBindingsForTarget: vi.fn().mockResolvedValue(undefined),
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

const mockAssertRole = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../middleware/rbac.js", () => ({
  assertRole: mockAssertRole,
  assertHumanRole: mockAssertRole,
  assertDepartmentAccess: vi.fn().mockResolvedValue(undefined),
  assertMemoryAccess: vi.fn().mockResolvedValue(undefined),
  assertMemoryApproval: vi.fn().mockResolvedValue(undefined),
  assertEntityAccess: vi.fn().mockResolvedValue(undefined),
}));

import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";
import { costService } from "../services/costs.js";
import { listEnabledOutboxAgents } from "../services/internal-agent/aoa-agents/triggers.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TRIGGER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const founderActor = {
  type: "board" as const,
  source: "session" as const,
  userId: "founder-user",
  companyIds: [COMPANY_ID],
  isInstanceAdmin: false,
};

// ── Mock DB helpers ────────────────────────────────────────────────────────────

type MockRow = Record<string, unknown>;

/**
 * Creates a transaction-aware sequence DB for costService tests.
 */
function createCostSequenceDb(opts: {
  agentRow: MockRow;
  eventRow: MockRow;
  updatedAgentRow: MockRow;
}) {
  const capturedUpdates: MockRow[] = [];

  let txInsertIdx = 0;
  let txSelectIdx = 0;

  const txInserts = [opts.eventRow];
  const txSelects = [opts.updatedAgentRow];

  function makeChain(getResult: () => MockRow[]): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    const methods = ["from", "where", "orderBy", "limit", "leftJoin", "innerJoin", "returning", "groupBy"];
    for (const m of methods) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    chain.then = (resolve: (v: MockRow[]) => unknown) =>
      Promise.resolve(getResult()).then(resolve);
    return chain;
  }

  function makeTxInsertChain() {
    const resultRow = txInserts[txInsertIdx++] ?? opts.eventRow;
    const chain: Record<string, unknown> = {};
    chain.values = (_v: MockRow) => {
      const inner: Record<string, unknown> = {};
      inner.returning = () => inner;
      inner.then = (resolve: (v: MockRow[]) => unknown) =>
        Promise.resolve([resultRow]).then(resolve);
      return inner;
    };
    return chain;
  }

  function makeTxSelectChain() {
    const resultRow = txSelects[txSelectIdx++] ?? opts.updatedAgentRow;
    return makeChain(() => [resultRow]);
  }

  const tx = {
    insert: () => makeTxInsertChain(),
    update: (_table: unknown) => {
      const chain: Record<string, unknown> = {};
      chain.set = (v: MockRow) => {
        capturedUpdates.push(v);
        return { where: () => Promise.resolve([]) };
      };
      return chain;
    },
    select: (_fields?: unknown) => makeTxSelectChain(),
  };

  const db = {
    select: (_fields?: unknown) => makeChain(() => [opts.agentRow]),
    insert: (_table: unknown) => makeTxInsertChain(),
    update: (_table: unknown) => {
      const chain: Record<string, unknown> = {};
      chain.set = (v: MockRow) => {
        capturedUpdates.push(v);
        return { where: () => Promise.resolve([]) };
      };
      return chain;
    },
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
    _capturedUpdates: capturedUpdates,
  };

  return { db, capturedUpdates };
}

/**
 * A minimal outbox-list DB: returns the given rows from the join query.
 */
function makeOutboxDb(rows: MockRow[]) {
  const chain: Record<string, unknown> = {};
  const methods = ["from", "innerJoin", "leftJoin", "where", "orderBy", "limit"];
  for (const m of methods) {
    chain[m] = (..._args: unknown[]) => chain;
  }
  chain.then = (resolve: (v: unknown[]) => unknown) =>
    Promise.resolve(rows).then(resolve);
  return {
    select: (_fields?: unknown) => chain,
  };
}

/**
 * Chainable mock DB for route-level tests D (trigger PATCH).
 */
function makeTriggerDb(updateResult: Record<string, unknown> | null = null) {
  return {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn().mockReturnThis(),
        then: vi.fn((fn: (rows: unknown[]) => unknown) =>
          Promise.resolve(fn([])),
        ),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockReturnThis(),
          then: vi.fn((fn: (rows: unknown[]) => unknown) =>
            Promise.resolve(fn(updateResult ? [updateResult] : [])),
          ),
        })),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      then: vi.fn((fn: (rows: unknown[]) => unknown) =>
        Promise.resolve(fn([])),
      ),
    })),
  };
}

function makeApp(db: unknown = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = founderActor;
    next();
  });
  app.use("/api", agentRoutes(db as never));
  app.use(errorHandler);
  return app;
}

// ── Test A: Budget auto-pause ─────────────────────────────────────────────────

describe("D3 Test A — Budget auto-pause for kind='aoa' agents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEvaluateCostEvent.mockResolvedValue(undefined);
  });

  it("does NOT pause an aoa agent whose spend is below budget", async () => {
    const agent: MockRow = {
      id: AGENT_ID, companyId: COMPANY_ID, kind: "aoa", status: "idle",
      budgetMonthlyCents: 1000, spentMonthlyCents: 0,
    };
    const eventRow: MockRow = {
      id: "evt-1", agentId: AGENT_ID, companyId: COMPANY_ID, costCents: 100,
      provider: "anthropic", model: "claude-sonnet-4-20250514",
    };
    const updatedAgent: MockRow = { ...agent, spentMonthlyCents: 100 };

    const { db, capturedUpdates } = createCostSequenceDb({ agentRow: agent, eventRow, updatedAgentRow: updatedAgent });
    const svc = costService(db as any);
    await svc.createEvent(COMPANY_ID, {
      agentId: AGENT_ID, provider: "anthropic", model: "claude-sonnet-4-20250514",
      inputTokens: 0, outputTokens: 0, costCents: 100, occurredAt: new Date(),
    } as any);

    const pauseUpdates = capturedUpdates.filter((u) => u.status === "paused");
    expect(pauseUpdates).toHaveLength(0);
  });

  it("pauses a kind='aoa' agent when spend meets budget threshold", async () => {
    const agent: MockRow = {
      id: AGENT_ID, companyId: COMPANY_ID, kind: "aoa", status: "idle",
      budgetMonthlyCents: 500, spentMonthlyCents: 0,
    };
    const eventRow: MockRow = {
      id: "evt-2", agentId: AGENT_ID, companyId: COMPANY_ID, costCents: 500,
      provider: "anthropic", model: "claude-sonnet-4-20250514",
    };
    const updatedAgent: MockRow = {
      ...agent,
      spentMonthlyCents: 500, // spent >= budget (500 >= 500) → should pause
    };

    const { db, capturedUpdates } = createCostSequenceDb({ agentRow: agent, eventRow, updatedAgentRow: updatedAgent });
    const svc = costService(db as any);
    await svc.createEvent(COMPANY_ID, {
      agentId: AGENT_ID, provider: "anthropic", model: "claude-sonnet-4-20250514",
      inputTokens: 0, outputTokens: 0, costCents: 500, occurredAt: new Date(),
    } as any);

    const pauseUpdates = capturedUpdates.filter((u) => u.status === "paused");
    expect(pauseUpdates).toHaveLength(1);
    expect(pauseUpdates[0]).toMatchObject({ status: "paused" });
  });

  it("does NOT double-pause an already-paused aoa agent", async () => {
    const agent: MockRow = {
      id: AGENT_ID, companyId: COMPANY_ID, kind: "aoa", status: "paused",
      budgetMonthlyCents: 500, spentMonthlyCents: 500,
    };
    const eventRow: MockRow = {
      id: "evt-3", agentId: AGENT_ID, companyId: COMPANY_ID, costCents: 10,
      provider: "anthropic", model: "claude-sonnet-4-20250514",
    };
    const updatedAgent: MockRow = { ...agent, spentMonthlyCents: 510, status: "paused" };

    const { db, capturedUpdates } = createCostSequenceDb({ agentRow: agent, eventRow, updatedAgentRow: updatedAgent });
    const svc = costService(db as any);
    await svc.createEvent(COMPANY_ID, {
      agentId: AGENT_ID, provider: "anthropic", model: "claude-sonnet-4-20250514",
      inputTokens: 0, outputTokens: 0, costCents: 10, occurredAt: new Date(),
    } as any);

    const pauseUpdates = capturedUpdates.filter((u) => u.status === "paused");
    expect(pauseUpdates).toHaveLength(0);
  });

  it("budget=0 never triggers auto-pause regardless of spend", async () => {
    const agent: MockRow = {
      id: AGENT_ID, companyId: COMPANY_ID, kind: "aoa", status: "idle",
      budgetMonthlyCents: 0, spentMonthlyCents: 99999,
    };
    const eventRow: MockRow = {
      id: "evt-4", agentId: AGENT_ID, companyId: COMPANY_ID, costCents: 1000,
      provider: "anthropic", model: "claude-sonnet-4-20250514",
    };
    const updatedAgent: MockRow = { ...agent, spentMonthlyCents: 100999 };

    const { db, capturedUpdates } = createCostSequenceDb({ agentRow: agent, eventRow, updatedAgentRow: updatedAgent });
    const svc = costService(db as any);
    await svc.createEvent(COMPANY_ID, {
      agentId: AGENT_ID, provider: "anthropic", model: "claude-sonnet-4-20250514",
      inputTokens: 0, outputTokens: 0, costCents: 1000, occurredAt: new Date(),
    } as any);

    const pauseUpdates = capturedUpdates.filter((u) => u.status === "paused");
    expect(pauseUpdates).toHaveLength(0);
  });
});

// ── Test B: Paused-skip ────────────────────────────────────────────────────────

describe("D3 Test B — Plan-A paused-skip: listEnabledOutboxAgents skips paused aoa agents", () => {
  it("returns empty list when the only aoa outbox agent is paused", async () => {
    const rows = [{ agentId: AGENT_ID, status: "paused" }];
    const db = makeOutboxDb(rows);
    const result = await listEnabledOutboxAgents(db as any, COMPANY_ID);
    expect(result).toEqual([]);
  });

  it("returns agent id when the aoa outbox agent is idle (not paused)", async () => {
    const rows = [{ agentId: AGENT_ID, status: "idle" }];
    const db = makeOutboxDb(rows);
    const result = await listEnabledOutboxAgents(db as any, COMPANY_ID);
    expect(result).toEqual([AGENT_ID]);
  });

  it("filters out terminated agents too", async () => {
    const rows = [
      { agentId: "agent-1", status: "terminated" },
      { agentId: "agent-2", status: "idle" },
    ];
    const db = makeOutboxDb(rows);
    const result = await listEnabledOutboxAgents(db as any, COMPANY_ID);
    expect(result).toEqual(["agent-2"]);
  });

  it("returns multiple enabled agents when none are paused/terminated", async () => {
    const rows = [
      { agentId: "agent-1", status: "idle" },
      { agentId: "agent-2", status: "active" },
    ];
    const db = makeOutboxDb(rows);
    const result = await listEnabledOutboxAgents(db as any, COMPANY_ID);
    expect(result).toEqual(["agent-1", "agent-2"]);
  });
});

// ── Test C: Config revision ────────────────────────────────────────────────────

describe("D3 Test C — PATCH /agents/:id writes agent_config_revisions for aoa agents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("svc.update is called with recordRevision option when PATCH /agents/:id is called", async () => {
    const aoaAgent = {
      id: AGENT_ID, companyId: COMPANY_ID, kind: "aoa", role: "general",
      name: "AoA Commander", status: "idle",
      adapterType: "process", adapterConfig: {}, runtimeConfig: {},
    };
    mockAgentService.getById.mockResolvedValue(aoaAgent);
    mockAgentService.update.mockResolvedValue({
      ...aoaAgent,
      runtimeConfig: { aoa: { instruction: "updated" } },
    });

    const res = await request(makeApp())
      .patch(`/api/agents/${AGENT_ID}`)
      .send({ runtimeConfig: { aoa: { instruction: "updated" } } });

    expect(res.status).toBe(200);
    // Verify svc.update was called with recordRevision — this is what writes the revision row
    expect(mockAgentService.update).toHaveBeenCalledWith(
      AGENT_ID,
      expect.anything(),
      expect.objectContaining({
        recordRevision: expect.objectContaining({ source: "patch" }),
      }),
    );
  });
});

// ── Test D: Activity log ───────────────────────────────────────────────────────

describe("D3 Test D — Route activity log: aoa_agent.created / aoa_agent.paused / aoa_agent.trigger_changed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertRole.mockResolvedValue(undefined);
  });

  it("POST /companies/:cid/agents with kind='aoa' logs aoa_agent.created", async () => {
    const createdAgent = {
      id: AGENT_ID, companyId: COMPANY_ID, kind: "aoa",
      name: "AoA Commander", role: "general",
      adapterType: "process", adapterConfig: {}, runtimeConfig: {},
    };
    mockAgentService.create.mockResolvedValue(createdAgent);

    const res = await request(makeApp())
      .post(`/api/companies/${COMPANY_ID}/agents`)
      .send({ name: "AoA Commander", kind: "aoa", adapterType: "process" });

    expect(res.status).toBe(201);

    // Must have been called with aoa_agent.created
    const aoaCreatedCalls = mockLogActivity.mock.calls.filter(
      (args) => args[1]?.action === "aoa_agent.created",
    );
    expect(aoaCreatedCalls.length).toBeGreaterThanOrEqual(1);
    expect(aoaCreatedCalls[0][1]).toMatchObject({
      action: "aoa_agent.created",
      entityType: "agent",
      entityId: AGENT_ID,
      companyId: COMPANY_ID,
    });
  });

  it("POST /agents/:id/pause on kind='aoa' agent logs aoa_agent.paused", async () => {
    const aoaAgent = {
      id: AGENT_ID, companyId: COMPANY_ID, kind: "aoa",
      name: "AoA Commander", status: "idle",
    };
    const pausedAgent = { ...aoaAgent, status: "paused" };
    mockAgentService.getById.mockResolvedValue(aoaAgent);
    mockAgentService.pause.mockResolvedValue(pausedAgent);

    const res = await request(makeApp())
      .post(`/api/agents/${AGENT_ID}/pause`);

    expect(res.status).toBe(200);

    // Must have been called with aoa_agent.paused
    const aoaPausedCalls = mockLogActivity.mock.calls.filter(
      (args) => args[1]?.action === "aoa_agent.paused",
    );
    expect(aoaPausedCalls.length).toBeGreaterThanOrEqual(1);
    expect(aoaPausedCalls[0][1]).toMatchObject({
      action: "aoa_agent.paused",
      entityType: "agent",
      entityId: AGENT_ID,
      companyId: COMPANY_ID,
    });
  });

  it("PATCH /companies/:cid/agents/:id/triggers/:triggerId logs aoa_agent.trigger_changed", async () => {
    const updatedTrigger = {
      id: TRIGGER_ID, companyId: COMPANY_ID, agentId: AGENT_ID,
      kind: "outbox", enabled: false, config: {},
    };
    const db = makeTriggerDb(updatedTrigger);

    const res = await request(makeApp(db))
      .patch(`/api/companies/${COMPANY_ID}/agents/${AGENT_ID}/triggers/${TRIGGER_ID}`)
      .send({ enabled: false });

    expect(res.status).toBe(200);

    // Must have been called with aoa_agent.trigger_changed
    const triggerChangedCalls = mockLogActivity.mock.calls.filter(
      (args) => args[1]?.action === "aoa_agent.trigger_changed",
    );
    expect(triggerChangedCalls.length).toBeGreaterThanOrEqual(1);
    expect(triggerChangedCalls[0][1]).toMatchObject({
      action: "aoa_agent.trigger_changed",
      companyId: COMPANY_ID,
    });
  });
});
