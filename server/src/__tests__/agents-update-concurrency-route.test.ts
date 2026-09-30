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
  companySkillService: () => ({ listRuntimeSkillEntries: vi.fn(), resolveSkillKeys: vi.fn() }),
  heartbeatService: () => ({ cancelActiveForAgent: vi.fn().mockResolvedValue(undefined) }),
  issueApprovalService: () => ({}),
  issueService: () => ({}),
  logActivity: vi.fn(),
  secretService: () => ({
    resolveAdapterConfigForRuntime: vi.fn(),
    normalizeAdapterConfigForPersistence: vi.fn(
      async (_companyId: string, config: Record<string, unknown>) => config,
    ),
    syncEnvBindingsForTarget: vi.fn(),
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

vi.mock("@armyofagents/adapter-claude-local/server", () => ({ runClaudeLogin: vi.fn() }));
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

// rbac is real otherwise — assertCanUpdateAgent's board branch calls
// assertRole(db, …, "founder") which queries the (empty) mock db and 500s.
// Stub it to a no-op so these tests focus on the token-plumbing contract.
vi.mock("../middleware/rbac.js", () => ({
  assertRole: vi.fn().mockResolvedValue(undefined),
  assertDepartmentAccess: vi.fn().mockResolvedValue(undefined),
  assertMemoryAccess: vi.fn().mockResolvedValue(undefined),
  assertMemoryApproval: vi.fn().mockResolvedValue(undefined),
  assertEntityAccess: vi.fn().mockResolvedValue(undefined),
}));

import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";
import { conflict } from "../errors.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";

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

describe("PATCH /agents/:id — optimistic concurrency token plumbing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards expectedUpdatedAt ONLY via the options object — never in the patch", async () => {
    mockAgentService.getById.mockResolvedValue({ id: AGENT_ID, companyId: "company-A" });
    mockAgentService.update.mockResolvedValue({ id: AGENT_ID, companyId: "company-A", title: "X" });
    const iso = new Date("2026-06-25T12:00:00.000Z").toISOString();
    const res = await request(makeApp(companyAActor))
      .patch(`/api/agents/${AGENT_ID}`)
      .send({ title: "X", expectedUpdatedAt: iso });
    expect(res.status).toBe(200);
    // The token must ride in the THIRD arg (options), not the SECOND (patch) —
    // otherwise it flows into `.set({ ...normalizedPatch, updatedAt })` in the
    // service and Drizzle attempts to write a non-column field.
    expect(mockAgentService.update).toHaveBeenCalledWith(
      AGENT_ID,
      expect.objectContaining({ title: "X" }),
      expect.objectContaining({ expectedUpdatedAt: iso }),
    );
    const [, patchArg, optionsArg] = mockAgentService.update.mock.calls.at(-1)!;
    // CRITICAL (Codex P1 #1): the patch object passed to svc.update must NOT carry
    // the transport-only token, or it would reach `.set()` as a phantom column.
    expect(patchArg).not.toHaveProperty("expectedUpdatedAt");
    expect(optionsArg).toHaveProperty("expectedUpdatedAt", iso);
  });

  it("maps a service conflict to 409 with currentUpdatedAt (ISO string)", async () => {
    mockAgentService.getById.mockResolvedValue({ id: AGENT_ID, companyId: "company-A" });
    // The service throws `currentUpdatedAt` as an ISO STRING (it calls
    // `current.updatedAt.toISOString()` — errorHandler does NOT coerce Dates inside
    // the raw HttpError). Mirror that exact shape here so the mock matches reality.
    const t1Iso = new Date("2026-06-25T12:05:00.000Z").toISOString();
    mockAgentService.update.mockRejectedValue(
      conflict("This agent was changed by someone else. Reload and re-apply your change.", {
        currentUpdatedAt: t1Iso,
      }),
    );
    const res = await request(makeApp(companyAActor))
      .patch(`/api/agents/${AGENT_ID}`)
      .send({ title: "X", expectedUpdatedAt: "2026-06-25T12:00:00.000Z" });
    expect(res.status).toBe(409);
    expect(res.body.details.currentUpdatedAt).toBe(t1Iso);
  });

  it("back-compat: no token still updates (200, no token in options)", async () => {
    mockAgentService.getById.mockResolvedValue({ id: AGENT_ID, companyId: "company-A" });
    mockAgentService.update.mockResolvedValue({ id: AGENT_ID, companyId: "company-A", title: "X" });
    const res = await request(makeApp(companyAActor)).patch(`/api/agents/${AGENT_ID}`).send({ title: "X" });
    expect(res.status).toBe(200);
    const opts = mockAgentService.update.mock.calls.at(-1)![2];
    expect(opts).not.toHaveProperty("expectedUpdatedAt");
  });
});
