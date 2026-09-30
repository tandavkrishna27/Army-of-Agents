// U12: on cloud (cloud_auth / tenantIsolationEnforced), a crew run whose
// provider-credential resolution finds no company key must FAIL BEFORE any
// sandbox spend, with founder-facing guidance landing in BOTH the
// internalAgentRuns failure row and the postCrewRunFailure thread card.
//
// This suite drives the REAL exported `runAoaAgent` (harness mirrors
// aoa-runner-brokered-mcp.test.ts's proven mock-DB/fs scaffolding), with
// `resolveProviderCredential` mocked to throw the REAL ProviderUnavailableError
// (cloud's actual no-key outcome — provider-resolution.ts:450) and
// `acquireExecutionContext` mocked as a spy so this test can assert it was
// NEVER called: the sandbox lease must not be acquired when the run is about
// to fail on a missing provider key.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { setDeploymentMode, getDeploymentMode } from "../config/deployment-mode.js";

const {
  execMock,
  writeFileMock,
  resolveConnectorsMock,
  acquireExecutionContextMock,
  resolveProviderCredentialMock,
  postCrewRunFailureMock,
} = vi.hoisted(() => ({
  execMock: vi.fn().mockResolvedValue({ exitCode: 0 }),
  writeFileMock: vi.fn().mockResolvedValue(undefined),
  resolveConnectorsMock: vi.fn().mockResolvedValue({ extraMcpServers: {}, connectorEnv: {} }),
  // U12 assertion target: must stay UNCALLED when credential resolution throws.
  acquireExecutionContextMock: vi.fn().mockResolvedValue({ sandbox: null, lease: null, warmResolved: false }),
  resolveProviderCredentialMock: vi.fn(),
  postCrewRunFailureMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ and: a }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  isNull: (a: unknown) => ({ isNull: a }),
  sql: Object.assign((strings: TemplateStringsArray, ...vals: unknown[]) => ({ sql: strings.join("?"), vals }), {}),
}));
vi.mock("@armyofagents/db", () => {
  const t = (n: string) => new Proxy({}, { get: (_x, p) => (typeof p === "string" ? Symbol(`${n}.${p}`) : undefined) });
  return {
    agents: t("a"), internalAgentRuns: t("iar"), discussionEntries: t("de"), memoryItems: t("mi"),
    discussions: t("disc"), discussionExtractedItems: t("dei"), embeddingQueue: t("eq"),
    memoryItemVersions: t("miv"), memoryRetrievals: t("mr"), suggestions: t("sug"),
    companySecrets: t("cs"), companySecretVersions: t("csv"), companySecretBindings: t("csb"),
    companySecretProviderConfigs: t("cspc"), runtimeProviderKeys: t("rpk"), secretAccessEvents: t("sae"),
    issues: t("issues"), threadOrchestrationState: t("tos"), workQuestions: t("wq"),
  };
});
vi.mock("../adapters/registry.js", () => ({ getServerAdapter: () => ({ execute: execMock, getRuntimeCommandSpec: () => ({}) }) }));
vi.mock("../services/costs.js", () => ({ costService: () => ({ createEvent: vi.fn().mockResolvedValue(undefined) }) }));
vi.mock("../services/heartbeat.js", () => ({
  resolveAdapterExecutionContextUnguarded: () => ({ executionTarget: {}, runtimeCommandSpec: {} }),
  resolveGuardedAdapterExecutionContext: () => ({ executionTarget: {}, runtimeCommandSpec: {} }),
  applyEnvironmentAcquisitionConfig: (config: unknown) => config,
}));
// The DI seam under test: never resolved-through when the credential throw
// happens first.
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
// U12: the REAL ProviderUnavailableError class (so `instanceof` checks in
// require-cloud-provider-key.ts — which imports from this SAME specifier —
// hold true across the mock boundary), with resolveProviderCredential
// rejecting with it (cloud's actual no-company-key outcome).
vi.mock("../services/provider-resolution.js", () => {
  class ProviderUnavailableError extends Error {
    readonly code = "provider_unavailable";
    constructor(readonly provider: string, readonly reason: string, readonly connectionId: string | null) {
      super(`No usable ${provider} provider credential for this run (${reason}).`);
      this.name = "ProviderUnavailableError";
    }
  }
  return {
    ProviderUnavailableError,
    resolveProviderCredential: resolveProviderCredentialMock,
    applyResolvedCredential: (config: unknown) => config,
    toExecutionTargetHint: () => ({ credentialKind: null, executionTargetSlug: null }),
  };
});
vi.mock("../services/mcp-connectors-loader.js", () => ({
  resolveAgentConnectors: resolveConnectorsMock,
  loadConnectorEgressHosts: vi.fn().mockResolvedValue([]),
}));
vi.mock("../services/run-log-store.js", () => ({
  getRunLogStore: () => ({
    begin: vi.fn().mockResolvedValue({ store: "local_file", logRef: "test-run.ndjson" }),
    append: vi.fn().mockResolvedValue(undefined),
    finalize: vi.fn().mockResolvedValue({ bytes: 0, compressed: false }),
    read: vi.fn(),
  }),
}));
vi.mock("../middleware/logger.js", () => {
  function makeLogger(): any {
    const l: any = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    l.child = () => makeLogger();
    return l;
  }
  return { logger: makeLogger() };
});
vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: vi.fn(() => ({ getExperimental: vi.fn().mockResolvedValue({ enableIsolatedWorkspaces: true }) })),
}));
// The failure-card surface under test: postCrewRunFailure must receive the
// SAME mapped guidance message as the internalAgentRuns failure row.
vi.mock("../services/internal-agent/aoa-agents/crew-run-outcome.js", () => ({
  postCrewRunFailure: postCrewRunFailureMock,
  postCrewRunSuccess: vi.fn(),
  resolveCrewOutcomeKind: (s: string) => (s === "succeeded" ? "success" : "failure"),
}));
// issueService: a payload.issueId dispatch runs issueService(db).checkout(...)
// before the credential resolution under test, and issueService(db).getById(...)
// in the post-failure task-release block. The real checkout() does a
// dependency-aware conditional UPDATE (or/isNull/and) this suite's minimal
// drizzle-orm mock does not model — stub both methods so a task dispatch
// reaches the credential-resolution code path under test instead of tripping
// the (unrelated, best-effort) "task checkout conflict" early return.
vi.mock("../services/issues.js", () => ({
  issueService: () => ({
    checkout: vi.fn().mockResolvedValue(undefined),
    getById: vi.fn().mockResolvedValue(null),
  }),
}));

import { runAoaAgent } from "../services/internal-agent/aoa-agents/runner.js";

function ch(ret: unknown[]) {
  const c: any = {};
  c.values = () => c; c.set = () => c; c.where = () => c; c.from = () => c;
  c.returning = () => Promise.resolve(ret);
  c.then = (r: (v: unknown[]) => unknown) => Promise.resolve(ret).then(r);
  c.catch = () => Promise.resolve();
  return c;
}

/** Like `ch()`, but records every update().set() payload so the test can
 *  assert on what the internalAgentRuns failure UPDATE actually wrote —
 *  the exact surface the U12 false-green fix targets. */
function makeUpdateRecorder(sets: any[], ret: unknown[]) {
  return () => {
    const c: any = {};
    let payload: any;
    c.set = (v: any) => { payload = v; return c; };
    c.where = (w: any) => {
      sets.push({ set: payload, where: w });
      const p: any = Promise.resolve(ret);
      p.returning = () => Promise.resolve(ret);
      p.catch = () => Promise.resolve();
      p.then = (r: (v: unknown[]) => unknown) => Promise.resolve(ret).then(r);
      return p;
    };
    return c;
  };
}

const savedDeploymentMode = getDeploymentMode();
afterEach(() => {
  setDeploymentMode(savedDeploymentMode);
});

describe("U12: cloud crew run with no company provider key fails before sandbox spend", () => {
  beforeEach(() => {
    execMock.mockClear();
    writeFileMock.mockClear();
    acquireExecutionContextMock.mockClear();
    resolveProviderCredentialMock.mockReset();
    postCrewRunFailureMock.mockClear();
  });

  it("cloud_auth + no company key: run fails, internalAgentRuns row + failure card both carry the mapped guidance, and acquireExecutionContext is NEVER called", async () => {
    setDeploymentMode("cloud_auth");
    resolveProviderCredentialMock.mockRejectedValue(
      Object.assign(new Error("no usable credential"), { code: "provider_unavailable" }),
    );

    const sets: any[] = [];
    const db: any = {
      select: () => ch([{
        id: "cl-nokey", companyId: "co-1", name: "Scribe", adapterType: "claude_local",
        adapterConfig: {}, runtimeConfig: { aoa: { instruction: "do work", role: "scribe" } },
      }]),
      insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: "run-nokey" }]) }) }),
      update: makeUpdateRecorder(sets, [{ id: "task-1" }]),
    };

    const result = await runAoaAgent(db, "cl-nokey", {
      companyId: "co-1",
      source: "task_wakeup",
      issueId: "task-1",
    });

    expect(result.status).toBe("failed");

    // The mapped guidance, not the raw "no usable credential" resolver text.
    expect(result.errorMessage).toMatch(/provider (API )?key/i);
    expect(result.errorMessage).not.toMatch(/install/i);

    // False-green fix: the internalAgentRuns failure UPDATE carries the SAME
    // mapped message (was: re-materialized from the raw `err`, byte-for-byte
    // identical to the resolver's raw text — the DB row used to miss the
    // guidance even when the mapper existed).
    const runFailUpdate = sets.find((s) => s.set?.status === "failed" && "errorMessage" in (s.set ?? {}));
    expect(runFailUpdate).toBeDefined();
    expect(runFailUpdate.set.errorMessage).toBe(result.errorMessage);
    expect(runFailUpdate.set.errorMessage).toMatch(/provider (API )?key/i);
    expect(runFailUpdate.set.errorMessage).not.toMatch(/install/i);

    // The failure card (postCrewRunFailure) received the identical mapped message.
    expect(postCrewRunFailureMock).toHaveBeenCalledTimes(1);
    const failureCardArgs = postCrewRunFailureMock.mock.calls[0][1];
    expect(failureCardArgs.errorMessage).toBe(result.errorMessage);
    expect(failureCardArgs.errorMessage).toMatch(/provider (API )?key/i);

    // The core U12 guarantee: no sandbox lease is acquired for a run that is
    // about to fail on a missing provider key.
    expect(acquireExecutionContextMock).not.toHaveBeenCalled();

    // adapter.execute must never run either — the whole point is failing
    // before any spend, including CLI spawn.
    expect(execMock).not.toHaveBeenCalled();
  });

  it("desktop / local_trusted: resolver returns host_login_fallback (never throws) — unaffected by the mapper", async () => {
    // Deliberately NOT cloud_auth.
    resolveProviderCredentialMock.mockResolvedValue({ source: "host_login_fallback" });

    const db: any = {
      select: () => ch([{
        id: "cl-desktop-key", companyId: "co-1", name: "Scribe", adapterType: "claude_local",
        adapterConfig: {}, runtimeConfig: { aoa: { instruction: "do work", role: "scribe" } },
      }]),
      insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: "run-desktop-key" }]) }) }),
      update: () => ch([{ id: "task-1" }]),
    };

    const result = await runAoaAgent(db, "cl-desktop-key", {
      companyId: "co-1",
      source: "discussion_entry_pending",
      entryId: "e1",
    });

    expect(result.status).toBe("succeeded");
    expect(acquireExecutionContextMock).toHaveBeenCalledTimes(1);
  });
});
