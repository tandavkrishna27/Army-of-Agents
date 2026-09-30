// server/src/__tests__/crew-seam-suppression.test.ts — MIG-006 slice 1.
//
// The crew distributed-execution seam in runAoaAgent: the durable handoff marker (PURE) and the
// STRUCTURAL shape of the suppression seam — the one place a double-execution defect could live.
// The full behavioral proof (flag-on suppresses adapter.execute; flag-off/port-absent still run
// it) lands as a fast-follow (slice 1b) BEFORE the off-by-default crew flag is ever armed, so the
// runtime-proof gap is never a production risk.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildCrewHandoffMarkerPatch } from "../services/internal-agent/aoa-agents/crew-handoff-marker.js";

describe("buildCrewHandoffMarkerPatch — MIG-006 durable crew handoff marker", () => {
  const distributed = { owner: "distributed", jobId: "job-1", attemptId: "att-1" } as const;

  it("emits exactly the three marker columns internal_agent_runs has — NO updatedAt", () => {
    // heartbeat_runs' buildHandoffRunPatch also emits updatedAt; internal_agent_runs has no such
    // column, so a naive reuse would throw at runtime on an unknown column.
    expect(buildCrewHandoffMarkerPatch(distributed, new Date())).toEqual({
      executionOwner: "distributed",
      distributedJobId: "job-1",
      distributedAttemptId: "att-1",
    });
  });

  it("THROWS on a legacy owner (a marker for a legacy run would strand it — reaper stands down)", () => {
    expect(() =>
      buildCrewHandoffMarkerPatch({ owner: "legacy", reason: "rollout_not_canary" }, new Date()),
    ).toThrow();
  });

  it("never latches status (the attempt is the terminal authority from handoff on)", () => {
    expect(buildCrewHandoffMarkerPatch(distributed, new Date())).not.toHaveProperty("status");
  });
});

const RUNNER = readFileSync(
  path.join(
    fileURLToPath(new URL(".", import.meta.url)),
    "..",
    "services",
    "internal-agent",
    "aoa-agents",
    "runner.ts",
  ),
  "utf8",
);

describe("runAoaAgent crew distributed seam — structural (MIG-006 slice 1)", () => {
  it("reads the rollout hook lazily via the process-wide port (never captured at module scope)", () => {
    expect(RUNNER).toContain("getDistributedRolloutPort()");
  });

  it("builds the crew batch workload and gates it through the crew-flag-first gate", () => {
    expect(RUNNER).toContain("buildTaskRunBatchWorkload(");
    expect(RUNNER).toContain("resolveCrewDistributedGate(");
  });

  it("resolves the single ownership decision with a crew_run source", () => {
    expect(RUNNER).toMatch(/resolveExecutionOwner\(/);
    expect(RUNNER).toMatch(/kind:\s*"crew_run"/);
  });

  it("suppresses the legacy adapter with exactly ONE CREW-SUPPRESSION-RETURN, before adapter.execute", () => {
    const occurrences = RUNNER.split("CREW-SUPPRESSION-RETURN").length - 1;
    expect(occurrences).toBe(1);
    expect(RUNNER).toContain("shouldSuppressLegacyExecution(");
    // The suppression return must sit before the legacy executor, or it suppresses nothing.
    expect(RUNNER.indexOf("CREW-SUPPRESSION-RETURN")).toBeGreaterThan(0);
    expect(RUNNER.indexOf("CREW-SUPPRESSION-RETURN")).toBeLessThan(RUNNER.indexOf("adapter.execute("));
  });

  it("writes the durable marker via buildCrewHandoffMarkerPatch on suppression", () => {
    expect(RUNNER).toContain("buildCrewHandoffMarkerPatch(");
  });
});

// ============================================================================
// MIG-006 slice 1b — BEHAVIORAL suppression proof. APPEND to
// server/src/__tests__/crew-seam-suppression.test.ts. That file today holds ONLY
// the PURE buildCrewHandoffMarkerPatch tests + the STRUCTURAL runner.ts-source
// tests and has NO vi.mock / vi.hoisted, so EVERYTHING below is a net-new addition
// (nothing to replace). The existing top-of-file vitest import was WIDENED in place
// to add afterEach/beforeEach/vi (this block declares no second vitest import — a
// duplicate would be redundant). vitest hoists every vi.mock/vi.hoisted above all
// imports, and ES
// imports hoist too, so appending at the END of the file is safe.
//
// The PURE + STRUCTURAL describes are UNAFFECTED: crew-handoff-marker.js imports no
// VALUE from @armyofagents/db, and the structural test reads runner.ts via node:fs
// `readFileSync` — a different specifier from the mocked node:fs/promises.
// ============================================================================
import { internalAgentRuns } from "@armyofagents/db";
import type { HeartbeatDistributedRolloutHook } from "../services/heartbeat-distributed-rollout.js";
// The REAL process-wide port (cleaner than mocking the module): the runner reads it
// LAZILY via getDistributedRolloutPort(), so registering the fake hook here IS what
// the seam sees. Cleared in afterEach so no arm's hook leaks into the next test/file.
import { setDistributedRolloutPort } from "../services/distributed-rollout-port.js";

const {
  execMock,
  createEventMock,
  writeFileMock,
  unlinkMock,
  resolveConnectorsMock,
  loadEgressMock,
  runLogStoreMock,
  acquireExecutionContextMock,
  releaseRunLeaseMock,
  checkoutMock,
  getIssueByIdMock,
  resolveWorkspaceMock,
  fakeTurnMock,
  buildContextBundleMock,
  postCrewRunSuccessMock,
  postCrewRunFailureMock,
} = vi.hoisted(() => ({
  execMock: vi.fn().mockResolvedValue({ exitCode: 0 }),
  createEventMock: vi.fn().mockResolvedValue(undefined),
  writeFileMock: vi.fn().mockResolvedValue(undefined),
  unlinkMock: vi.fn().mockResolvedValue(undefined),
  resolveConnectorsMock: vi.fn().mockResolvedValue({ extraMcpServers: {}, connectorEnv: {} }),
  loadEgressMock: vi.fn().mockResolvedValue([]),
  runLogStoreMock: {
    begin: vi.fn().mockResolvedValue({ store: "local_file", logRef: "co-1/a-1/run-1.ndjson" }),
    append: vi.fn().mockResolvedValue(undefined),
    finalize: vi.fn().mockResolvedValue({ bytes: 0, compressed: false }),
    read: vi.fn(),
  },
  acquireExecutionContextMock: vi.fn().mockResolvedValue({ sandbox: null, lease: null, warmResolved: false }),
  releaseRunLeaseMock: vi.fn().mockResolvedValue(null),
  // issueId path (BEFORE the seam): task checkout (runner.ts:320). RESOLVE so the run
  // reaches the seam — a throw benign-skips before it.
  checkoutMock: vi.fn().mockResolvedValue(undefined),
  // issueId path (AFTER execute): getById -> null keeps the post-execute task-advance
  // block (arms B/C, runner.ts:1326) a no-op, so no db.update(issues) ever throws.
  getIssueByIdMock: vi.fn().mockResolvedValue(null),
  // issueId path: real resolveCrewExecutionWorkspace (runner.ts:1095) runs a mock-DB
  // read + mkdir for a NON-NULL issueId — a case the entryId siblings never exercise.
  resolveWorkspaceMock: vi.fn().mockResolvedValue({ warnings: [], workspace: null, workspaceHints: undefined }),
  // null == "run the real adapter" (runner.ts:992). A non-null return SHORT-CIRCUITS
  // adapter.execute and would break arms B/C's execMock===1.
  fakeTurnMock: vi.fn().mockResolvedValue(null),
  buildContextBundleMock: vi.fn().mockResolvedValue(""),
  postCrewRunSuccessMock: vi.fn().mockResolvedValue(undefined),
  postCrewRunFailureMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ and: a }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  sql: Object.assign((...a: unknown[]) => ({ sql: a }), { raw: (s: unknown) => ({ raw: s }) }),
  isNull: (a: unknown) => ({ isNull: a }),
  desc: (a: unknown) => ({ desc: a }),
  ne: (a: unknown, b: unknown) => ({ ne: [a, b] }),
}));
vi.mock("@armyofagents/db", () => {
  const t = (n: string) => new Proxy({}, { get: (_x, p) => (typeof p === "string" ? Symbol(`${n}.${p}`) : undefined) });
  return {
    agents: t("agents"),
    internalAgentRuns: t("internal_agent_runs"),
    discussionEntries: t("de"),
    issues: t("issues"),
    threadOrchestrationState: t("tos"),
    workQuestions: t("wq"),
    memoryItems: t("mi"),
    discussions: t("disc"),
    discussionExtractedItems: t("dei"),
    embeddingQueue: t("eq"),
    memoryItemVersions: t("miv"),
    memoryRetrievals: t("mr"),
    suggestions: t("sug"),
    companySecrets: t("cs"),
    companySecretVersions: t("csv"),
    companySecretBindings: t("csb"),
    companySecretProviderConfigs: t("cspc"),
    runtimeProviderKeys: t("rpk"),
    secretAccessEvents: t("sae"),
  };
});
vi.mock("../adapters/registry.js", () => ({
  // The mocked adapter deliberately has NO `supportsLocalAgentJwt` — so runner.ts:1230
  // sets crewAuthToken=null and createLocalAgentJwt is NEVER called (no signing key
  // needed). getRuntimeCommandSpec is unused by the seam (it reads runtimeCommandSpec
  // from the heartbeat mock below); present for shape-completeness only.
  getServerAdapter: () => ({ execute: execMock, getRuntimeCommandSpec: () => ({}) }),
}));
vi.mock("../services/costs.js", () => ({ costService: () => ({ createEvent: createEventMock }) }));
vi.mock("../services/internal-agent/cli-mode.js", () => ({
  buildMcpConfig: vi.fn(() => ({ mcpServers: {} })),
  buildMcpBridgeSpec: vi.fn(() => ({ command: "node", args: ["/bridge.js"], env: {} })),
  buildCodexAoaMcpSpec: vi.fn(() => ({ command: "node", args: ["/bridge.js"], env: {} })),
}));
// ★ THE ONE DELTA vs the sibling scaffolding that makes the seam FIRE: a NON-EMPTY
// runtimeCommandSpec.command. The seam reads runtimeCommandSpec HERE (runner.ts:829)
// and hands it to the REAL buildTaskRunBatchWorkload -> readCommand. The lease-release
// / brokered mocks return `{}`, which yields `no_runtime_command_spec` -> gate
// `workload_unavailable` -> the seam suppresses NOTHING and adapter.execute RUNS (arm A
// would pass VACUOUSLY). "claude" is a valid command string.
vi.mock("../services/heartbeat.js", () => ({
  resolveAdapterExecutionContextUnguarded: () => ({ executionTarget: {}, runtimeCommandSpec: { command: "claude" } }),
  resolveGuardedAdapterExecutionContext: () => ({ executionTarget: {}, runtimeCommandSpec: { command: "claude" } }),
  applyEnvironmentAcquisitionConfig: (config: unknown) => config,
}));
vi.mock("../services/acquire-execution-context.js", () => ({ acquireExecutionContext: acquireExecutionContextMock }));
vi.mock("../services/environment-runtime.js", () => ({
  environmentRuntimeService: () => ({ releaseRunLease: releaseRunLeaseMock }),
  // one-shot-sandbox-cli chain imports this off the same module; expose it or the
  // module-load export check fails.
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
  loadConnectorEgressHosts: loadEgressMock,
}));
vi.mock("../services/run-log-store.js", () => ({ getRunLogStore: () => runLogStoreMock }));
vi.mock("../middleware/logger.js", () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } }));
vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: vi.fn(() => ({ getExperimental: vi.fn().mockResolvedValue({ enableIsolatedWorkspaces: true }) })),
}));
vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
  publishIssueStatusChanged: vi.fn(),
  threadWorkingAgents: { add: vi.fn(), remove: vi.fn(() => []), list: vi.fn(() => []) },
  broadcastThreadPresence: vi.fn(),
}));
vi.mock("../services/issues.js", () => ({
  issueService: () => ({ checkout: checkoutMock, getById: getIssueByIdMock }),
}));
// issueId-triggered collaborators. crew-context-bundle (runner.ts:516) -> "" avoids
// memory/pgvector IO; crew-workspace (runner.ts:1095) -> benign shape avoids real
// workspace resolution on a mock DB with a NON-NULL issueId; fake-crew-llm
// (runner.ts:992) -> null so the REAL adapter is the executor for arms B/C.
vi.mock("../services/internal-agent/aoa-agents/crew-context-bundle.js", () => ({ buildCrewContextBundle: buildContextBundleMock }));
vi.mock("../services/internal-agent/aoa-agents/crew-workspace.js", () => ({ resolveCrewExecutionWorkspace: resolveWorkspaceMock }));
vi.mock("../services/internal-agent/aoa-agents/fake-crew-llm.js", () => ({ maybeExecuteFakeCrewTurn: fakeTurnMock }));
// The W3a crew loopback (runner.ts:1576/1749). Already try/caught in the runner, so it
// can never fail the run — mocking just removes real DB churn and keeps B/C deterministic.
vi.mock("../services/internal-agent/aoa-agents/crew-run-outcome.js", () => ({
  postCrewRunSuccess: postCrewRunSuccessMock,
  postCrewRunFailure: postCrewRunFailureMock,
  resolveCrewOutcomeKind: (s: string) => (s === "succeeded" ? "success" : "failure"),
}));

import { runAoaAgent } from "../services/internal-agent/aoa-agents/runner.js";

// ── fixtures ────────────────────────────────────────────────────────────────
const COMPANY_ID = "co-1";
const AGENT_ID = "a-1";
const RUN_ID = "run-1";
const ISSUE_ID = "issue-1";
const ORG_ID = "org-1";
const DIST_JOB_ID = "job-9";
const DIST_ATTEMPT_ID = "att-9";
const CREW_FLAG = "AOA_DISTRIBUTED_CREW_ROLLOUT_ENABLED";
const TASK_PAYLOAD = { companyId: COMPANY_ID, source: "wakeup", issueId: ISSUE_ID } as const;

// The fake rollout hook, registered via the REAL setDistributedRolloutPort. Only the two
// methods the crew seam calls carry behavior; convertActiveRun/runShadowComparison are
// never reached by the crew seam and are inert stubs. Separate handles so a test can
// assert/clear them.
const resolveRunRolloutStateMock = vi.fn(async () => ({ state: "canary", organizationId: ORG_ID }));
const resolveExecutionOwnerMock = vi.fn(async () => ({ owner: "distributed", jobId: DIST_JOB_ID, attemptId: DIST_ATTEMPT_ID }));
const fakeHook = {
  resolveRunRolloutState: resolveRunRolloutStateMock,
  resolveExecutionOwner: resolveExecutionOwnerMock,
  convertActiveRun: vi.fn(async () => ({ converted: false })),
  runShadowComparison: vi.fn(),
} as unknown as HeartbeatDistributedRolloutHook;

// A fresh recording DB per test. Every db.update(table).set(patch) is captured so the
// marker write can be asserted by its PAYLOAD (executionOwner:"distributed") AND its
// TABLE identity (=== internalAgentRuns), not merely by execMock counts.
function makeDb() {
  const updates: Array<{ table: unknown; patch: unknown }> = [];
  const agentRow = {
    id: AGENT_ID,
    companyId: COMPANY_ID,
    name: "Scribe",
    adapterType: "claude_local", // v1 sandboxed-coding disposition -> buildTaskRunBatchWorkload admits it
    adapterConfig: {},
    runtimeConfig: { aoa: { instruction: "Do the crew task.", role: "scribe" } },
  };
  const select = () => {
    const c: any = {};
    c.from = () => c;
    c.where = () => c;
    c.orderBy = () => c;
    c.limit = () => c;
    c.then = (resolve: (v: unknown[]) => unknown) => Promise.resolve([agentRow]).then(resolve);
    return c;
  };
  const db = {
    select: () => select(),
    insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: RUN_ID }]) }) }),
    update: (table: unknown) => {
      const c: any = {};
      c.set = (patch: unknown) => { updates.push({ table, patch }); return c; };
      c.where = () => c;
      c.returning = () => Promise.resolve([{ id: RUN_ID, status: "running", errorMessage: null }]);
      c.then = (resolve: (v: unknown[]) => unknown) => Promise.resolve([{ id: RUN_ID }]).then(resolve);
      return c;
    },
  };
  return { db, updates };
}

const markerWrites = (updates: Array<{ table: unknown; patch: unknown }>) =>
  updates.filter((u) => (u.patch as { executionOwner?: unknown })?.executionOwner === "distributed");

describe("runAoaAgent crew distributed seam — BEHAVIORAL (MIG-006 slice 1b)", () => {
  let savedFlag: string | undefined;

  beforeEach(() => {
    execMock.mockClear().mockResolvedValue({ exitCode: 0 });
    writeFileMock.mockClear().mockResolvedValue(undefined);
    unlinkMock.mockClear().mockResolvedValue(undefined);
    createEventMock.mockClear().mockResolvedValue(undefined);
    resolveRunRolloutStateMock.mockClear();
    resolveExecutionOwnerMock.mockClear();
    savedFlag = process.env[CREW_FLAG];
    delete process.env[CREW_FLAG]; // default OFF; each arm opts in explicitly
  });

  afterEach(() => {
    setDistributedRolloutPort(undefined); // never leak a hook into the next test/file
    if (savedFlag === undefined) delete process.env[CREW_FLAG];
    else process.env[CREW_FLAG] = savedFlag;
  });

  it("A — flag ON + canary + distributed owner: adapter.execute SUPPRESSED, durable marker written (no status), distributedHandoff returned, and the finally still runs", async () => {
    setDistributedRolloutPort(fakeHook);
    process.env[CREW_FLAG] = "true";

    const { db, updates } = makeDb();
    const result = await runAoaAgent(db as never, AGENT_ID, TASK_PAYLOAD);

    // The seam genuinely OPENED (rules out a vacuous "execMock 0 because the run failed
    // earlier"): the crew rollout resolved for the crew sink, and the ownership decision
    // was requested with the BUILT workload + its staged prompt file — which only exist
    // if buildTaskRunBatchWorkload returned ok AND the gate said attempt.
    expect(resolveRunRolloutStateMock).toHaveBeenCalledWith({ companyId: COMPANY_ID, sourceKind: "crew_run" });
    expect(resolveExecutionOwnerMock).toHaveBeenCalledTimes(1);
    const ownerInput = resolveExecutionOwnerMock.mock.calls[0][0] as {
      organizationId: string;
      idempotencyKey: string;
      rolloutState: string;
      source: unknown;
      input?: { command?: unknown };
      stagedFiles?: ReadonlyArray<{ path: string }>;
    };
    expect(ownerInput.organizationId).toBe(ORG_ID);
    expect(ownerInput.idempotencyKey).toBe(RUN_ID);
    expect(ownerInput.rolloutState).toBe("canary");
    expect(ownerInput.source).toEqual({ kind: "crew_run", crewRunId: RUN_ID });
    // The workload genuinely built: the sandbox-invocation command ("sh") + the staged
    // prompt path. THIS is the direct refutation of the workload_unavailable vacuity.
    expect(ownerInput.input?.command).toBe("sh");
    expect(ownerInput.stagedFiles).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: expect.stringContaining(".aoa-run-prompt.md") })]),
    );

    // 1. Legacy execution SUPPRESSED.
    expect(execMock).not.toHaveBeenCalled();

    // 2. The durable handoff marker fired exactly once, on internal_agent_runs, carrying
    //    exactly the three handoff columns and NOT latching status (the crew invariant).
    const marks = markerWrites(updates);
    expect(marks).toHaveLength(1);
    expect(marks[0].patch).toEqual({
      executionOwner: "distributed",
      distributedJobId: DIST_JOB_ID,
      distributedAttemptId: DIST_ATTEMPT_ID,
    });
    expect(marks[0].patch).not.toHaveProperty("status");
    expect(marks[0].table).toBe(internalAgentRuns);

    // 3. The CREW-SUPPRESSION-RETURN carries the handoff (the slice-2 dispatcher signal).
    expect(result.status).toBe("succeeded");
    expect(result.distributedHandoff).toEqual({ jobId: DIST_JOB_ID, attemptId: DIST_ATTEMPT_ID });

    // 4. The finally STILL ran: cfgPath (written before the seam, runner.ts:803) was
    //    unlinked (runner.ts:1927) — only possible if CREW-SUPPRESSION-RETURN sits INSIDE
    //    the main try.
    expect(writeFileMock).toHaveBeenCalled();
    expect(unlinkMock).toHaveBeenCalledTimes(1);
    expect(String(unlinkMock.mock.calls[0][0])).toMatch(/aoa-mcp-a-1-.*\.json$/);
  });

  it("B — flag OFF (env unset), otherwise identical to A: adapter.execute runs once, NO marker, hook never consulted (anti-vacuity control)", async () => {
    setDistributedRolloutPort(fakeHook); // hook PRESENT — the flag is the ONLY difference from A
    delete process.env[CREW_FLAG];

    const { db, updates } = makeDb();
    const result = await runAoaAgent(db as never, AGENT_ID, TASK_PAYLOAD);

    // Flag-first gate short-circuits BEFORE the hook is read (runner.ts:848) — proving the
    // flag, not an upstream failure, kept it legacy.
    expect(resolveRunRolloutStateMock).not.toHaveBeenCalled();
    expect(resolveExecutionOwnerMock).not.toHaveBeenCalled();

    expect(execMock).toHaveBeenCalledTimes(1);
    expect(markerWrites(updates)).toHaveLength(0);
    expect(result.status).toBe("succeeded");
    expect(result.distributedHandoff).toBeUndefined();
  });

  it("C — port ABSENT + flag ON: adapter.execute runs, NO marker (flag-on with distributed execution off is byte-identical legacy)", async () => {
    setDistributedRolloutPort(undefined); // the ONLY difference from A
    process.env[CREW_FLAG] = "true";

    const { db, updates } = makeDb();
    const result = await runAoaAgent(db as never, AGENT_ID, TASK_PAYLOAD);

    expect(resolveRunRolloutStateMock).not.toHaveBeenCalled();
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(markerWrites(updates)).toHaveLength(0);
    expect(result.status).toBe("succeeded");
    expect(result.distributedHandoff).toBeUndefined();
  });
});
