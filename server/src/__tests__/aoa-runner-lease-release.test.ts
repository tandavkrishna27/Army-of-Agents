// FIX 1 (Wave 2 adversarial review, HIGH — cloud VM/lease leak): runAoaAgent
// (crew) calls `acquireExecutionContext` with no heartbeatRunId, so a resolved
// platform-default E2B lease could NEVER be reaped by the org-only
// `environmentRuntimeService(db).releaseRunLeases(run.id)` sweeper (it lists
// leases `WHERE heartbeat_run_id = <id>` — always null for crew). Before this
// fix nothing released the lease at all: every cloud crew run leaked a billed
// E2B VM (until its ~1h provider timeout) plus a permanently-active
// `environment_leases` row.
//
// This suite drives the REAL exported `runAoaAgent` (harness mirrors
// aoa-runner-tmpfile-cleanup.test.ts's proven proxy-table/fs mock scaffolding)
// with `acquireExecutionContext` mocked to a REALISTIC resolved-sandbox shape
// (same contract as acquire-execution-context.test.ts /
// aoa-runner-brokered-mcp.test.ts's `brokeredAcquired()`), and
// `environment-runtime.js`'s `environmentRuntimeService` mocked so its
// `releaseRunLease` call can be spied on directly. Proves:
//   1. a resolved sandbox lease is released in the `finally` on a SUCCESSFUL
//      run, keyed on the lease record (not heartbeatRunId).
//   2. the SAME release fires on a FAILED (thrown) run — `finally` runs on
//      every exit.
//   3. desktop/local_trusted (acquireExecutionContext resolves sandbox:null)
//      never calls release at all — correct no-op, matches U4's S1 contract.
//
// Real DB-round-trip proof that `environmentRuntimeService(db).releaseRunLease`
// itself actually flips a genuine `environment_leases` row from 'active' to
// 'released' lives in `crew-lease-release.integration.test.ts` (embedded-PG) —
// this file's job is narrower: prove runner.ts ITSELF calls that function, on
// every exit path, with the right arguments.
import { describe, expect, it, vi } from "vitest";

const {
  execMock,
  createEventMock,
  writeFileMock,
  unlinkMock,
  resolveConnectorsMock,
  runLogStoreMock,
  acquireExecutionContextMock,
  releaseRunLeaseMock,
} = vi.hoisted(() => ({
  execMock: vi.fn().mockResolvedValue({ exitCode: 0 }),
  createEventMock: vi.fn().mockResolvedValue(undefined),
  writeFileMock: vi.fn().mockResolvedValue(undefined),
  unlinkMock: vi.fn().mockResolvedValue(undefined),
  resolveConnectorsMock: vi.fn().mockResolvedValue({ extraMcpServers: {}, connectorEnv: {} }),
  runLogStoreMock: {
    begin: vi.fn().mockResolvedValue({ store: "local_file", logRef: "co-1/a-1/run-1.ndjson" }),
    append: vi.fn().mockResolvedValue(undefined),
    finalize: vi.fn().mockResolvedValue({ bytes: 0, compressed: false }),
    read: vi.fn(),
  },
  // Default: desktop/local_trusted — no sandbox resolves (U4/S1 contract).
  // Individual tests override with mockResolvedValueOnce for the brokered case.
  acquireExecutionContextMock: vi.fn().mockResolvedValue({ sandbox: null, lease: null, warmResolved: false }),
  releaseRunLeaseMock: vi.fn().mockResolvedValue(null),
}));

vi.mock("drizzle-orm", () => ({ and: (...a: unknown[]) => ({ and: a }), eq: (a: unknown, b: unknown) => ({ eq: [a, b] }) }));
vi.mock("@armyofagents/db", () => {
  const t = (n: string) => new Proxy({}, { get: (_x, p) => (typeof p === "string" ? Symbol(`${n}.${p}`) : undefined) });
  return {
    agents: t("a"), internalAgentRuns: t("iar"), discussionEntries: t("de"), memoryItems: t("mi"),
    discussions: t("disc"), discussionExtractedItems: t("dei"), embeddingQueue: t("eq"),
    memoryItemVersions: t("miv"), memoryRetrievals: t("mr"), suggestions: t("sug"),
  };
});
vi.mock("../adapters/registry.js", () => ({ getServerAdapter: () => ({ execute: execMock, getRuntimeCommandSpec: () => ({}) }) }));
vi.mock("../services/costs.js", () => ({ costService: () => ({ createEvent: createEventMock }) }));
vi.mock("../services/internal-agent/cli-mode.js", () => ({
  buildMcpConfig: vi.fn(() => ({ mcpServers: {} })),
  buildMcpBridgeSpec: vi.fn(() => ({ command: "node", args: ["/bridge.js"], env: {} })),
  buildCodexAoaMcpSpec: vi.fn(() => ({ command: "node", args: ["/bridge.js"], env: {} })),
}));
vi.mock("../services/heartbeat.js", () => ({
  resolveAdapterExecutionContextUnguarded: () => ({ executionTarget: {}, runtimeCommandSpec: {} }),
  resolveGuardedAdapterExecutionContext: () => ({ executionTarget: {}, runtimeCommandSpec: {} }),
  applyEnvironmentAcquisitionConfig: (config: unknown) => config,
}));
// The DI seam this suite exercises for acquisition (mirrors
// aoa-runner-brokered-mcp.test.ts): a REALISTIC {sandbox,lease,warmResolved}
// shape, not the real orchestrator.
vi.mock("../services/acquire-execution-context.js", () => ({
  acquireExecutionContext: acquireExecutionContextMock,
}));
// FIX 1: the seam under test — spy on releaseRunLease so the finally-block
// call site (runner.ts) is proven to invoke it with the right args.
vi.mock("../services/environment-runtime.js", () => ({
  environmentRuntimeService: () => ({ releaseRunLease: releaseRunLeaseMock }),
  // U13.1 added this export; the one-shot-sandbox-cli chain imports it, so the
  // mock must expose it or the module-load export check fails.
  resolveRuntimeProviderConfig: vi.fn().mockResolvedValue({}),
}));
vi.mock("../services/internal-agent/aoa-agents/bridge-path.js", () => ({ resolveBridgeEntrypoint: () => "/x/mcp-bridge.js" }));
vi.mock("node:fs/promises", () => {
  const api = {
    writeFile: writeFileMock,
    unlink: unlinkMock,
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
  loadConnectorEgressHosts: vi.fn().mockResolvedValue([]),
}));
vi.mock("../services/run-log-store.js", () => ({ getRunLogStore: () => runLogStoreMock }));
vi.mock("../middleware/logger.js", () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }));
vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: vi.fn(() => ({ getExperimental: vi.fn().mockResolvedValue({ enableIsolatedWorkspaces: true }) })),
}));
vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
  publishIssueStatusChanged: vi.fn(),
  threadWorkingAgents: { add: vi.fn(), remove: vi.fn(() => []), list: vi.fn(() => []) },
  broadcastThreadPresence: vi.fn(),
}));

import { runAoaAgent } from "../services/internal-agent/aoa-agents/runner.js";

function makeDb() {
  const agentRow = {
    id: "a-1",
    companyId: "co-1",
    name: "Scribe",
    adapterType: "process",
    runtimeConfig: { aoa: { role: "scribe" } },
    adapterConfig: {},
  };
  const selectChain: any = {};
  selectChain.from = () => selectChain;
  selectChain.where = () => selectChain;
  selectChain.then = (resolve: (v: unknown[]) => unknown) =>
    Promise.resolve([agentRow]).then(resolve);

  const updateChain: any = {};
  updateChain.set = () => updateChain;
  updateChain.where = () => updateChain;
  updateChain.returning = () => Promise.resolve([{ id: "run-1" }]);
  updateChain.then = (resolve: (v: unknown[]) => unknown) =>
    Promise.resolve([{ id: "run-1" }]).then(resolve);

  return {
    select: () => selectChain,
    insert: () => ({
      values: () => ({ returning: () => Promise.resolve([{ id: "run-1" }]) }),
    }),
    update: () => updateChain,
  };
}

/** The AcquiredExecutionContext shape a resolved provider-sandbox lease has
 *  (mirrors EnvironmentAcquisitionResult — see aoa-runner-brokered-mcp.test.ts). */
function brokeredAcquired() {
  return {
    sandbox: {
      environment: { id: "env-1", companyId: "co-1", driver: "sandbox" },
      lease: { id: "lease-1", provider: "e2b", providerLeaseId: "e2b-lease-1", metadata: {} },
      adapterType: "process",
      configPatch: { executionTarget: { type: "provider-sandbox", provider: "e2b", providerLeaseId: "lease-1", remoteCwd: "/workspace" } },
    },
    lease: { id: "lease-1", provider: "e2b", providerLeaseId: "e2b-lease-1", metadata: {} },
    warmResolved: false,
  };
}

describe("FIX 1: runAoaAgent releases the crew sandbox lease in the finally on every exit", () => {
  it("resolved sandbox + successful run: releaseRunLease is called once, keyed on the lease record (status:'released')", async () => {
    releaseRunLeaseMock.mockClear();
    acquireExecutionContextMock.mockResolvedValueOnce(brokeredAcquired());
    execMock.mockResolvedValueOnce({ exitCode: 0 });

    const result = await runAoaAgent(makeDb() as any, "a-1", { companyId: "co-1", source: "wakeup" });
    expect(result.status).toBe("succeeded");

    expect(releaseRunLeaseMock).toHaveBeenCalledTimes(1);
    expect(releaseRunLeaseMock).toHaveBeenCalledWith({
      environment: { id: "env-1", companyId: "co-1", driver: "sandbox" },
      lease: { id: "lease-1", provider: "e2b", providerLeaseId: "e2b-lease-1", metadata: {} },
      status: "released",
    });
  });

  it("resolved sandbox + adapter THROWS (thrown failure path): releaseRunLease still fires — finally runs on every exit", async () => {
    releaseRunLeaseMock.mockClear();
    acquireExecutionContextMock.mockResolvedValueOnce(brokeredAcquired());
    execMock.mockRejectedValueOnce(new Error("adapter boom"));

    const result = await runAoaAgent(makeDb() as any, "a-1", { companyId: "co-1", source: "wakeup" });
    expect(result.status).toBe("failed");

    expect(releaseRunLeaseMock).toHaveBeenCalledTimes(1);
    expect(releaseRunLeaseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: expect.objectContaining({ id: "env-1" }),
        lease: expect.objectContaining({ id: "lease-1" }),
        status: "released",
      }),
    );
  });

  it("resolved sandbox + adapter reports non-throwing failure (exitCode!=0): releaseRunLease still fires", async () => {
    releaseRunLeaseMock.mockClear();
    acquireExecutionContextMock.mockResolvedValueOnce(brokeredAcquired());
    execMock.mockResolvedValueOnce({ exitCode: 1, errorMessage: "non-zero exit" });

    const result = await runAoaAgent(makeDb() as any, "a-1", { companyId: "co-1", source: "wakeup" });
    expect(result.status).toBe("failed");

    expect(releaseRunLeaseMock).toHaveBeenCalledTimes(1);
  });

  it("desktop/local_trusted (acquireExecutionContext resolves sandbox:null): releaseRunLease is NEVER called — correct no-op", async () => {
    releaseRunLeaseMock.mockClear();
    acquireExecutionContextMock.mockResolvedValueOnce({ sandbox: null, lease: null, warmResolved: false });
    execMock.mockResolvedValueOnce({ exitCode: 0 });

    const result = await runAoaAgent(makeDb() as any, "a-1", { companyId: "co-1", source: "wakeup" });
    expect(result.status).toBe("succeeded");

    expect(releaseRunLeaseMock).not.toHaveBeenCalled();
  });
});
