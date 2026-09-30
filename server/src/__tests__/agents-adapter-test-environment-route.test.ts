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

const mockAdapterTestEnvironment = vi.hoisted(() => vi.fn());
const mockNormalizeAdapterConfigForPersistence = vi.hoisted(() =>
  vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
);
const mockResolveAdapterConfigForRuntime = vi.hoisted(() =>
  vi.fn(async (_companyId: string, _adapterType: string, config: Record<string, unknown>) => config),
);
const mockAcquireForRun = vi.hoisted(() => vi.fn());
const mockReleaseRunLease = vi.hoisted(() => vi.fn());
const mockGetProviderStatus = vi.hoisted(() => vi.fn());
const mockFindServerAdapter = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => ({
    getById: vi.fn(),
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
  }),
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
  logActivity: vi.fn(),
  secretService: () => ({
    normalizeAdapterConfigForPersistence: mockNormalizeAdapterConfigForPersistence,
    resolveAdapterConfigForRuntime: mockResolveAdapterConfigForRuntime,
    syncEnvBindingsForTarget: vi.fn(),
  }),
  syncInstructionsBundleConfigFromFilePath: vi.fn(
    (_agent: unknown, config: Record<string, unknown>) => config,
  ),
}));

vi.mock("../adapters/index.js", () => ({
  findActiveServerAdapter: vi.fn(),
  findServerAdapter: mockFindServerAdapter,
  listAdapterModels: vi.fn(),
}));

vi.mock("../adapters/provider-status.js", () => ({
  getProviderStatus: mockGetProviderStatus,
}));

vi.mock("../adapters/provider-status-deps.js", () => ({
  realProviderStatusDeps: {},
}));

vi.mock("../services/environment-run-orchestrator.js", () => ({
  environmentRunOrchestrator: vi.fn(() => ({
    acquireForRun: mockAcquireForRun,
  })),
}));

vi.mock("../services/environment-runtime.js", () => ({
  environmentRuntimeService: vi.fn(() => ({
    releaseRunLease: mockReleaseRunLease,
  })),
}));

// U13.7: this suite never exercises cloud_auth, so the sandbox-readiness-probe
// branch is never taken at runtime — but agents.ts now statically imports it,
// and that module's own import of one-shot-sandbox-cli.js needs
// environment-runtime.js's resolveRuntimeProviderConfig, which the mock above
// does not provide. Mock the seam directly (never called here) rather than
// widening the environment-runtime.js mock for an unrelated code path.
vi.mock("../services/sandbox-readiness-probe.js", () => ({
  probeReadinessInSandbox: vi.fn(),
  cliToolForSandboxReadinessProbe: () => null,
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

const COMPANY_ID = "company-1";
const ENVIRONMENT_ID = "22222222-2222-4222-8222-222222222222";

function makeApp(actorOverride?: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = (actorOverride ?? {
      type: "board",
      source: "local_implicit",
      userId: "board",
      companyIds: [COMPANY_ID],
      isInstanceAdmin: true,
    }) as never;
    next();
  });
  app.use("/api", agentRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe("POST /companies/:companyId/adapters/:type/test-environment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: process adapter (skips model resolution)
    mockFindServerAdapter.mockReturnValue({
      type: "process",
      testEnvironment: mockAdapterTestEnvironment,
    });
    mockAdapterTestEnvironment.mockResolvedValue({
      adapterType: "process",
      status: "pass",
      checks: [],
      testedAt: "2026-06-01T00:00:00.000Z",
    });
    mockAcquireForRun.mockResolvedValue({
      environment: {
        id: ENVIRONMENT_ID,
        companyId: COMPANY_ID,
        name: "E2B Cloud QA",
        driver: "sandbox",
        status: "active",
        config: { provider: "e2b" },
      },
      lease: {
        id: "lease-1",
        companyId: COMPANY_ID,
        environmentId: ENVIRONMENT_ID,
        provider: "e2b",
        providerLeaseId: "sandbox-1",
        metadata: {},
      },
      leaseContext: {},
      adapterType: "process",
      configPatch: {
        executionTarget: {
          type: "provider-sandbox",
          provider: "e2b",
          providerLeaseId: "sandbox-1",
          remoteCwd: "/home/user/aoa-workspace",
          shell: "bash",
          env: {},
          runner: { execute: vi.fn() },
        },
      },
    });
    mockReleaseRunLease.mockResolvedValue(undefined);
    // Default: getProviderStatus not called unless test sets it up
    mockGetProviderStatus.mockResolvedValue({
      adapterType: "codex_local",
      installed: true,
      authenticated: true,
      authMode: "chatgpt",
      defaultModelResolved: "gpt-5.5",
    });
  });

  it("passes the selected environment execution target into the adapter test and releases the lease", async () => {
    const res = await request(makeApp())
      .post(`/api/companies/${COMPANY_ID}/adapters/process/test-environment`)
      .send({
        environmentId: ENVIRONMENT_ID,
        adapterConfig: { command: "pwd" },
      });

    expect(res.status).toBe(200);
    expect(mockAcquireForRun).toHaveBeenCalledWith(expect.objectContaining({
      companyId: COMPANY_ID,
      environmentId: ENVIRONMENT_ID,
      adapterType: "process",
      issueId: null,
      persistedExecutionWorkspace: null,
    }));
    expect(mockAdapterTestEnvironment).toHaveBeenCalledWith(expect.objectContaining({
      companyId: COMPANY_ID,
      adapterType: "process",
      config: { command: "pwd" },
      environmentName: "E2B Cloud QA",
      executionTarget: expect.objectContaining({
        type: "provider-sandbox",
        provider: "e2b",
        remoteCwd: "/home/user/aoa-workspace",
      }),
    }));
    expect(mockReleaseRunLease).toHaveBeenCalledWith(expect.objectContaining({
      environment: expect.objectContaining({ id: ENVIRONMENT_ID }),
      lease: expect.objectContaining({ id: "lease-1" }),
      status: "released",
    }));
  });

  it("threads the :type param into secret resolution so the company provider key applies", async () => {
    // Task 8: the probe must resolve the credential for the adapter it is about
    // to probe. Passing the wrong type would either inject another provider's
    // company key or skip the fallback entirely, making the probe lie.
    mockFindServerAdapter.mockReturnValue({
      type: "claude_local",
      testEnvironment: mockAdapterTestEnvironment,
    });
    mockAdapterTestEnvironment.mockResolvedValue({
      adapterType: "claude_local",
      status: "pass",
      checks: [],
      testedAt: "2026-06-01T00:00:00.000Z",
    });
    // Once-only: vi.clearAllMocks() in beforeEach clears calls but KEEPS
    // implementations, so a persistent override would leak into later tests.
    mockResolveAdapterConfigForRuntime.mockImplementationOnce(
      async (_companyId: string, _adapterType: string, config: Record<string, unknown>) => ({
        ...config,
        env: { ANTHROPIC_API_KEY: "company-key" },
      }),
    );

    const res = await request(makeApp())
      .post(`/api/companies/${COMPANY_ID}/adapters/claude_local/test-environment`)
      .send({ adapterConfig: {} });

    expect(res.status).toBe(200);
    expect(mockResolveAdapterConfigForRuntime).toHaveBeenCalledWith(
      COMPANY_ID,
      "claude_local",
      expect.anything(),
      expect.objectContaining({ consumerId: "adapter-test:claude_local" }),
    );
    // …and the resolved env (company key included) is what the probe runs with.
    expect(mockAdapterTestEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterType: "claude_local",
        config: expect.objectContaining({ env: { ANTHROPIC_API_KEY: "company-key" } }),
      }),
    );
  });

  it("resolves the model via getProviderStatus for codex_local before probing", async () => {
    // Override adapter type to codex_local for this test
    mockFindServerAdapter.mockReturnValue({
      type: "codex_local",
      testEnvironment: mockAdapterTestEnvironment,
    });
    mockAdapterTestEnvironment.mockResolvedValue({
      adapterType: "codex_local",
      status: "pass",
      checks: [],
      testedAt: "2026-06-01T00:00:00.000Z",
    });
    mockGetProviderStatus.mockResolvedValue({
      adapterType: "codex_local",
      installed: true,
      authenticated: true,
      authMode: "chatgpt",
      defaultModelResolved: "gpt-5.5",
    });

    const res = await request(makeApp())
      .post(`/api/companies/${COMPANY_ID}/adapters/codex_local/test-environment`)
      .send({
        adapterConfig: { model: "gpt-5.3-codex" },
      });

    expect(res.status).toBe(200);
    expect(mockGetProviderStatus).toHaveBeenCalledWith(
      "codex_local",
      expect.objectContaining({ companyId: COMPANY_ID }),
      expect.anything(),
    );
    // gpt-5.3-codex is CODEX_INCOMPATIBLE (contains "codex") in chatgpt mode →
    // resolveModel should fall back to defaultModelResolved "gpt-5.5"
    expect(mockAdapterTestEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ model: "gpt-5.5" }),
      }),
    );
  });

  it("resolves an EMPTY codex_local model to the default (gpt-5.5) before probing (P2-1)", async () => {
    // P2-1: previously the probe skipped resolution when the model was empty
    // (the UI/default-model path), so codex probes ran with the CLI default
    // instead of gpt-5.5 and could falsely fail on ChatGPT/subscription auth —
    // even though the saved agent RUN is corrected to gpt-5.5. The probe must
    // resolve the SAME model a real run would, including the empty case.
    mockFindServerAdapter.mockReturnValue({
      type: "codex_local",
      testEnvironment: mockAdapterTestEnvironment,
    });
    mockAdapterTestEnvironment.mockResolvedValue({
      adapterType: "codex_local",
      status: "pass",
      checks: [],
      testedAt: "2026-06-01T00:00:00.000Z",
    });
    mockGetProviderStatus.mockResolvedValue({
      adapterType: "codex_local",
      installed: true,
      authenticated: true,
      authMode: "chatgpt",
      defaultModelResolved: "gpt-5.5",
    });

    const res = await request(makeApp())
      .post(`/api/companies/${COMPANY_ID}/adapters/codex_local/test-environment`)
      .send({ adapterConfig: {} }); // no model at all

    expect(res.status).toBe(200);
    // Resolution must run even for an empty model …
    expect(mockGetProviderStatus).toHaveBeenCalled();
    // … and codex's empty model resolves to the default gpt-5.5 for the probe.
    expect(mockAdapterTestEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ model: "gpt-5.5" }),
      }),
    );
  });

  it("redacts secrets in check message/detail/hint before returning to client", async () => {
    const secretKey = "sk-ant-abc123DEF456ghi789xyz";
    mockAdapterTestEnvironment.mockResolvedValue({
      adapterType: "codex_local",
      status: "warn",
      checks: [
        {
          code: "x",
          level: "warn",
          message: "probe failed",
          detail: `leaked ${secretKey} here`,
          hint: `try removing ${secretKey} from config`,
        },
      ],
      testedAt: "2026-06-01T00:00:00.000Z",
    });

    const res = await request(makeApp())
      .post(`/api/companies/${COMPANY_ID}/adapters/process/test-environment`)
      .send({ adapterConfig: {} });

    expect(res.status).toBe(200);
    expect(res.body.checks[0].detail).not.toContain(secretKey);
    expect(res.body.checks[0].detail).toContain("***REDACTED***");
    expect(res.body.checks[0].hint).not.toContain(secretKey);
    expect(res.body.checks[0].hint).toContain("***REDACTED***");
    // message was clean, should be unchanged
    expect(res.body.checks[0].message).toBe("probe failed");
  });

  it("returns 429 when a probe is already in-flight for the same company", async () => {
    // Strategy: use supertest's .end() callback to fire request A without
    // awaiting — so the HTTP request is actually dispatched. Then signal via
    // a Promise inside the mock when the adapter is entered (slot is held),
    // send request B, assert 429, then release the gate to clean up.
    let releaseGate!: () => void;
    let adapterStarted!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const adapterStartedSignal = new Promise<void>((resolve) => { adapterStarted = resolve; });
    const successResult = {
      adapterType: "process",
      status: "pass",
      checks: [],
      testedAt: "2026-06-01T00:00:00.000Z",
    };
    // First call: signal that it started, then hold the slot
    mockAdapterTestEnvironment.mockImplementationOnce(async () => {
      adapterStarted();
      await gate;
      return successResult;
    });
    // Second call (if reached): returns immediately
    mockAdapterTestEnvironment.mockResolvedValueOnce(successResult);

    const app = makeApp();

    // Fire request A using .end() — this dispatches without blocking our async function
    let resolveA!: (res: request.Response) => void;
    const reqAPromise = new Promise<request.Response>((resolve) => { resolveA = resolve; });
    request(app)
      .post(`/api/companies/${COMPANY_ID}/adapters/process/test-environment`)
      .send({ adapterConfig: {} })
      .end((_err, res) => resolveA(res));

    // Wait until request A has entered the adapter (slot is incremented)
    await adapterStartedSignal;

    // Now request B should hit the 429 cap
    const resB = await request(app)
      .post(`/api/companies/${COMPANY_ID}/adapters/process/test-environment`)
      .send({ adapterConfig: {} });

    expect(resB.status).toBe(429);
    expect(resB.body.error).toMatch(/already running/i);

    // Release A's gate and confirm it completes cleanly (slot decremented)
    releaseGate();
    const resA = await reqAPromise;
    expect(resA.status).toBe(200);
  });

  it("returns 403 when actor lacks read-configurations permission", async () => {
    // An actor that is a board member but NOT local_implicit and NOT instance admin
    // and without agents:create permission (canUser returns false).
    // canUser mock: the vi.mock factory creates a fresh vi.fn() per accessService()
    // call — no module-level handle exists to call .mockReturnValue(false) on it.
    // vi.fn() returns undefined by default (falsy), which the RBAC gate treats as
    // "no permission". This is intentionally equivalent to mockReturnValue(false);
    // extracting a hoisted handle would require refactoring the mock factory.
    const restrictedApp = makeApp({
      type: "board",
      source: "session",       // NOT local_implicit
      userId: "restricted-user",
      companyIds: [COMPANY_ID],
      isInstanceAdmin: false,  // NOT instance admin
    });

    const res = await request(restrictedApp)
      .post(`/api/companies/${COMPANY_ID}/adapters/process/test-environment`)
      .send({ adapterConfig: {} });

    expect(res.status).toBe(403);
  });
});
