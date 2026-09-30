/**
 * D1 cloud-isolation gate for the adapter readiness / "test environment" probe.
 *
 * The probe spawns a REAL `claude --print` / `codex exec` generation. For the
 * default LOCAL target it inherits the host env (keeps CLAUDE_CONFIG_DIR / HOME /
 * CODEX_HOME), so on `cloud_auth` it would run under the OPERATOR's login on the
 * shared control-plane host — the exact tenant-code-on-shared-host hazard the
 * other CLI sinks in this PR already close with `assertUnsandboxedMultitenantAllowed`.
 *
 * There are THREE probe entry points, all calling `adapter.testEnvironment`:
 *   1. routes/agents.ts        — POST /companies/:id/adapters/:type/test-environment
 *   2. routes/providers.ts     — POST /companies/:id/providers/:providerId/test
 *   3. routes/commander-verify — POST /companies/:id/internal-agent/verify
 *
 * Each must refuse on `cloud_auth` with a local/null execution target (absent the
 * documented AOA_ALLOW_UNSANDBOXED_MULTITENANT opt-in), WITHOUT spawning the
 * generation, and stay a no-op on every self-hosted deployment. The guard itself
 * is unit-tested elsewhere; these drive the full routes so the SHORT-CIRCUIT (no
 * testEnvironment call + blocking result) is proven at each sink.
 */
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzleOperatorStubs, makeTableProxy } from "./helpers/drizzle-mock.js";
import { setDeploymentMode } from "../config/deployment-mode.js";
import { UNSANDBOXED_MULTITENANT_OPT_IN_ENV } from "../services/unsandboxed-multitenant-guard.js";

vi.mock("drizzle-orm", () => drizzleOperatorStubs());

vi.mock("@armyofagents/db", () => ({
  agents: makeTableProxy("agents"),
  aoaAgentTriggers: makeTableProxy("aoa_agent_triggers"),
  companies: makeTableProxy("companies"),
  heartbeatRuns: makeTableProxy("heartbeat_runs"),
  internalAgentRuns: makeTableProxy("internal_agent_runs"),
  internalAgentConfig: makeTableProxy("internal_agent_config"),
  companySecrets: makeTableProxy("company_secrets"),
  companyMemberships: makeTableProxy("company_memberships"),
  providerReadinessStatus: makeTableProxy("provider_readiness_status"),
}));

/* ── shared adapter lookups ─────────────────────────────────────────────── */
// agents.ts + providers.ts resolve the adapter via ../adapters/index.js …
const mockFindServerAdapter = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", () => ({
  findServerAdapter: mockFindServerAdapter,
  findActiveServerAdapter: vi.fn(),
  listAdapterModels: vi.fn(),
}));
// … commander-verify.ts via ../adapters/registry.js.
const mockFindAdapterRegistry = vi.hoisted(() => vi.fn());
vi.mock("../adapters/registry.js", () => ({ findServerAdapter: mockFindAdapterRegistry }));

vi.mock("../adapters/provider-status.js", () => ({ getProviderStatus: vi.fn() }));
vi.mock("../adapters/provider-status-deps.js", () => ({ realProviderStatusDeps: {} }));

/* ── agents.ts service barrel ───────────────────────────────────────────── */
const mockNormalizeAdapterConfigForPersistence = vi.hoisted(() =>
  vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
);
const mockResolveAdapterConfigForRuntimeBarrel = vi.hoisted(() =>
  vi.fn(async (_companyId: string, _adapterType: string, config: Record<string, unknown>) => config),
);
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
    resolveAdapterConfigForRuntime: mockResolveAdapterConfigForRuntimeBarrel,
    syncEnvBindingsForTarget: vi.fn(),
  }),
  syncInstructionsBundleConfigFromFilePath: vi.fn(
    (_agent: unknown, config: Record<string, unknown>) => config,
  ),
}));

vi.mock("../services/environment-run-orchestrator.js", () => ({
  environmentRunOrchestrator: vi.fn(() => ({ acquireForRun: vi.fn(async () => null) })),
}));
vi.mock("../services/environment-runtime.js", () => ({
  environmentRuntimeService: vi.fn(() => ({ releaseRunLease: vi.fn(async () => undefined) })),
}));

// U13.7: mock the sandbox-readiness-probe seam directly (rather than its real
// transitive dependency graph — one-shot-sandbox-cli.ts pulls in
// environment-runtime.js's resolveRuntimeProviderConfig, acquire-execution-context.js,
// sandbox-provider-runtime.js, etc., none of which this route-level suite stubs).
// Mirrors cli-summarizer-sandbox.test.ts's strategy: assert ROUTING (was
// probeReadinessInSandbox called, with what args, and did the route handle its
// resolved value / thrown ProviderUnavailableError correctly) without exercising
// the real acquire/execute/release machinery, which one-shot-sandbox-cli.test.ts
// and sandbox-readiness-probe.test.ts already cover.
const mockProbeReadinessInSandbox = vi.hoisted(() => vi.fn());
vi.mock("../services/sandbox-readiness-probe.js", () => ({
  probeReadinessInSandbox: (...a: unknown[]) => mockProbeReadinessInSandbox(...a),
  cliToolForSandboxReadinessProbe: (adapterType: string) =>
    adapterType === "codex_local" ? "codex" : adapterType === "claude_local" ? "claude" : null,
}));

// Partial mocks: the providers/commander module graphs pull additional exports
// (e.g. CLAUDE_CREDENTIAL_FILE_NAME via commander-login-runtime), so keep the
// real exports and only neuter the side-effectful login/spawn helpers.
vi.mock("@armyofagents/adapter-claude-local/server", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, runClaudeLogin: vi.fn() };
});
vi.mock("@armyofagents/adapter-opencode-local/server", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, ensureOpenCodeModelConfiguredAndAvailable: vi.fn() };
});

/* ── providers.ts service mocks ─────────────────────────────────────────── */
const mockCanUser = vi.hoisted(() => vi.fn(async () => true));
const mockHasPermission = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../services/access.js", () => ({
  accessService: () => ({ canUser: mockCanUser, hasPermission: mockHasPermission }),
}));
const mockResolveAdapterConfigForRuntime = vi.hoisted(() =>
  vi.fn(async (_companyId: string, _adapterType: string, config: Record<string, unknown>) => ({
    ...config,
    env: { RESOLVED: "1" },
  })),
);
vi.mock("../services/secrets.js", () => ({
  secretService: () => ({ resolveAdapterConfigForRuntime: mockResolveAdapterConfigForRuntime }),
}));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));

const mockRecordReadiness = vi.hoisted(() => vi.fn());
vi.mock("../services/providers/readiness.js", async (importOriginal) => {
  // Keep redactChecks + classifyProbeOutcome real; stub the db writers/readers.
  const actual = await importOriginal<typeof import("../services/providers/readiness.js")>();
  return {
    ...actual,
    readReadiness: vi.fn(async () => []),
    readReadinessForScope: vi.fn(),
    recordReadiness: mockRecordReadiness,
    deleteReadinessForScope: vi.fn(),
    deleteAgentReadinessForProvider: vi.fn(),
  };
});
vi.mock("../services/providers/provider-key.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/providers/provider-key.js")>();
  return { ...actual, saveProviderKey: vi.fn() };
});

/* ── commander-verify.ts service mocks ──────────────────────────────────── */
const mockResolveCommanderType = vi.hoisted(() => vi.fn(async () => "claude_local"));
const mockCommanderProbeConfig = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("../services/commander-verify.js", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  // keep the real classifier; stub the db-touching resolvers
  return {
    ...actual,
    resolveCommanderAdapterType: mockResolveCommanderType,
    resolveCommanderProbeConfig: mockCommanderProbeConfig,
  };
});

/* ── shared middleware / credential mocks (agents + providers + commander) ─ */
const mockAssertRole = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../middleware/rbac.js", () => ({ assertRole: mockAssertRole }));

const mockVerifyAndBindSubscription = vi.hoisted(() =>
  vi.fn(async () => ({ credentialIds: [], bindingIds: [] })),
);
vi.mock("../services/provider-credentials.js", () => ({
  verifyAndBindCommanderSubscriptionCredential: mockVerifyAndBindSubscription,
}));

import { agentRoutes } from "../routes/agents.js";
import { providerRoutes } from "../routes/providers.js";
import { commanderVerifyRoutes } from "../routes/commander-verify.js";
import { errorHandler } from "../middleware/index.js";
import { tryAcquireAdapterProbeSlot } from "../services/adapter-probe-concurrency.js";
import { ProviderUnavailableError } from "../services/provider-resolution.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";

/** A loopback board actor: passes assertCompanyAccess early under BOTH modes,
 *  isolating the D1 gate (which keys on deploymentMode + target, never actor). */
const LOOPBACK_ACTOR = {
  type: "board",
  source: "local_implicit",
  userId: "board",
  companyIds: [COMPANY_ID],
  isInstanceAdmin: true,
} as const;

/** db stub whose select chain resolves to []; the gate paths never query it. */
function stubDb() {
  return {
    select: () => {
      const builder: Record<string, unknown> = {};
      for (const m of ["from", "where", "limit", "orderBy", "for"]) builder[m] = () => builder;
      builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve([]).then(resolve);
      return builder;
    },
  } as never;
}

function makeApp(
  mount: (app: express.Express) => void,
  actor: Record<string, unknown> = { ...LOOPBACK_ACTOR },
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as never;
    next();
  });
  mount(app);
  app.use(errorHandler);
  return app;
}

function passingResult(adapterType: string) {
  return {
    adapterType,
    status: "pass" as const,
    checks: [{ code: `${adapterType}_hello_probe_passed`, level: "info" as const, message: "ok" }],
    testedAt: "2026-08-02T00:00:00.000Z",
  };
}

/** U13.7: what `probeReadinessInSandbox` itself returns on a successful
 *  sandboxed hello-probe (code prefix is the CLI, "claude"/"codex" — NOT the
 *  full adapterType — matching sandbox-readiness-probe.ts's real shape). */
function passingSandboxResult(adapterType: string) {
  const prefix = adapterType === "codex_local" ? "codex" : "claude";
  return {
    adapterType,
    status: "pass" as const,
    checks: [{ code: `${prefix}_hello_probe_passed`, level: "info" as const, message: "sandbox ok" }],
    testedAt: "2026-08-02T00:00:00.000Z",
  };
}

let savedOptIn: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  // The opt-in env would turn the guard into a no-op; ensure it is absent.
  savedOptIn = process.env[UNSANDBOXED_MULTITENANT_OPT_IN_ENV];
  delete process.env[UNSANDBOXED_MULTITENANT_OPT_IN_ENV];
  mockCanUser.mockResolvedValue(true);
  mockHasPermission.mockResolvedValue(true);
  mockAssertRole.mockResolvedValue(undefined);
  mockResolveCommanderType.mockResolvedValue("claude_local");
  mockCommanderProbeConfig.mockResolvedValue({});
  mockVerifyAndBindSubscription.mockResolvedValue({ credentialIds: [], bindingIds: [] });
  mockRecordReadiness.mockImplementation(async (_db: unknown, input: Record<string, unknown>) => ({
    ...input,
    testedAt: new Date("2026-08-02T00:00:00.000Z"),
  }));
  // U13.7 default: no company provider key resolves — reproduces the OLD
  // unconditional-block behaviour for every existing "refuses" test below
  // (mapCloudProviderKeyError maps this to the same readiness_unavailable_on_cloud
  // shape). Individual tests override this to simulate a resolved company key.
  mockProbeReadinessInSandbox.mockRejectedValue(
    new ProviderUnavailableError("anthropic", "no_assignment", null),
  );
});

afterEach(() => {
  setDeploymentMode("local_trusted"); // module default; do not leak cloud_auth
  if (savedOptIn === undefined) delete process.env[UNSANDBOXED_MULTITENANT_OPT_IN_ENV];
  else process.env[UNSANDBOXED_MULTITENANT_OPT_IN_ENV] = savedOptIn;
  // Release any leaked per-company probe slot (module-level process state).
  tryAcquireAdapterProbeSlot(COMPANY_ID)?.();
});

/* ── 1. agents.ts test-environment route ────────────────────────────────── */
describe("D1 gate — POST /companies/:companyId/adapters/:type/test-environment", () => {
  function mountAgents(app: express.Express) {
    app.use("/api", agentRoutes(stubDb()));
  }

  it("refuses on cloud_auth with a local/null target WITHOUT spawning the probe", async () => {
    setDeploymentMode("cloud_auth");
    const testEnvironment = vi.fn(async () => passingResult("process"));
    mockFindServerAdapter.mockReturnValue({ type: "process", testEnvironment });

    const res = await request(makeApp(mountAgents))
      .post(`/api/companies/${COMPANY_ID}/adapters/process/test-environment`)
      .send({ adapterConfig: {} });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("fail");
    expect(res.body.checks[0].code).toBe("readiness_unavailable_on_cloud");
    expect(res.body.checks[0].level).toBe("error");
    // The whole point: no operator-login CLI generation on the shared host.
    expect(testEnvironment).not.toHaveBeenCalled();
  });

  it("proceeds on self-hosted (local_trusted) — the guard is a no-op", async () => {
    setDeploymentMode("local_trusted");
    const testEnvironment = vi.fn(async () => passingResult("process"));
    mockFindServerAdapter.mockReturnValue({ type: "process", testEnvironment });

    const res = await request(makeApp(mountAgents))
      .post(`/api/companies/${COMPANY_ID}/adapters/process/test-environment`)
      .send({ adapterConfig: {} });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pass");
    expect(testEnvironment).toHaveBeenCalledTimes(1);
  });

  // U13.7 additions ─────────────────────────────────────────────────────────
  it("cloud_auth WITH a resolved company provider key: runs the hello-probe through the sandbox and returns verified, never spawning the direct on-host probe", async () => {
    setDeploymentMode("cloud_auth");
    const testEnvironment = vi.fn(async () => passingResult("claude_local"));
    mockFindServerAdapter.mockReturnValue({ type: "claude_local", testEnvironment });
    mockProbeReadinessInSandbox.mockResolvedValue(passingSandboxResult("claude_local"));

    const res = await request(makeApp(mountAgents))
      .post(`/api/companies/${COMPANY_ID}/adapters/claude_local/test-environment`)
      .send({ adapterConfig: {} });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pass");
    expect(res.body.checks[0].code).toBe("claude_hello_probe_passed");
    expect(mockProbeReadinessInSandbox).toHaveBeenCalledTimes(1);
    expect(mockProbeReadinessInSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: COMPANY_ID, cliTool: "claude", adapterType: "claude_local" }),
    );
    // The direct on-host probe (operator-login-on-shared-host hazard) must
    // never run for this path.
    expect(testEnvironment).not.toHaveBeenCalled();
  });

  it("cloud_auth WITHOUT a company key (claude_local): still readiness_unavailable_on_cloud via mapCloudProviderKeyError — proven by asserting the sandbox WAS attempted, not skipped because cloud", async () => {
    setDeploymentMode("cloud_auth");
    const testEnvironment = vi.fn(async () => passingResult("claude_local"));
    mockFindServerAdapter.mockReturnValue({ type: "claude_local", testEnvironment });
    // beforeEach default: mockProbeReadinessInSandbox rejects with ProviderUnavailableError.

    const res = await request(makeApp(mountAgents))
      .post(`/api/companies/${COMPANY_ID}/adapters/claude_local/test-environment`)
      .send({ adapterConfig: {} });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("fail");
    expect(res.body.checks[0].code).toBe("readiness_unavailable_on_cloud");
    expect(mockProbeReadinessInSandbox).toHaveBeenCalledTimes(1);
    expect(testEnvironment).not.toHaveBeenCalled();
  });
});

/* ── 2. providers.ts probeAndRecord (via POST /:providerId/test) ─────────── */
describe("D1 gate — POST /companies/:companyId/providers/:providerId/test", () => {
  function mountProviders(app: express.Express) {
    app.use("/api/companies/:companyId/providers", providerRoutes(stubDb()));
  }

  it("refuses on cloud_auth WITHOUT spawning the probe and records outcome=failed (no company key resolves — mapCloudProviderKeyError, not merely because cloud)", async () => {
    setDeploymentMode("cloud_auth");
    const testEnvironment = vi.fn(async () => passingResult("claude_local"));
    mockFindServerAdapter.mockReturnValue({ type: "claude_local", testEnvironment });
    // beforeEach default: mockProbeReadinessInSandbox rejects with ProviderUnavailableError.

    const res = await request(makeApp(mountProviders))
      .post(`/api/companies/${COMPANY_ID}/providers/anthropic/test`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("failed");
    expect(res.body.checks[0].code).toBe("readiness_unavailable_on_cloud");
    // The sandbox path WAS attempted (claude_local has a company-key mapping)
    // and is the reason this blocked — not a bare "we're on cloud" skip.
    expect(mockProbeReadinessInSandbox).toHaveBeenCalledTimes(1);
    expect(testEnvironment).not.toHaveBeenCalled();
    expect(mockRecordReadiness).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ providerId: "anthropic", outcome: "failed" }),
    );
  });

  it("proceeds on self-hosted (local_trusted) — the guard is a no-op", async () => {
    setDeploymentMode("local_trusted");
    const testEnvironment = vi.fn(async () => passingResult("claude_local"));
    mockFindServerAdapter.mockReturnValue({ type: "claude_local", testEnvironment });

    const res = await request(makeApp(mountProviders))
      .post(`/api/companies/${COMPANY_ID}/providers/anthropic/test`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("verified");
    expect(testEnvironment).toHaveBeenCalledTimes(1);
  });

  // U13.7 additions ─────────────────────────────────────────────────────────
  it("cloud_auth WITH a resolved company provider key: runs the probe through the sandbox, returns verified, and records it", async () => {
    setDeploymentMode("cloud_auth");
    const testEnvironment = vi.fn(async () => passingResult("claude_local"));
    mockFindServerAdapter.mockReturnValue({ type: "claude_local", testEnvironment });
    mockProbeReadinessInSandbox.mockResolvedValue(passingSandboxResult("claude_local"));

    const res = await request(makeApp(mountProviders))
      .post(`/api/companies/${COMPANY_ID}/providers/anthropic/test`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("verified");
    expect(res.body.checks[0].code).toBe("claude_hello_probe_passed");
    expect(mockProbeReadinessInSandbox).toHaveBeenCalledTimes(1);
    expect(mockProbeReadinessInSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: COMPANY_ID, cliTool: "claude", adapterType: "claude_local" }),
    );
    expect(testEnvironment).not.toHaveBeenCalled();
    expect(mockRecordReadiness).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ providerId: "anthropic", outcome: "verified" }),
    );
  });

  it("codex (openai provider): cloud_auth WITH a resolved company key routes through the sandbox with cliTool 'codex'", async () => {
    setDeploymentMode("cloud_auth");
    const testEnvironment = vi.fn(async () => passingResult("codex_local"));
    mockFindServerAdapter.mockReturnValue({ type: "codex_local", testEnvironment });
    mockProbeReadinessInSandbox.mockResolvedValue(passingSandboxResult("codex_local"));

    const res = await request(makeApp(mountProviders))
      .post(`/api/companies/${COMPANY_ID}/providers/openai/test`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("verified");
    expect(res.body.checks[0].code).toBe("codex_hello_probe_passed");
    expect(mockProbeReadinessInSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: COMPANY_ID, cliTool: "codex", adapterType: "codex_local" }),
    );
    expect(testEnvironment).not.toHaveBeenCalled();
  });
});

/* ── 3. commander-verify.ts route ───────────────────────────────────────── */
describe("D1 gate — POST /companies/:companyId/internal-agent/verify", () => {
  function mountCommander(app: express.Express) {
    app.use("/api", commanderVerifyRoutes(stubDb()));
  }

  it("refuses on cloud_auth (422 blocking) WITHOUT spawning the probe (no company key resolves — mapCloudProviderKeyError, not merely because cloud)", async () => {
    setDeploymentMode("cloud_auth");
    const testEnvironment = vi.fn(async () => passingResult("claude_local"));
    mockFindAdapterRegistry.mockReturnValue({ testEnvironment });
    // beforeEach default: mockProbeReadinessInSandbox rejects with ProviderUnavailableError.

    const res = await request(makeApp(mountCommander))
      .post(`/api/companies/${COMPANY_ID}/internal-agent/verify`)
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.result.status).toBe("fail");
    expect(res.body.result.checks[0].code).toBe("readiness_unavailable_on_cloud");
    // The sandbox path WAS attempted (claude_local has a company-key mapping)
    // and is the reason this blocked — not a bare "we're on cloud" skip.
    expect(mockProbeReadinessInSandbox).toHaveBeenCalledTimes(1);
    expect(testEnvironment).not.toHaveBeenCalled();
    expect(mockVerifyAndBindSubscription).not.toHaveBeenCalled();
  });

  it("proceeds on self-hosted (local_trusted) — the guard is a no-op", async () => {
    setDeploymentMode("local_trusted");
    const testEnvironment = vi.fn(async () => passingResult("claude_local"));
    mockFindAdapterRegistry.mockReturnValue({ testEnvironment });

    const res = await request(makeApp(mountCommander))
      .post(`/api/companies/${COMPANY_ID}/internal-agent/verify`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("verified");
    expect(testEnvironment).toHaveBeenCalledTimes(1);
  });

  // U13.7 additions ─────────────────────────────────────────────────────────
  it("cloud_auth WITH a resolved company provider key: runs the probe through the sandbox, returns 200 verified, and NEVER calls verifyAndBindCommanderSubscriptionCredential", async () => {
    setDeploymentMode("cloud_auth");
    const testEnvironment = vi.fn(async () => passingResult("claude_local"));
    mockFindAdapterRegistry.mockReturnValue({ testEnvironment });
    mockProbeReadinessInSandbox.mockResolvedValue(passingSandboxResult("claude_local"));

    const res = await request(makeApp(mountCommander))
      .post(`/api/companies/${COMPANY_ID}/internal-agent/verify`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("verified");
    expect(res.body.result.checks[0].code).toBe("claude_hello_probe_passed");
    expect(mockProbeReadinessInSandbox).toHaveBeenCalledTimes(1);
    expect(mockProbeReadinessInSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: COMPANY_ID, cliTool: "claude", adapterType: "claude_local" }),
    );
    expect(testEnvironment).not.toHaveBeenCalled();
    // Requirement: the sandbox path authenticates with the COMPANY's own
    // resolved provider key — NEVER a subscription login — so this must never
    // be called for it (only the direct on-host probe path can call it).
    expect(mockVerifyAndBindSubscription).not.toHaveBeenCalled();
  });

  it("opencode_local (no company-key mapping): stays on the unconditional cloud block even with a key resolved elsewhere", async () => {
    setDeploymentMode("cloud_auth");
    mockResolveCommanderType.mockResolvedValue("opencode_local");
    const testEnvironment = vi.fn(async () => passingResult("opencode_local"));
    mockFindAdapterRegistry.mockReturnValue({ testEnvironment });

    const res = await request(makeApp(mountCommander))
      .post(`/api/companies/${COMPANY_ID}/internal-agent/verify`)
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.result.checks[0].code).toBe("readiness_unavailable_on_cloud");
    // opencode_local has no cliTool mapping — the sandbox path is never attempted.
    expect(mockProbeReadinessInSandbox).not.toHaveBeenCalled();
    expect(testEnvironment).not.toHaveBeenCalled();
  });
});
