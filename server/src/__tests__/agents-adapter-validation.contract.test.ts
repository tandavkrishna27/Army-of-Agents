/**
 * Contract tests for the auth-mismatch soft-warn tier (Unit C, Task 7).
 *
 * Asserts:
 *   1. PATCH /agents/:id with a model that would be runtime-corrected for the
 *      detected auth mode returns 200 with warnings[] in the body.
 *   2. PATCH with a cross-family model (schema-level hard-block) returns 400.
 *
 * Provider-status detection is mocked via vi.mock so the test is deterministic
 * regardless of what is installed on the host machine.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { drizzleOperatorStubs, makeTableProxy } from "./helpers/drizzle-mock.js";

// ── Drizzle / DB stubs (must precede all src imports) ────────────────────────
vi.mock("drizzle-orm", () => drizzleOperatorStubs());

vi.mock("@armyofagents/db", () => ({
  agents: makeTableProxy("agents"),
  companies: makeTableProxy("companies"),
  heartbeatRuns: makeTableProxy("heartbeat_runs"),
}));

// ── Provider-status mock: always returns chatgpt authMode (deterministic) ─────
// We hoist the fn so we can re-configure it per-test via mockGetProviderStatus.
const mockGetProviderStatus = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    adapterType: "codex_local",
    installed: true,
    authenticated: true,
    authMode: "chatgpt",
    defaultModelResolved: "gpt-5.5",
  }),
);

vi.mock("../adapters/provider-status.js", () => ({
  getProviderStatus: mockGetProviderStatus,
}));

// ── Service mocks ─────────────────────────────────────────────────────────────
const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  list: vi.fn().mockResolvedValue([]),
  resolveByReference: vi.fn(),
  orgForCompany: vi.fn().mockResolvedValue([]),
  listConfigRevisions: vi.fn().mockResolvedValue([]),
  getConfigRevision: vi.fn(),
  getChainOfCommand: vi.fn().mockResolvedValue([]),
  backfillParentFields: vi.fn().mockResolvedValue(0),
  listKeys: vi.fn(),
  createApiKey: vi.fn(),
  revokeKey: vi.fn(),
  getKeyById: vi.fn(),
  create: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  terminate: vi.fn(),
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
  companySkillService: () => ({
    listRuntimeSkillEntries: vi.fn(),
    resolveSkillKeys: vi.fn(),
  }),
  heartbeatService: () => ({ cancelActiveForAgent: vi.fn().mockResolvedValue(undefined) }),
  issueApprovalService: () => ({}),
  issueService: () => ({}),
  logActivity: vi.fn(),
  secretService: () => ({
    resolveAdapterConfigForRuntime: vi.fn().mockResolvedValue({
      model: null,
      command: null,
      cwd: null,
      env: {},
    }),
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

const mockEnsureOpenCode = vi.hoisted(() => vi.fn());
vi.mock("@armyofagents/adapter-opencode-local/server", () => ({
  ensureOpenCodeModelConfiguredAndAvailable: mockEnsureOpenCode,
}));

// ── Route + error-handler imports (after all mocks) ───────────────────────────
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

// ── Constants ─────────────────────────────────────────────────────────────────
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const COMPANY_ID = "company-A";

const founderActor = {
  type: "board" as const,
  // local_implicit bypasses all assertRole DB lookups (rbac.ts line 36) so
  // tests don't need a wired-up permissionService against the empty mock db.
  source: "local_implicit" as const,
  userId: "user-founder",
  companyIds: [COMPANY_ID],
  isInstanceAdmin: false,
};

function makeApp(actor: unknown = founderActor) {
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

// ── A codex agent that already belongs to company-A ───────────────────────────
const existingCodexAgent = {
  id: AGENT_ID,
  companyId: COMPANY_ID,
  adapterType: "codex_local" as const,
  adapterConfig: { model: "gpt-4.1" },
  runtimeConfig: {},
  name: "Test Codex Agent",
  role: "general",
  kind: "org",
  status: "idle",
  permissions: { can_create_agents: false },
};

// A cursor agent: model-aware (spawns `--model`) but OUTSIDE
// ADAPTER_CONSTRAINT_TYPES, so a model-only PATCH on it relies on the route's
// standalone shell-safety gate (Codex P2).
const existingCursorAgent = {
  ...existingCodexAgent,
  adapterType: "cursor" as const,
  adapterConfig: { model: "claude-sonnet-4-20250514" },
  name: "Test Cursor Agent",
};

describe("agents PATCH — auth-mismatch soft-warn contract (Unit C)", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Re-configure the hoisted mock back to chatgpt mode after clearAllMocks.
    mockGetProviderStatus.mockResolvedValue({
      adapterType: "codex_local",
      installed: true,
      authenticated: true,
      authMode: "chatgpt",
      defaultModelResolved: "gpt-5.5",
    });
    // OpenCode's own validation passes by default; per-test overrides reject.
    mockEnsureOpenCode.mockResolvedValue([]);
  });

  it("200 with warnings[] when model would be corrected for chatgpt auth mode", async () => {
    // A codex model that is API-key-only (e.g. gpt-5.3-codex) on a ChatGPT login
    // → resolveModel should produce a note → soft-warn surfaced in response.
    mockAgentService.getById.mockResolvedValue(existingCodexAgent);
    mockAgentService.update.mockResolvedValue({
      ...existingCodexAgent,
      adapterConfig: { model: "gpt-5.3-codex" },
    });

    const res = await request(makeApp())
      .patch(`/api/agents/${AGENT_ID}`)
      .send({ adapterConfig: { model: "gpt-5.3-codex" } });

    expect(res.status).toBe(200);
    // The response must include a non-empty warnings array
    expect(Array.isArray(res.body.warnings)).toBe(true);
    expect(res.body.warnings.length).toBeGreaterThan(0);
    // The warning should mention gpt-5.5 (the resolved fallback) or ChatGPT
    const warn: string = res.body.warnings[0];
    expect(warn).toMatch(/gpt-5\.5|chatgpt|ChatGPT|not supported/i);
  });

  it("200 with no warnings key when model needs no correction (apikey auth mode)", async () => {
    // Override to apikey mode — resolveModel produces no note in this case.
    mockGetProviderStatus.mockResolvedValue({
      adapterType: "codex_local",
      installed: true,
      authenticated: true,
      authMode: "apikey",
      defaultModelResolved: "gpt-5.3-codex",
    });

    mockAgentService.getById.mockResolvedValue(existingCodexAgent);
    mockAgentService.update.mockResolvedValue({
      ...existingCodexAgent,
      adapterConfig: { model: "gpt-5.3-codex" },
    });

    const res = await request(makeApp())
      .patch(`/api/agents/${AGENT_ID}`)
      .send({ adapterConfig: { model: "gpt-5.3-codex" } });

    expect(res.status).toBe(200);
    // No warnings key when there is nothing to warn about
    expect(res.body.warnings).toBeUndefined();
  });

  it("400 when cross-family model is sent (schema hard-block, never reaches assertAdapterConfigConstraints)", async () => {
    // claude_local adapter + gpt model → refineAdapterModel in updateAgentSchema
    // rejects it at the validate() middleware → ZodError → 400.
    const res = await request(makeApp())
      .patch(`/api/agents/${AGENT_ID}`)
      .send({ adapterType: "claude_local", adapterConfig: { model: "gpt-5.5" } });

    expect(res.status).toBe(400);
    // Response should carry a validation error hint
    expect(res.body.error).toBeDefined();
  });

  // ── Codex finding ②: adapter/model family mismatch on PATCH (route hard-block) ──
  // The schema can't catch these (no model in the body, or no adapterType in the body),
  // so the route must validate the EFFECTIVE (new adapter + existing/effective model).

  it("422 — adapterType-only switch to claude_local leaves a persisted gpt model", async () => {
    mockAgentService.getById.mockResolvedValue(existingCodexAgent);
    const res = await request(makeApp())
      .patch(`/api/agents/${AGENT_ID}`)
      .send({ adapterType: "claude_local" });
    expect(res.status).toBe(422);
    expect(String(res.body.error)).toMatch(/does not match adapter claude_local/i);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("422 — adapterType-only switch to gemini_local leaves a persisted gpt model", async () => {
    mockAgentService.getById.mockResolvedValue(existingCodexAgent);
    const res = await request(makeApp())
      .patch(`/api/agents/${AGENT_ID}`)
      .send({ adapterType: "gemini_local" });
    expect(res.status).toBe(422);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("422 — model-only PATCH to a claude model against the existing codex adapter", async () => {
    mockAgentService.getById.mockResolvedValue(existingCodexAgent);
    const res = await request(makeApp())
      .patch(`/api/agents/${AGENT_ID}`)
      .send({ adapterConfig: { model: "claude-sonnet-4-5" } });
    expect(res.status).toBe(422);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("200 — switch to claude_local WITH a compatible claude model (update called)", async () => {
    mockAgentService.getById.mockResolvedValue(existingCodexAgent);
    mockAgentService.update.mockResolvedValue({
      ...existingCodexAgent,
      adapterType: "claude_local",
      adapterConfig: { model: "claude-sonnet-4-5" },
    });
    const res = await request(makeApp())
      .patch(`/api/agents/${AGENT_ID}`)
      .send({ adapterType: "claude_local", adapterConfig: { model: "claude-sonnet-4-5" } });
    expect(res.status).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalled();
  });

  it("not 422 — switch to claude_local with adapterConfig:{} (clears the old model)", async () => {
    mockAgentService.getById.mockResolvedValue(existingCodexAgent);
    mockAgentService.update.mockResolvedValue({
      ...existingCodexAgent,
      adapterType: "claude_local",
      adapterConfig: {},
    });
    const res = await request(makeApp())
      .patch(`/api/agents/${AGENT_ID}`)
      .send({ adapterType: "claude_local", adapterConfig: {} });
    expect(res.status).not.toBe(422);
  });

  it("not 422 — model-only PATCH to a compatible gpt model (guard does not overblock)", async () => {
    mockAgentService.getById.mockResolvedValue(existingCodexAgent);
    mockAgentService.update.mockResolvedValue({
      ...existingCodexAgent,
      adapterConfig: { model: "gpt-5.6" },
    });
    const res = await request(makeApp())
      .patch(`/api/agents/${AGENT_ID}`)
      .send({ adapterConfig: { model: "gpt-5.6" } });
    expect(res.status).not.toBe(422);
  });

  // ── Codex finding ①: OpenCode is multi-provider at the route level ──
  it("not 422 — switch to opencode_local + anthropic/claude reaches OpenCode's own check", async () => {
    mockAgentService.getById.mockResolvedValue(existingCodexAgent);
    mockEnsureOpenCode.mockResolvedValue([]);
    mockAgentService.update.mockResolvedValue({
      ...existingCodexAgent,
      adapterType: "opencode_local",
      adapterConfig: { model: "anthropic/claude-sonnet-4-5" },
    });
    const res = await request(makeApp())
      .patch(`/api/agents/${AGENT_ID}`)
      .send({ adapterType: "opencode_local", adapterConfig: { model: "anthropic/claude-sonnet-4-5" } });
    expect(res.status).not.toBe(422);
    expect(mockEnsureOpenCode).toHaveBeenCalled();
  });

  it("422 — opencode_local model that OpenCode rejects surfaces OpenCode's error", async () => {
    mockAgentService.getById.mockResolvedValue(existingCodexAgent);
    mockEnsureOpenCode.mockRejectedValue(
      new Error("Configured OpenCode model is unavailable: anthropic/claude-x"),
    );
    const res = await request(makeApp())
      .patch(`/api/agents/${AGENT_ID}`)
      .send({ adapterType: "opencode_local", adapterConfig: { model: "anthropic/claude-x" } });
    expect(res.status).toBe(422);
    expect(String(res.body.error)).toMatch(/opencode/i);
  });

  // ── Codex P2: model-only PATCH shell-safety for a model-aware adapter OUTSIDE
  // ADAPTER_CONSTRAINT_TYPES (cursor). No adapterType in the body → the schema's
  // refineAdapterModel early-returns, so the route's standalone gate is the only
  // thing standing between an unsafe model and runtime `--model` injection. ──
  it("422 — model-only PATCH with a shell-UNSAFE model on a cursor agent", async () => {
    mockAgentService.getById.mockResolvedValue(existingCursorAgent);
    const res = await request(makeApp())
      .patch(`/api/agents/${AGENT_ID}`)
      .send({ adapterConfig: { model: "gpt-5.5; rm -rf /" } });
    expect(res.status).toBe(422);
    expect(String(res.body.error)).toMatch(/unsafe model/i);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("not 422 — model-only PATCH with a shell-safe model on a cursor agent (update called)", async () => {
    mockAgentService.getById.mockResolvedValue(existingCursorAgent);
    mockAgentService.update.mockResolvedValue({
      ...existingCursorAgent,
      adapterConfig: { model: "claude-opus-4-20250514" },
    });
    const res = await request(makeApp())
      .patch(`/api/agents/${AGENT_ID}`)
      .send({ adapterConfig: { model: "claude-opus-4-20250514" } });
    expect(res.status).not.toBe(422);
    expect(mockAgentService.update).toHaveBeenCalled();
  });
});
