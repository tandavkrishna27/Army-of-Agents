import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { drizzleOperatorStubs, makeTableProxy } from "./helpers/drizzle-mock.js";

vi.mock("drizzle-orm", () => drizzleOperatorStubs());

vi.mock("@armyofagents/db", () => ({
  agents: makeTableProxy("agents"),
  companies: makeTableProxy("companies"),
  heartbeatRuns: makeTableProxy("heartbeat_runs"),
  aoaAgentTriggers: makeTableProxy("aoa_agent_triggers"),
  internalAgentRuns: makeTableProxy("internal_agent_runs"),
}));

// H2: the hire route must materialize the hire approval as a hub item in-line
// (matching the approval-create atomicity) instead of relying on the scan-on-read
// backstop. These spies assert the emit fires exactly once when board approval is
// required, and never when it isn't.
const { emitHubItem, buildApprovalHubEmit } = vi.hoisted(() => ({
  emitHubItem: vi.fn().mockResolvedValue(undefined),
  buildApprovalHubEmit: vi.fn((approval) => ({
    companyId: approval.companyId,
    semanticType: "approval_request",
    sourceType: "approval",
    sourceId: approval.id,
  })),
}));

vi.mock("../services/hub-source-producers.js", () => ({
  emitHubItem,
  buildApprovalHubEmit,
}));

const mockAgentService = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  getById: vi.fn(),
  list: vi.fn().mockResolvedValue([]),
  orgForCompany: vi.fn().mockResolvedValue([]),
  getChainOfCommand: vi.fn().mockResolvedValue([]),
  backfillParentFields: vi.fn().mockResolvedValue(0),
  listConfigRevisions: vi.fn().mockResolvedValue([]),
}));

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(
    async (_companyId: string, config: Record<string, unknown>) => config,
  ),
  syncEnvBindingsForTarget: vi.fn().mockResolvedValue(undefined),
  resolveAdapterConfigForRuntime: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn().mockResolvedValue(undefined),
}));

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  accessService: () => ({ canUser: vi.fn(), hasPermission: vi.fn() }),
  approvalService: () => mockApprovalService,
  heartbeatService: () => ({ cancelActiveForAgent: vi.fn() }),
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => ({}),
  secretService: () => mockSecretService,
  companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
  agentInstructionsService: () => ({
    materializeManagedBundle: vi.fn(),
  }),
  logActivity: mockLogActivity,
  syncInstructionsBundleConfigFromFilePath: vi.fn(
    (_agent: unknown, config: Record<string, unknown>) => config,
  ),
}));

vi.mock("../adapters/index.js", () => ({
  findActiveServerAdapter: vi.fn(() => undefined),
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

const COMPANY_ID = "company-A";

const localBoardActor = {
  type: "board" as const,
  source: "local_implicit" as const,
  userId: "user-A",
  companyIds: [COMPANY_ID],
  isInstanceAdmin: false,
};

/** Minimal chainable db whose only direct use in the hire route is the company
 *  lookup: db.select().from(companies).where(...).then(rows => rows[0]). */
function makeDb(company: Record<string, unknown> | null) {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    then: (resolve: (rows: unknown[]) => unknown) => resolve(company ? [company] : []),
  };
  return chain as unknown;
}

function makeApp(db: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = localBoardActor;
    next();
  });
  app.use("/api", agentRoutes(db as any));
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSecretService.normalizeAdapterConfigForPersistence.mockImplementation(
    async (_companyId: string, config: Record<string, unknown>) => config,
  );
  mockAgentService.create.mockResolvedValue({
    id: "agent-new",
    companyId: COMPANY_ID,
    name: "New Agent",
    role: "general",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    metadata: {},
    budgetMonthlyCents: 0,
  });
});

describe("POST /companies/:companyId/agent-hires — hub emit (H2)", () => {
  it("emits the hire approval hub item in-line when board approval is required", async () => {
    const company = {
      id: COMPANY_ID,
      requireBoardApprovalForNewAgents: true,
    };
    const approval = {
      id: "approval-1",
      companyId: COMPANY_ID,
      type: "hire_agent",
      requestedByAgentId: null,
      requestedByUserId: "user-A",
      payload: { name: "New Agent", agentId: "agent-new" },
      status: "pending",
      updatedAt: new Date("2026-07-04T00:00:00Z"),
    };
    mockApprovalService.create.mockResolvedValue(approval);

    const res = await request(makeApp(makeDb(company)))
      .post(`/api/companies/${COMPANY_ID}/agent-hires`)
      .send({ name: "New Agent" });

    expect(res.status).toBeLessThan(400);
    expect(mockApprovalService.create).toHaveBeenCalledTimes(1);
    // The emit fires exactly once, with the created approval row.
    expect(buildApprovalHubEmit).toHaveBeenCalledWith(approval);
    expect(emitHubItem).toHaveBeenCalledTimes(1);
    expect(emitHubItem).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        semanticType: "approval_request",
        sourceType: "approval",
        sourceId: "approval-1",
      }),
    );
  });

  it("does not emit when board approval is NOT required (agent created idle)", async () => {
    const company = {
      id: COMPANY_ID,
      requireBoardApprovalForNewAgents: false,
    };

    const res = await request(makeApp(makeDb(company)))
      .post(`/api/companies/${COMPANY_ID}/agent-hires`)
      .send({ name: "New Agent" });

    expect(res.status).toBeLessThan(400);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
    expect(emitHubItem).not.toHaveBeenCalled();
  });

  it("still completes the hire when the hub emit throws (best-effort)", async () => {
    const company = {
      id: COMPANY_ID,
      requireBoardApprovalForNewAgents: true,
    };
    mockApprovalService.create.mockResolvedValue({
      id: "approval-2",
      companyId: COMPANY_ID,
      type: "hire_agent",
      requestedByAgentId: null,
      requestedByUserId: "user-A",
      payload: { name: "New Agent", agentId: "agent-new" },
      status: "pending",
      updatedAt: new Date("2026-07-04T00:00:00Z"),
    });
    emitHubItem.mockRejectedValueOnce(new Error("hub down"));

    const res = await request(makeApp(makeDb(company)))
      .post(`/api/companies/${COMPANY_ID}/agent-hires`)
      .send({ name: "New Agent" });

    // The hire succeeds despite the hub failure (scan-on-read backstop fills it).
    expect(res.status).toBeLessThan(400);
    expect(mockApprovalService.create).toHaveBeenCalledTimes(1);
  });
});
