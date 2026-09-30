import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { drizzleOperatorStubs, makeTableProxy } from "./helpers/drizzle-mock.js";

vi.mock("drizzle-orm", () => drizzleOperatorStubs());

vi.mock("@armyofagents/db", () => ({
  agents: makeTableProxy("agents"),
  aoaAgentTriggers: makeTableProxy("aoa_agent_triggers"),
  companies: makeTableProxy("companies"),
  heartbeatRuns: makeTableProxy("heartbeat_runs"),
  internalAgentRuns: makeTableProxy("internal_agent_runs"),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  create: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  terminate: vi.fn(),
  remove: vi.fn(),
  list: vi.fn().mockResolvedValue([]),
  resolveByReference: vi.fn(),
  update: vi.fn(),
  updatePermissions: vi.fn(),
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

const mockAgentInstructionsService = vi.hoisted(() => ({
  getBundle: vi.fn(),
  readFile: vi.fn(),
  updateBundle: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  exportFiles: vi.fn(),
  ensureManagedBundle: vi.fn(),
  materializeManagedBundle: vi.fn(),
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
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => ({ canUser: vi.fn(), hasPermission: vi.fn() }),
  approvalService: () => ({}),
  companySkillService: () => ({ listRuntimeSkillEntries: vi.fn(), resolveSkillKeys: vi.fn().mockResolvedValue([]) }),
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => ({}),
  issueService: () => ({}),
  logActivity: vi.fn(),
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

// ── RBAC mock — controls assertRole behaviour per test ──────────────────────
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
import { forbidden } from "../errors.js";

const COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const TRIGGER_ID = "22222222-2222-4222-8222-222222222222";

const founderActor = {
  type: "board" as const,
  source: "session" as const,
  userId: "founder-user",
  companyIds: [COMPANY_ID],
  isInstanceAdmin: false,
};

const memberActor = {
  type: "board" as const,
  source: "session" as const,
  userId: "member-user",
  companyIds: [COMPANY_ID],
  isInstanceAdmin: false,
};

// An agent calling the API with an agent key (req.actor.type === "agent").
const agentActor = {
  type: "agent" as const,
  source: "agent_key" as const,
  agentId: "33333333-3333-4333-8333-333333333333",
  companyId: COMPANY_ID,
  runId: null,
};

// Chainable mock DB for insert/update chains used by trigger endpoints
function makeTriggerDb(insertResult: Record<string, unknown>, updateResult: Record<string, unknown> | null = null) {
  return {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn().mockReturnThis(),
        then: vi.fn((fn: (rows: unknown[]) => unknown) =>
          Promise.resolve(fn([insertResult])),
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

function makeApp(
  actor: typeof founderActor | typeof memberActor | typeof agentActor,
  db: unknown = {},
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", agentRoutes(db as never));
  app.use(errorHandler);
  return app;
}

describe("AoA RBAC — D1 (founder-gated create / disable / triggers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── AoA create (C4): POST /companies/:companyId/agents ──────────────────────

  describe("POST /companies/:companyId/agents {kind:'aoa'}", () => {
    it("non-founder → 403", async () => {
      // Simulate assertRole throwing forbidden for a non-founder
      mockAssertRole.mockRejectedValueOnce(forbidden("Requires one of: founder"));

      const res = await request(makeApp(memberActor))
        .post(`/api/companies/${COMPANY_ID}/agents`)
        .send({ name: "AoA Commander", kind: "aoa", adapterType: "process" });

      expect(res.status).toBe(403);
      expect(mockAssertRole).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        COMPANY_ID,
        "founder",
      );
      expect(mockAgentService.create).not.toHaveBeenCalled();
    });

    it("founder → 201", async () => {
      // assertRole resolves (default) — founder passes
      mockAssertRole.mockResolvedValueOnce(undefined);

      const createdAgent = {
        id: AGENT_ID,
        companyId: COMPANY_ID,
        name: "AoA Commander",
        kind: "aoa",
        role: "general",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        status: "idle",
      };
      mockAgentService.create.mockResolvedValueOnce(createdAgent);
      // materializeDefaultInstructionsBundleForNewAgent returns early for "process" adapter
      // since adapterSupportsInstructionsBundle("process") is false

      const res = await request(makeApp(founderActor))
        .post(`/api/companies/${COMPANY_ID}/agents`)
        .send({ name: "AoA Commander", kind: "aoa", adapterType: "process" });

      expect(res.status).toBe(201);
      expect(mockAssertRole).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        COMPANY_ID,
        "founder",
      );
      expect(mockAgentService.create).toHaveBeenCalled();
    });
  });

  // ── AoA pause (D1): POST /companies/:companyId/agents/:id/pause ─────────────

  describe("POST /companies/:companyId/agents/:id/pause {kind:'aoa'}", () => {
    const aoaAgent = {
      id: AGENT_ID,
      companyId: COMPANY_ID,
      kind: "aoa",
      name: "AoA Commander",
      status: "idle",
    };

    it("team_member → 403", async () => {
      mockAgentService.getById.mockResolvedValueOnce(aoaAgent);
      mockAssertRole.mockRejectedValueOnce(forbidden("Requires one of: founder"));

      const res = await request(makeApp(memberActor))
        .post(`/api/agents/${AGENT_ID}/pause`);

      expect(res.status).toBe(403);
      expect(mockAssertRole).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        COMPANY_ID,
        "founder",
      );
      expect(mockAgentService.pause).not.toHaveBeenCalled();
    });

    it("founder → 200", async () => {
      mockAgentService.getById.mockResolvedValueOnce(aoaAgent);
      mockAssertRole.mockResolvedValueOnce(undefined);

      const pausedAgent = { ...aoaAgent, status: "paused" };
      mockAgentService.pause.mockResolvedValueOnce(pausedAgent);

      const res = await request(makeApp(founderActor))
        .post(`/api/agents/${AGENT_ID}/pause`);

      expect(res.status).toBe(200);
      expect(mockAssertRole).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        COMPANY_ID,
        "founder",
      );
      expect(mockAgentService.pause).toHaveBeenCalledWith(AGENT_ID);
    });
  });

  // ── AoA trigger (C1): PATCH /companies/:companyId/agents/:id/triggers/:triggerId ──

  describe("PATCH /companies/:companyId/agents/:id/triggers/:triggerId", () => {
    it("team_member → 403", async () => {
      // Simulate assertRole throwing forbidden for a non-founder
      mockAssertRole.mockRejectedValueOnce(forbidden("Requires one of: founder"));

      const res = await request(makeApp(memberActor))
        .patch(`/api/companies/${COMPANY_ID}/agents/${AGENT_ID}/triggers/${TRIGGER_ID}`)
        .send({ enabled: false });

      expect(res.status).toBe(403);
      expect(mockAssertRole).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        COMPANY_ID,
        "founder",
      );
    });

    it("founder → 200", async () => {
      mockAssertRole.mockResolvedValueOnce(undefined);

      const updatedTrigger = {
        id: TRIGGER_ID,
        companyId: COMPANY_ID,
        agentId: AGENT_ID,
        kind: "schedule",
        enabled: false,
        config: {},
        updatedAt: new Date().toISOString(),
      };
      const db = makeTriggerDb(
        { id: TRIGGER_ID },
        updatedTrigger,
      );

      const res = await request(makeApp(founderActor, db))
        .patch(`/api/companies/${COMPANY_ID}/agents/${AGENT_ID}/triggers/${TRIGGER_ID}`)
        .send({ enabled: false });

      expect(res.status).toBe(200);
      expect(mockAssertRole).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        COMPANY_ID,
        "founder",
      );
    });
  });
});

describe("AoA RBAC — M1/M2 (founder-gated PATCH + resume; spec §10)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks does NOT drain queued mock*Once values. The M1 fix can
    // reject before a queued actor-agent getById is consumed, so a stale
    // once-value would leak into the next test and shift its mock sequence.
    // Fully reset the mocks this suite drives so each test is hermetic.
    mockAgentService.getById.mockReset();
    mockAgentService.update.mockReset();
    mockAgentService.resume.mockReset();
    mockAgentService.pause.mockReset();
    mockAssertRole.mockReset().mockResolvedValue(undefined);
  });

  const aoaAgent = {
    id: AGENT_ID,
    companyId: COMPANY_ID,
    kind: "aoa",
    name: "AoA Commander",
    role: "general",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    status: "idle",
    permissions: {},
  };

  const orgAgent = {
    id: AGENT_ID,
    companyId: COMPANY_ID,
    kind: "org",
    name: "Worker",
    role: "general",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    status: "idle",
    permissions: {},
  };

  // The CXO agent that an agent-actor key resolves to (req.actor.agentId).
  const cxoAgentRecord = {
    id: agentActor.agentId,
    companyId: COMPANY_ID,
    kind: "org",
    name: "Chief of Staff",
    role: "cxo",
    permissions: { canCreateAgents: true },
  };

  // ── M1: PATCH /agents/:id on a kind='aoa' agent ───────────────────────────

  describe("PATCH /agents/:id {kind:'aoa'}", () => {
    it("(M1-core) agent actor (cxo / create grant, NOT founder) → 403", async () => {
      // Resolve by id so the assertion does not depend on call ordering:
      // target id → aoa agent; actor agent id → the actor's own cxo record
      // (pre-fix the cxo agent passed assertCanUpdateAgent and reached update).
      mockAgentService.getById.mockImplementation(async (lookupId: string) =>
        lookupId === agentActor.agentId ? cxoAgentRecord : aoaAgent,
      );

      const res = await request(makeApp(agentActor))
        .patch(`/api/agents/${AGENT_ID}`)
        .send({ status: "paused" });

      expect(res.status).toBe(403);
      expect(mockAgentService.update).not.toHaveBeenCalled();
    });

    it("non-founder board user → 403", async () => {
      mockAgentService.getById.mockResolvedValueOnce(aoaAgent);
      // assertCanUpdateAgent's board branch delegates to assertRole(...,"founder").
      mockAssertRole.mockRejectedValueOnce(forbidden("Requires one of: founder"));

      const res = await request(makeApp(memberActor))
        .patch(`/api/agents/${AGENT_ID}`)
        .send({ status: "paused" });

      expect(res.status).toBe(403);
      expect(mockAssertRole).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        COMPANY_ID,
        "founder",
      );
      expect(mockAgentService.update).not.toHaveBeenCalled();
    });

    it("founder board user → 200", async () => {
      mockAgentService.getById.mockResolvedValueOnce(aoaAgent);
      mockAssertRole.mockResolvedValueOnce(undefined);
      mockAgentService.update.mockResolvedValueOnce({ ...aoaAgent, status: "paused" });

      const res = await request(makeApp(founderActor))
        .patch(`/api/agents/${AGENT_ID}`)
        .send({ status: "paused" });

      expect(res.status).toBe(200);
      expect(mockAssertRole).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        COMPANY_ID,
        "founder",
      );
      expect(mockAgentService.update).toHaveBeenCalled();
    });
  });

  // ── M1 regression: PATCH /agents/:id on a kind='org' agent (unchanged) ─────

  describe("PATCH /agents/:id {kind:'org'} — behaviour unchanged", () => {
    it("agent actor (cxo) → 200 (org agents NOT founder-gated)", async () => {
      mockAgentService.getById.mockImplementation(async (lookupId: string) =>
        lookupId === agentActor.agentId ? cxoAgentRecord : orgAgent,
      );
      mockAgentService.update.mockResolvedValueOnce({ ...orgAgent, status: "paused" });

      const res = await request(makeApp(agentActor))
        .patch(`/api/agents/${AGENT_ID}`)
        .send({ status: "paused" });

      expect(res.status).toBe(200);
      // assertRole must NOT be invoked for a kind='org' target.
      expect(mockAssertRole).not.toHaveBeenCalled();
      expect(mockAgentService.update).toHaveBeenCalled();
    });

    it("non-founder board user → behaviour delegated to assertRole (200 when it passes)", async () => {
      mockAgentService.getById.mockResolvedValueOnce(orgAgent);
      mockAssertRole.mockResolvedValueOnce(undefined);
      mockAgentService.update.mockResolvedValueOnce({ ...orgAgent, status: "paused" });

      const res = await request(makeApp(memberActor))
        .patch(`/api/agents/${AGENT_ID}`)
        .send({ status: "paused" });

      expect(res.status).toBe(200);
      expect(mockAgentService.update).toHaveBeenCalled();
    });
  });

  // ── M2: POST /agents/:id/resume on a kind='aoa' agent ─────────────────────

  describe("POST /agents/:id/resume {kind:'aoa'}", () => {
    it("non-founder board user → 403", async () => {
      mockAgentService.getById.mockResolvedValueOnce(aoaAgent);
      mockAssertRole.mockRejectedValueOnce(forbidden("Requires one of: founder"));

      const res = await request(makeApp(memberActor))
        .post(`/api/agents/${AGENT_ID}/resume`);

      expect(res.status).toBe(403);
      expect(mockAssertRole).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        COMPANY_ID,
        "founder",
      );
      expect(mockAgentService.resume).not.toHaveBeenCalled();
    });

    it("founder board user → 200", async () => {
      mockAgentService.getById.mockResolvedValueOnce(aoaAgent);
      mockAssertRole.mockResolvedValueOnce(undefined);
      mockAgentService.resume.mockResolvedValueOnce({ ...aoaAgent, status: "idle" });

      const res = await request(makeApp(founderActor))
        .post(`/api/agents/${AGENT_ID}/resume`);

      expect(res.status).toBe(200);
      expect(mockAssertRole).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        COMPANY_ID,
        "founder",
      );
      expect(mockAgentService.resume).toHaveBeenCalledWith(AGENT_ID);
    });
  });

  // ── M2 regression: POST /agents/:id/resume on kind='org' (unchanged) ───────

  describe("POST /agents/:id/resume {kind:'org'} — behaviour unchanged", () => {
    it("non-founder board user → 200 (org resume NOT founder-gated)", async () => {
      mockAgentService.getById.mockResolvedValueOnce(orgAgent);
      mockAgentService.resume.mockResolvedValueOnce({ ...orgAgent, status: "idle" });

      const res = await request(makeApp(memberActor))
        .post(`/api/agents/${AGENT_ID}/resume`);

      expect(res.status).toBe(200);
      // assertRole must NOT be invoked for a kind='org' resume.
      expect(mockAssertRole).not.toHaveBeenCalled();
      expect(mockAgentService.resume).toHaveBeenCalledWith(AGENT_ID);
    });
  });
});

describe("AoA RBAC — FX6/MIN-1 (founder-gated permissions + instructions; spec §10)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks does NOT drain queued mock*Once values. These handlers can
    // reject before a queued actor-agent getById is consumed, so a stale
    // once-value would leak into the next test. Fully reset every mock this
    // suite drives so each test is hermetic (mirrors the M1/M2 suite).
    mockAgentService.getById.mockReset();
    mockAgentService.update.mockReset();
    mockAgentService.updatePermissions.mockReset();
    mockAgentService.getChainOfCommand.mockReset().mockResolvedValue([]);
    mockAgentInstructionsService.updateBundle.mockReset();
    mockAgentInstructionsService.writeFile.mockReset();
    mockAgentInstructionsService.deleteFile.mockReset();
    mockAssertRole.mockReset().mockResolvedValue(undefined);
  });

  const aoaAgent = {
    id: AGENT_ID,
    companyId: COMPANY_ID,
    kind: "aoa",
    name: "AoA Commander",
    role: "general",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    status: "idle",
    permissions: {},
  };

  const orgAgent = {
    id: AGENT_ID,
    companyId: COMPANY_ID,
    kind: "org",
    name: "Worker",
    role: "general",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    status: "idle",
    permissions: {},
  };

  // The CXO agent that an agent-actor key resolves to (req.actor.agentId).
  // Pre-fix this agent passed /permissions (role === "cxo") and
  // assertCanManageInstructionsPath has no kind check for a non-founder board
  // actor — both were the open governance holes MIN-1 closes.
  const cxoAgentRecord = {
    id: agentActor.agentId,
    companyId: COMPANY_ID,
    kind: "org",
    name: "Chief of Staff",
    role: "cxo",
    permissions: { canCreateAgents: true },
  };

  const bundleResult = {
    bundle: {
      agentId: AGENT_ID,
      companyId: COMPANY_ID,
      mode: "external",
      rootPath: "/tmp/external",
      managedRootPath: "/tmp/agent-1",
      entryFile: "AGENTS.md",
      resolvedEntryPath: "/tmp/external/AGENTS.md",
      editable: true,
      warnings: [],
      legacyPromptTemplateActive: false,
      legacyBootstrapPromptTemplateActive: false,
      files: [],
    },
    adapterConfig: {
      instructionsBundleMode: "external",
      instructionsRootPath: "/tmp/external",
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: "/tmp/external/AGENTS.md",
    },
  };

  // ── R1: PATCH /agents/:id/permissions ─────────────────────────────────────

  describe("PATCH /agents/:id/permissions {kind:'aoa'}", () => {
    it("(FX6-core) agent actor (cxo, NOT founder) → 403", async () => {
      mockAgentService.getById.mockImplementation(async (lookupId: string) =>
        lookupId === agentActor.agentId ? cxoAgentRecord : aoaAgent,
      );

      const res = await request(makeApp(agentActor))
        .patch(`/api/agents/${AGENT_ID}/permissions`)
        .send({ canCreateAgents: true });

      expect(res.status).toBe(403);
      expect(mockAgentService.updatePermissions).not.toHaveBeenCalled();
    });

    it("non-founder board user → 403", async () => {
      mockAgentService.getById.mockResolvedValueOnce(aoaAgent);
      mockAssertRole.mockRejectedValueOnce(forbidden("Requires one of: founder"));

      const res = await request(makeApp(memberActor))
        .patch(`/api/agents/${AGENT_ID}/permissions`)
        .send({ canCreateAgents: true });

      expect(res.status).toBe(403);
      expect(mockAssertRole).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        COMPANY_ID,
        "founder",
      );
      expect(mockAgentService.updatePermissions).not.toHaveBeenCalled();
    });

    it("founder board user → 200", async () => {
      mockAgentService.getById.mockResolvedValueOnce(aoaAgent);
      mockAssertRole.mockResolvedValueOnce(undefined);
      mockAgentService.updatePermissions.mockResolvedValueOnce({
        ...aoaAgent,
        permissions: { canCreateAgents: true },
      });

      const res = await request(makeApp(founderActor))
        .patch(`/api/agents/${AGENT_ID}/permissions`)
        .send({ canCreateAgents: true });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockAssertRole).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        COMPANY_ID,
        "founder",
      );
      expect(mockAgentService.updatePermissions).toHaveBeenCalled();
    });
  });

  describe("PATCH /agents/:id/permissions {kind:'org'} — behaviour unchanged", () => {
    it("agent actor (cxo) → 200 (org permissions NOT founder-gated)", async () => {
      mockAgentService.getById.mockImplementation(async (lookupId: string) =>
        lookupId === agentActor.agentId ? cxoAgentRecord : orgAgent,
      );
      mockAgentService.updatePermissions.mockResolvedValueOnce({
        ...orgAgent,
        permissions: { canCreateAgents: true },
      });

      const res = await request(makeApp(agentActor))
        .patch(`/api/agents/${AGENT_ID}/permissions`)
        .send({ canCreateAgents: true });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      // assertRole must NOT be invoked for a kind='org' target.
      expect(mockAssertRole).not.toHaveBeenCalled();
      expect(mockAgentService.updatePermissions).toHaveBeenCalled();
    });

    it("non-founder board user → 200 (no role gate pre/post for org)", async () => {
      mockAgentService.getById.mockResolvedValueOnce(orgAgent);
      mockAgentService.updatePermissions.mockResolvedValueOnce({
        ...orgAgent,
        permissions: { canCreateAgents: true },
      });

      const res = await request(makeApp(memberActor))
        .patch(`/api/agents/${AGENT_ID}/permissions`)
        .send({ canCreateAgents: true });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockAssertRole).not.toHaveBeenCalled();
      expect(mockAgentService.updatePermissions).toHaveBeenCalled();
    });
  });

  // ── R2: PATCH /agents/:id/instructions-path ───────────────────────────────

  describe("PATCH /agents/:id/instructions-path {kind:'aoa'}", () => {
    it("(FX6-core) agent actor (cxo, NOT founder) → 403", async () => {
      mockAgentService.getById.mockImplementation(async (lookupId: string) =>
        lookupId === agentActor.agentId ? cxoAgentRecord : aoaAgent,
      );

      const res = await request(makeApp(agentActor))
        .patch(`/api/agents/${AGENT_ID}/instructions-path`)
        .send({ path: "/tmp/AGENTS.md" });

      expect(res.status).toBe(403);
      expect(mockAgentService.update).not.toHaveBeenCalled();
    });

    it("non-founder board user → 403", async () => {
      mockAgentService.getById.mockResolvedValueOnce(aoaAgent);
      mockAssertRole.mockRejectedValueOnce(forbidden("Requires one of: founder"));

      const res = await request(makeApp(memberActor))
        .patch(`/api/agents/${AGENT_ID}/instructions-path`)
        .send({ path: "/tmp/AGENTS.md" });

      expect(res.status).toBe(403);
      expect(mockAssertRole).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        COMPANY_ID,
        "founder",
      );
      expect(mockAgentService.update).not.toHaveBeenCalled();
    });

    it("founder board user → 200", async () => {
      mockAgentService.getById.mockResolvedValueOnce(aoaAgent);
      mockAssertRole.mockResolvedValueOnce(undefined);
      mockAgentService.update.mockResolvedValueOnce({
        ...aoaAgent,
        adapterType: "process",
        adapterConfig: { instructions: "/tmp/AGENTS.md" },
      });

      const res = await request(makeApp(founderActor))
        .patch(`/api/agents/${AGENT_ID}/instructions-path`)
        .send({ path: "/tmp/AGENTS.md", adapterConfigKey: "instructions" });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockAssertRole).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        COMPANY_ID,
        "founder",
      );
      expect(mockAgentService.update).toHaveBeenCalled();
    });
  });

  describe("PATCH /agents/:id/instructions-path {kind:'org'} — behaviour unchanged", () => {
    it("non-founder board user → 200 (board passes; no role gate for org)", async () => {
      mockAgentService.getById.mockResolvedValueOnce(orgAgent);
      mockAgentService.update.mockResolvedValueOnce({
        ...orgAgent,
        adapterType: "process",
        adapterConfig: { instructions: "/tmp/AGENTS.md" },
      });

      const res = await request(makeApp(memberActor))
        .patch(`/api/agents/${AGENT_ID}/instructions-path`)
        .send({ path: "/tmp/AGENTS.md", adapterConfigKey: "instructions" });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      // assertRole must NOT be invoked for a kind='org' instructions-path edit.
      expect(mockAssertRole).not.toHaveBeenCalled();
      expect(mockAgentService.update).toHaveBeenCalled();
    });
  });

  // ── R3: PATCH /agents/:id/instructions-bundle ─────────────────────────────

  describe("PATCH /agents/:id/instructions-bundle {kind:'aoa'}", () => {
    it("(FX6-core) agent actor (cxo, NOT founder) → 403", async () => {
      mockAgentService.getById.mockImplementation(async (lookupId: string) =>
        lookupId === agentActor.agentId ? cxoAgentRecord : aoaAgent,
      );

      const res = await request(makeApp(agentActor))
        .patch(`/api/agents/${AGENT_ID}/instructions-bundle`)
        .send({ mode: "external", rootPath: "/tmp/external" });

      expect(res.status).toBe(403);
      expect(mockAgentInstructionsService.updateBundle).not.toHaveBeenCalled();
      expect(mockAgentService.update).not.toHaveBeenCalled();
    });

    it("non-founder board user → 403", async () => {
      mockAgentService.getById.mockResolvedValueOnce(aoaAgent);
      mockAssertRole.mockRejectedValueOnce(forbidden("Requires one of: founder"));

      const res = await request(makeApp(memberActor))
        .patch(`/api/agents/${AGENT_ID}/instructions-bundle`)
        .send({ mode: "external", rootPath: "/tmp/external" });

      expect(res.status).toBe(403);
      expect(mockAssertRole).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        COMPANY_ID,
        "founder",
      );
      expect(mockAgentInstructionsService.updateBundle).not.toHaveBeenCalled();
      expect(mockAgentService.update).not.toHaveBeenCalled();
    });

    it("founder board user → 200", async () => {
      mockAgentService.getById.mockResolvedValueOnce(aoaAgent);
      mockAssertRole.mockResolvedValueOnce(undefined);
      mockAgentInstructionsService.updateBundle.mockResolvedValueOnce(bundleResult);
      mockAgentService.update.mockResolvedValueOnce({
        ...aoaAgent,
        adapterConfig: bundleResult.adapterConfig,
      });

      const res = await request(makeApp(founderActor))
        .patch(`/api/agents/${AGENT_ID}/instructions-bundle`)
        .send({ mode: "external", rootPath: "/tmp/external" });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockAssertRole).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        COMPANY_ID,
        "founder",
      );
      expect(mockAgentInstructionsService.updateBundle).toHaveBeenCalled();
      expect(mockAgentService.update).toHaveBeenCalled();
    });
  });

  describe("PATCH /agents/:id/instructions-bundle {kind:'org'} — behaviour unchanged", () => {
    it("non-founder board user → 200 (board passes; no role gate for org)", async () => {
      mockAgentService.getById.mockResolvedValueOnce(orgAgent);
      mockAgentInstructionsService.updateBundle.mockResolvedValueOnce(bundleResult);
      mockAgentService.update.mockResolvedValueOnce({
        ...orgAgent,
        adapterConfig: bundleResult.adapterConfig,
      });

      const res = await request(makeApp(memberActor))
        .patch(`/api/agents/${AGENT_ID}/instructions-bundle`)
        .send({ mode: "external", rootPath: "/tmp/external" });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      // assertRole must NOT be invoked for a kind='org' instructions-bundle edit.
      expect(mockAssertRole).not.toHaveBeenCalled();
      expect(mockAgentInstructionsService.updateBundle).toHaveBeenCalled();
      expect(mockAgentService.update).toHaveBeenCalled();
    });
  });
});

describe("AoA RBAC — FX-del (AoA agents are non-deletable / non-terminable)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks does NOT drain queued mock*Once values; fully reset the
    // mocks this suite drives so each test is hermetic (mirrors M1/M2).
    mockAgentService.getById.mockReset();
    mockAgentService.terminate.mockReset();
    mockAgentService.remove.mockReset();
    mockAssertRole.mockReset().mockResolvedValue(undefined);
    mockHeartbeatService.cancelActiveForAgent.mockReset().mockResolvedValue(undefined);
  });

  const aoaAgent = {
    id: AGENT_ID,
    companyId: COMPANY_ID,
    kind: "aoa",
    name: "AoA Commander",
    role: "general",
    status: "idle",
  };

  const orgAgent = {
    id: AGENT_ID,
    companyId: COMPANY_ID,
    kind: "org",
    name: "Worker",
    role: "general",
    status: "idle",
  };

  // ── DELETE /agents/:id on a kind='aoa' agent → hard-blocked (409) ──────────

  describe("DELETE /agents/:id {kind:'aoa'} — hard-blocked for ALL actors", () => {
    it("founder board user → 409 (founders included; before the founder gate)", async () => {
      mockAgentService.getById.mockResolvedValueOnce(aoaAgent);

      const res = await request(makeApp(founderActor))
        .delete(`/api/agents/${AGENT_ID}`);

      expect(res.status, JSON.stringify(res.body)).toBe(409);
      // The hard-block runs BEFORE the founder gate — assertRole never invoked.
      expect(mockAssertRole).not.toHaveBeenCalled();
      expect(mockAgentService.remove).not.toHaveBeenCalled();
    });

    it("non-founder board user → 409", async () => {
      mockAgentService.getById.mockResolvedValueOnce(aoaAgent);

      const res = await request(makeApp(memberActor))
        .delete(`/api/agents/${AGENT_ID}`);

      expect(res.status).toBe(409);
      expect(mockAgentService.remove).not.toHaveBeenCalled();
    });

    it("agent actor → blocked (403, structurally barred from this board-only route; never deletes)", async () => {
      // DELETE /agents/:id is a board-only route: assertBoard(req) rejects any
      // non-board actor (403 "Board access required") at route entry — an
      // agent-key actor can never reach the handler body, so it can never
      // delete an AoA (or any) agent. The FX-del 409 hard-block additionally
      // bars *board* actors (founders included). Net for an agent actor:
      // blocked. This 403 is pre-existing, byte-unchanged behaviour.
      mockAgentService.getById.mockResolvedValue(aoaAgent);

      const res = await request(makeApp(agentActor))
        .delete(`/api/agents/${AGENT_ID}`);

      expect(res.status).toBe(403);
      expect(mockAgentService.remove).not.toHaveBeenCalled();
    });
  });

  // ── POST /agents/:id/terminate on a kind='aoa' agent → hard-blocked (409) ──

  describe("POST /agents/:id/terminate {kind:'aoa'} — hard-blocked for ALL actors", () => {
    it("founder board user → 409", async () => {
      mockAgentService.getById.mockResolvedValueOnce(aoaAgent);

      const res = await request(makeApp(founderActor))
        .post(`/api/agents/${AGENT_ID}/terminate`);

      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(mockAgentService.terminate).not.toHaveBeenCalled();
      expect(mockHeartbeatService.cancelActiveForAgent).not.toHaveBeenCalled();
    });

    it("non-founder board user → 409", async () => {
      mockAgentService.getById.mockResolvedValueOnce(aoaAgent);

      const res = await request(makeApp(memberActor))
        .post(`/api/agents/${AGENT_ID}/terminate`);

      expect(res.status).toBe(409);
      expect(mockAgentService.terminate).not.toHaveBeenCalled();
    });

    it("agent actor → blocked (403, structurally barred from this board-only route; never terminates)", async () => {
      // POST /agents/:id/terminate is a board-only route: assertBoard(req)
      // rejects any non-board actor (403 "Board access required") at route
      // entry — an agent-key actor can never reach the handler body, so it
      // can never terminate an AoA (or any) agent. The FX-del 409 hard-block
      // additionally bars *board* actors (founders included). Net for an
      // agent actor: blocked. This 403 is pre-existing, byte-unchanged.
      mockAgentService.getById.mockResolvedValue(aoaAgent);

      const res = await request(makeApp(agentActor))
        .post(`/api/agents/${AGENT_ID}/terminate`);

      expect(res.status).toBe(403);
      expect(mockAgentService.terminate).not.toHaveBeenCalled();
    });
  });

  // ── kind='org' delete/terminate — behaviour byte-unchanged ────────────────

  describe("kind='org' delete/terminate — behaviour unchanged", () => {
    it("DELETE /agents/:id {kind:'org'} founder → 200 (still works, not blocked)", async () => {
      mockAgentService.getById.mockResolvedValueOnce(orgAgent);
      mockAssertRole.mockResolvedValueOnce(undefined);
      mockAgentService.remove.mockResolvedValueOnce({ ...orgAgent });

      const res = await request(makeApp(founderActor))
        .delete(`/api/agents/${AGENT_ID}`);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      // org delete is still founder-gated (unchanged) — assertRole IS invoked.
      expect(mockAssertRole).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        COMPANY_ID,
        "founder",
      );
      expect(mockAgentService.remove).toHaveBeenCalledWith(AGENT_ID);
    });

    it("POST /agents/:id/terminate {kind:'org'} → 200 (still works, not blocked)", async () => {
      mockAgentService.getById.mockResolvedValueOnce(orgAgent);
      mockAgentService.terminate.mockResolvedValueOnce({ ...orgAgent, status: "terminated" });

      const res = await request(makeApp(founderActor))
        .post(`/api/agents/${AGENT_ID}/terminate`);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockAgentService.terminate).toHaveBeenCalledWith(AGENT_ID);
      expect(mockHeartbeatService.cancelActiveForAgent).toHaveBeenCalledWith(AGENT_ID);
    });
  });
});
