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

// The canonicalization contract: resolveSkillKeys maps id/slug/normalizable refs to
// their canonical skill.key. Here a slug and an id both resolve to the same canonical
// key that delivery + enforcement compare against.
const CANONICAL = "skill:aoa/design-review";
const SLUG = "design-review";
const SKILL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const mockResolveSkillKeys = vi.hoisted(() => vi.fn());

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
  companySkillService: () => ({
    listRuntimeSkillEntries: vi.fn(),
    resolveSkillKeys: mockResolveSkillKeys,
  }),
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
// Stub it to a no-op so these tests focus on the canonicalization contract.
vi.mock("../middleware/rbac.js", () => ({
  assertRole: vi.fn().mockResolvedValue(undefined),
  assertDepartmentAccess: vi.fn().mockResolvedValue(undefined),
  assertMemoryAccess: vi.fn().mockResolvedValue(undefined),
  assertMemoryApproval: vi.fn().mockResolvedValue(undefined),
  assertEntityAccess: vi.fn().mockResolvedValue(undefined),
}));

import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";

const boardActor = {
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

function patchArgFor(): Record<string, unknown> {
  return mockAgentService.update.mock.calls.at(-1)![1] as Record<string, unknown>;
}

describe("PATCH /agents/:id — skillKeys are canonicalized before persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.getById.mockResolvedValue({ id: AGENT_ID, companyId: "company-A" });
    mockAgentService.update.mockResolvedValue({
      id: AGENT_ID,
      companyId: "company-A",
      skillKeys: [CANONICAL],
    });
    // resolveSkillKeys accepts id/slug/normalizable refs and returns canonical skill.key.
    mockResolveSkillKeys.mockResolvedValue([CANONICAL]);
  });

  it("persists the CANONICAL key when a SLUG is submitted (not the raw slug)", async () => {
    const res = await request(makeApp(boardActor))
      .patch(`/api/agents/${AGENT_ID}`)
      .send({ skillKeys: [SLUG] });
    expect(res.status).toBe(200);

    // The route must resolve against the company's skills…
    expect(mockResolveSkillKeys).toHaveBeenCalledWith("company-A", [SLUG]);
    // …AND persist the RESOLVED canonical key, not the raw submitted slug. Delivery
    // (allSkills.filter includes skill.key) and enforcement (allowed.includes skill.key)
    // both compare against the canonical key, so storing the slug silently no-ops.
    expect(patchArgFor().skillKeys).toEqual([CANONICAL]);
    expect(patchArgFor().skillKeys).not.toEqual([SLUG]);
  });

  it("persists the CANONICAL key when a skill UUID is submitted", async () => {
    const res = await request(makeApp(boardActor))
      .patch(`/api/agents/${AGENT_ID}`)
      .send({ skillKeys: [SKILL_ID] });
    expect(res.status).toBe(200);
    expect(mockResolveSkillKeys).toHaveBeenCalledWith("company-A", [SKILL_ID]);
    expect(patchArgFor().skillKeys).toEqual([CANONICAL]);
  });

  it("an empty array still persists as [] (clear semantics preserved — no resolution)", async () => {
    mockAgentService.update.mockResolvedValue({
      id: AGENT_ID,
      companyId: "company-A",
      skillKeys: [],
    });
    const res = await request(makeApp(boardActor))
      .patch(`/api/agents/${AGENT_ID}`)
      .send({ skillKeys: [] });
    expect(res.status).toBe(200);
    // The empty-clear path must NOT run resolution and must persist [] verbatim.
    expect(mockResolveSkillKeys).not.toHaveBeenCalled();
    expect(patchArgFor().skillKeys).toEqual([]);
  });
});
