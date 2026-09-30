// U4b (S7 blocker): crew's caller-side wiring of the `brokered` MCP flag.
//
// runner.ts sets `mcpParams.brokered = acquired.sandbox?.environment.driver
// === "sandbox"` immediately after U4's `acquireExecutionContext` call and
// BEFORE building the claude `--mcp-config` file / the provider-neutral
// `ctx.mcpBridge` spec (via `buildCodexAoaMcpSpec`). This suite drives the
// REAL exported `runAoaAgent` (harness mirrors aoa-runner.test.ts's proven
// mock-DB/fs scaffolding) with `acquireExecutionContext` mocked to a
// REALISTIC sandbox-lease shape — the exact same seam
// `acquire-execution-context.integration.test.ts` itself DI's at — so the
// production `mcpParams.brokered = ...` line, and the real `buildMcpConfig`/
// `buildCodexAoaMcpSpec` (cli-mode.js is left UNMOCKED here, unlike every
// other runner suite) all execute for real. A regression that stops setting
// `brokered`, or that reintroduces the stdio bridge for a brokered run, goes
// red here.
//
// Layering note: `acquireExecutionContext`'s OWN correctness (does a null
// environmentId really resolve a real provider-sandbox lease via the real
// orchestrator on cloud_auth?) is proven separately by
// `acquire-execution-context.integration.test.ts` (embedded-PG) and, for the
// downstream MCP-config-building chain fed a GENUINE (non-mocked) acquired
// sandbox, by `brokered-mcp-no-db-url.integration.test.ts` (embedded-PG).
// This file's job is narrower and complementary: prove runner.ts ITSELF
// reads `acquired.sandbox?.environment.driver` and threads it through to the
// staged config, using the exact production code path (no re-implementation).
import { describe, expect, it, vi } from "vitest";

const {
  execMock,
  createEventMock,
  writeFileMock,
  resolveConnectorsMock,
  loadConnectorEgressHostsMock,
  runLogStoreMock,
  acquireExecutionContextMock,
} = vi.hoisted(() => ({
  execMock: vi.fn().mockResolvedValue({ exitCode: 0 }),
  createEventMock: vi.fn().mockResolvedValue(undefined),
  writeFileMock: vi.fn().mockResolvedValue(undefined),
  resolveConnectorsMock: vi.fn().mockResolvedValue({ extraMcpServers: {}, connectorEnv: {}, egressHosts: [] }),
  // U11: the PRE-acquire egress-hosts estimate runner.ts calls before
  // acquireExecutionContext. Default empty; individual tests override.
  loadConnectorEgressHostsMock: vi.fn().mockResolvedValue([]),
  runLogStoreMock: {
    begin: vi.fn().mockResolvedValue({ store: "local_file", logRef: "co-1/ext-1/run-1.ndjson" }),
    append: vi.fn().mockResolvedValue(undefined),
    finalize: vi.fn().mockResolvedValue({ bytes: 0, compressed: false }),
    read: vi.fn(),
  },
  // Default: desktop/local_trusted — no sandbox resolves (U4/S1 contract).
  // Individual tests override with mockResolvedValueOnce for the brokered case.
  acquireExecutionContextMock: vi.fn().mockResolvedValue({ sandbox: null, lease: null, warmResolved: false }),
}));

vi.mock("drizzle-orm", () => ({ and: (...a: unknown[]) => ({ and: a }), eq: (a: unknown, b: unknown) => ({ eq: [a, b] }), isNull: (a: unknown) => ({ isNull: a }) }));
vi.mock("@armyofagents/db", () => {
  const t = (n: string) => new Proxy({}, { get: (_x, p) => (typeof p === "string" ? Symbol(`${n}.${p}`) : undefined) });
  return {
    agents: t("a"), internalAgentRuns: t("iar"), discussionEntries: t("de"), memoryItems: t("mi"),
    discussions: t("disc"), discussionExtractedItems: t("dei"), embeddingQueue: t("eq"),
    memoryItemVersions: t("miv"), memoryRetrievals: t("mr"), suggestions: t("sug"),
    companySecrets: t("cs"), companySecretVersions: t("csv"), companySecretBindings: t("csb"),
    companySecretProviderConfigs: t("cspc"), runtimeProviderKeys: t("rpk"), secretAccessEvents: t("sae"),
  };
});
vi.mock("../adapters/registry.js", () => ({ getServerAdapter: () => ({ execute: execMock, getRuntimeCommandSpec: () => ({}) }) }));
vi.mock("../services/costs.js", () => ({ costService: () => ({ createEvent: createEventMock }) }));
// U4b: unlike every other runner suite, cli-mode.js is left UNMOCKED — the
// real buildMcpConfig / buildCodexAoaMcpSpec must run so a regression in the
// honoring code (not just the caller-side flag) goes red here too.
vi.mock("../services/heartbeat.js", () => ({
  resolveAdapterExecutionContextUnguarded: () => ({ executionTarget: {}, runtimeCommandSpec: {} }),
  resolveGuardedAdapterExecutionContext: () => ({ executionTarget: {}, runtimeCommandSpec: {} }),
  applyEnvironmentAcquisitionConfig: (config: unknown) => config,
}));
// The DI seam this suite exercises: acquireExecutionContext is mocked to a
// REALISTIC {sandbox,lease,warmResolved} shape (matching the real
// AcquiredExecutionContext contract asserted by acquire-execution-context.
// test.ts / .integration.test.ts) rather than driving the real orchestrator —
// see the file header for why that split is the right layering.
vi.mock("../services/acquire-execution-context.js", () => ({
  acquireExecutionContext: acquireExecutionContextMock,
}));
vi.mock("../services/internal-agent/aoa-agents/bridge-path.js", () => ({ resolveBridgeEntrypoint: () => "/x/mcp-bridge.js" }));
vi.mock("node:fs/promises", () => {
  const api = {
    writeFile: writeFileMock,
    unlink: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
  };
  return { ...api, default: api };
});
vi.mock("../services/provider-resolution.js", () => ({
  resolveProviderCredential: vi.fn(async () => ({ source: "agent_env_override" })),
  applyResolvedCredential: (config: unknown) => config,
  toExecutionTargetHint: () => ({ credentialKind: null, executionTargetSlug: null }),
}));
vi.mock("../services/mcp-connectors-loader.js", () => ({
  resolveAgentConnectors: resolveConnectorsMock,
  loadConnectorEgressHosts: loadConnectorEgressHostsMock,
}));
vi.mock("../services/run-log-store.js", () => ({ getRunLogStore: () => runLogStoreMock }));
vi.mock("../middleware/logger.js", () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }));
vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: vi.fn(() => ({ getExperimental: vi.fn().mockResolvedValue({ enableIsolatedWorkspaces: true }) })),
}));

import { runAoaAgent } from "../services/internal-agent/aoa-agents/runner.js";

function ch(ret: unknown[]) {
  const c: any = {};
  c.values = () => c; c.set = () => c; c.where = () => c; c.from = () => c;
  c.returning = () => Promise.resolve(ret);
  c.then = (r: (v: unknown[]) => unknown) => Promise.resolve(ret).then(r);
  return c;
}

/** The AcquiredExecutionContext shape a resolved provider-sandbox lease has
 *  (mirrors EnvironmentAcquisitionResult — S5/S6 in the plan). */
function brokeredAcquired() {
  return {
    sandbox: {
      environment: { id: "env-1", companyId: "co-1", driver: "sandbox" },
      lease: { id: "lease-1", provider: "e2b", providerLeaseId: "e2b-lease-1", metadata: {} },
      adapterType: "claude_local",
      configPatch: { executionTarget: { type: "provider-sandbox", provider: "e2b", providerLeaseId: "lease-1", remoteCwd: "/workspace" } },
    },
    lease: { id: "lease-1", provider: "e2b", providerLeaseId: "e2b-lease-1", metadata: {} },
    warmResolved: false,
  };
}

describe("U4b: crew sets brokered from acquired.sandbox?.environment.driver (S7)", () => {
  it("claude_local + resolved sandbox: mcpParams.brokered flows into the staged --mcp-config file as an HTTP aoa entry, no DATABASE_URL", async () => {
    writeFileMock.mockClear();
    acquireExecutionContextMock.mockResolvedValueOnce(brokeredAcquired());
    const savedApiUrl = process.env.AOA_API_URL;
    const savedDbUrl = process.env.DATABASE_URL;
    process.env.AOA_API_URL = "https://cp.example.test";
    process.env.DATABASE_URL = "postgres://should-be-absent:5432/db";
    try {
      const db: any = {
        select: () => ch([{ id: "cl-brokered", companyId: "co-1", name: "Scribe", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: { aoa: { instruction: "do extraction", role: "scribe" } } }]),
        insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: "run-brokered" }]) }) }),
        update: () => ch([{ id: "e1" }]),
      };
      const result = await runAoaAgent(db, "cl-brokered", { companyId: "co-1", source: "discussion_entry_pending", entryId: "e1" });
      expect(result.status).toBe("succeeded");

      // The acquire call resolved for real — confirm the caller read the S5 field.
      expect(acquireExecutionContextMock).toHaveBeenCalledTimes(1);

      // U11: the connector delivery selector reads the SAME S5 acquisition
      // signal as mcpParams.brokered — a brokered run's stdio connectors are
      // admissible in-VM.
      const connectorsCallBrokered = resolveConnectorsMock.mock.calls.at(-1)![1] as { sandboxTarget?: boolean };
      expect(connectorsCallBrokered.sandboxTarget).toBe(true);

      // The staged claude --mcp-config file (written before adapter.execute).
      const written = writeFileMock.mock.calls.find(([path]: [string]) => String(path).includes("aoa-mcp-cl-brokered"));
      expect(written).toBeTruthy();
      const staged = JSON.parse(written![1] as string);
      expect(staged.mcpServers.aoa).toMatchObject({
        type: "http",
        url: "https://cp.example.test/companies/co-1/mcp",
      });
      expect(staged.mcpServers.aoa.command).toBeUndefined();
      const rawStaged = JSON.stringify(staged);
      expect(rawStaged).not.toContain("DATABASE_URL");
      expect(rawStaged).not.toMatch(/postgres(ql)?:\/\//);

      // ctx.mcpBridge (the non-claude carrier, ALSO handed to claude) must be
      // the SAME brokered HTTP shape — proves runner.ts routed bridgeSpec
      // through buildCodexAoaMcpSpec, not the unconditional stdio builder.
      const execArg = execMock.mock.calls.at(-1)![0];
      expect(execArg.mcpBridge).toMatchObject({
        kind: "http",
        url: "https://cp.example.test/companies/co-1/mcp",
        authTokenEnvVar: "AOA_API_KEY",
      });
      expect(JSON.stringify(execArg.mcpBridge)).not.toContain("DATABASE_URL");
    } finally {
      if (savedApiUrl === undefined) delete process.env.AOA_API_URL; else process.env.AOA_API_URL = savedApiUrl;
      if (savedDbUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedDbUrl;
    }
  });

  it("codex_local + resolved sandbox: ctx.mcpBridge is the HTTP spec (no DATABASE_URL); claude-only --mcp-config never leaks into codex argv", async () => {
    execMock.mockClear();
    acquireExecutionContextMock.mockResolvedValueOnce(brokeredAcquired());
    const savedApiUrl = process.env.AOA_API_URL;
    const savedDbUrl = process.env.DATABASE_URL;
    process.env.AOA_API_URL = "https://cp.example.test";
    process.env.DATABASE_URL = "postgres://should-be-absent:5432/db";
    try {
      const db: any = {
        select: () => ch([{ id: "cx-brokered", companyId: "co-1", name: "Scribe", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: { aoa: { instruction: "do extraction", role: "scribe" } } }]),
        insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: "run-cx-brokered" }]) }) }),
        update: () => ch([{ id: "e1" }]),
      };
      const result = await runAoaAgent(db, "cx-brokered", { companyId: "co-1", source: "discussion_entry_pending", entryId: "e1" });
      expect(result.status).toBe("succeeded");

      const execArg = execMock.mock.calls.at(-1)![0];
      expect(execArg.mcpBridge).toEqual({
        kind: "http",
        url: "https://cp.example.test/companies/co-1/mcp",
        headers: {},
        authTokenEnvVar: "AOA_API_KEY",
      });
      expect(JSON.stringify(execArg.mcpBridge)).not.toContain("DATABASE_URL");
      expect(execArg.config.args ?? []).not.toContain("--mcp-config");
      expect(execArg.config.extraArgs ?? []).not.toContain("--mcp-config");

      // U11: codex is also connector-capable — same S5 signal, sandboxTarget true.
      const connectorsCallCodex = resolveConnectorsMock.mock.calls.at(-1)![1] as { sandboxTarget?: boolean };
      expect(connectorsCallCodex.sandboxTarget).toBe(true);
    } finally {
      if (savedApiUrl === undefined) delete process.env.AOA_API_URL; else process.env.AOA_API_URL = savedApiUrl;
      if (savedDbUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedDbUrl;
    }
  });

  it("desktop/local_trusted (acquireExecutionContext resolves sandbox:null): stdio delivery is byte-identical — DATABASE_URL still present when set, brokered strictly additive", async () => {
    execMock.mockClear();
    writeFileMock.mockClear();
    // Explicit default-shape override (belt-and-suspenders — this IS the
    // module's default mock, but pin it locally so the test survives reordering).
    acquireExecutionContextMock.mockResolvedValueOnce({ sandbox: null, lease: null, warmResolved: false });
    const savedDbUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://should-be-present:5432/db";
    try {
      const db: any = {
        select: () => ch([{ id: "cl-desktop", companyId: "co-1", name: "Scribe", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: { aoa: { instruction: "do extraction", role: "scribe" } } }]),
        insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: "run-desktop" }]) }) }),
        update: () => ch([{ id: "e1" }]),
      };
      const result = await runAoaAgent(db, "cl-desktop", { companyId: "co-1", source: "discussion_entry_pending", entryId: "e1" });
      expect(result.status).toBe("succeeded");

      const written = writeFileMock.mock.calls.find(([path]: [string]) => String(path).includes("aoa-mcp-cl-desktop"));
      const staged = JSON.parse(written![1] as string);
      // Byte-identical stdio shape — type:"http" must NOT appear.
      expect(staged.mcpServers.aoa.type).toBeUndefined();
      expect(staged.mcpServers.aoa.command).toBe("node");
      expect(staged.mcpServers.aoa.env.DATABASE_URL).toBe("postgres://should-be-present:5432/db");

      const execArg = execMock.mock.calls.at(-1)![0];
      expect(execArg.mcpBridge.command).toBe("node");
      expect(execArg.mcpBridge.env.DATABASE_URL).toBe("postgres://should-be-present:5432/db");

      // U11: unsandboxed (sandbox:null) run — sandboxTarget must be false,
      // additive/strictly-off, mirroring `brokered`'s own byte-identical claim.
      const connectorsCallDesktop = resolveConnectorsMock.mock.calls.at(-1)![1] as { sandboxTarget?: boolean };
      expect(connectorsCallDesktop.sandboxTarget).toBe(false);
    } finally {
      if (savedDbUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedDbUrl;
    }
  });
});

// U11 (S4 egress seam): the PRE-acquire connector-hosts estimate feeds the
// sandbox provider's egressAllowlist. Ordering-driven (see the doc-comment on
// loadConnectorEgressHosts): the estimate MUST be computed and passed into
// acquireExecutionContext BEFORE the acquire call itself — the real,
// post-acquire resolveAgentConnectors call is too late to inform the lease
// that's already been requested.
describe("U11: crew feeds the pre-acquire egress-hosts estimate into acquireExecutionContext", () => {
  it("computes loadConnectorEgressHosts for THIS agent and forwards it verbatim as egressAllowlist", async () => {
    execMock.mockClear();
    acquireExecutionContextMock.mockClear();
    loadConnectorEgressHostsMock.mockClear();
    loadConnectorEgressHostsMock.mockResolvedValueOnce(["mcp.notion.com", "registry.npmjs.org"]);
    acquireExecutionContextMock.mockResolvedValueOnce({ sandbox: null, lease: null, warmResolved: false });

    const db: any = {
      select: () => ch([{ id: "cl-egress", companyId: "co-1", name: "Scribe", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: { aoa: { instruction: "do extraction", role: "scribe" } } }]),
      insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: "run-egress" }]) }) }),
      update: () => ch([{ id: "e1" }]),
    };
    const result = await runAoaAgent(db, "cl-egress", { companyId: "co-1", source: "discussion_entry_pending", entryId: "e1" });
    expect(result.status).toBe("succeeded");

    // Estimate computed for the REAL agent identity.
    expect(loadConnectorEgressHostsMock).toHaveBeenCalledWith(db, { companyId: "co-1", agentId: "cl-egress" });

    // ...and threaded into the SAME acquireExecutionContext call, BEFORE the
    // acquire resolves — i.e. this is not the post-acquire connector call.
    expect(acquireExecutionContextMock).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ egressAllowlist: ["mcp.notion.com", "registry.npmjs.org"] }),
    );
  });

  it("a non-connector-capable adapter (process) never calls loadConnectorEgressHosts", async () => {
    loadConnectorEgressHostsMock.mockClear();
    acquireExecutionContextMock.mockClear();
    acquireExecutionContextMock.mockResolvedValueOnce({ sandbox: null, lease: null, warmResolved: false });

    const db: any = {
      select: () => ch([{ id: "proc-egress", companyId: "co-1", name: "Proc", adapterType: "process", adapterConfig: {}, runtimeConfig: { aoa: { instruction: "do extraction", role: "scribe" } } }]),
      insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: "run-proc-egress" }]) }) }),
      update: () => ch([{ id: "e1" }]),
    };
    await runAoaAgent(db, "proc-egress", { companyId: "co-1", source: "discussion_entry_pending", entryId: "e1" });

    expect(loadConnectorEgressHostsMock).not.toHaveBeenCalled();
    expect(acquireExecutionContextMock).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ egressAllowlist: [] }),
    );
  });
});
