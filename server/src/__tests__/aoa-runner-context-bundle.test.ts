/**
 * aoa-runner-context-bundle — Phase 4 / Task 4.3 runner-wiring test.
 *
 * Proves the END-TO-END wiring: on a thread-mention run, `runAoaAgent` builds
 * a crew context bundle and passes it into `buildTriggerPrompt`, so the prompt
 * handed to the adapter now CONTAINS the prior thread entries + a `## Context`
 * section — not just `Thread: <id>` (the IDs-only "agents start blind" prompt
 * this phase fixes).
 *
 * `crew-context-bundle.js` is module-mocked here (its internals are exercised
 * in crew-context-bundle.test.ts) so this test asserts ONLY the wiring: the
 * runner calls it with the right args and the returned string reaches the
 * adapter's config.promptTemplate. Mirrors aoa-runner.test.ts's mock set.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const { execMock, createEventMock, buildMcpMock, buildBridgeSpecMock, bundleMock, commitMock, resolveConnectorsMock } = vi.hoisted(() => ({
  execMock: vi.fn().mockResolvedValue({ exitCode: 0 }),
  createEventMock: vi.fn().mockResolvedValue(undefined),
  buildMcpMock: vi.fn(() => ({ mcpServers: {} })),
  buildBridgeSpecMock: vi.fn(() => ({ command: "node", args: ["/x/mcp-bridge.js"], env: {} })),
  bundleMock: vi.fn(),
  commitMock: vi.fn().mockResolvedValue({ committed: 0, suppressed: 0, blocked: 0, failed: 0, lostRace: 0 }),
  // Plan 2 Task 2: the crew connector delivery seam. Default = no connectors so
  // these wiring tests stay byte-identical (they don't exercise connectors). The
  // real loader is unit-tested elsewhere + proven live in the Plan 2 e2e test;
  // mocking it here keeps the sequence-mock DB from being consumed by the new
  // connector queries (the sibling aoa-runner.test.ts mocks it the same way).
  resolveConnectorsMock: vi.fn().mockResolvedValue({ extraMcpServers: {}, connectorEnv: {} }),
}));

// Task 8: the runtime resolver now also looks up the company-level
// `provider:<id>` secret, so these harnesses must model `isNull` + the
// company_secrets tables. The stubbed row that comes back has no
// `status: "active"`, so it is skipped and no key is injected — these tests
// keep asserting exactly what they asserted before.
vi.mock("drizzle-orm", () => ({ and: (...a: unknown[]) => ({ and: a }), eq: (a: unknown, b: unknown) => ({ eq: [a, b] }), isNull: (a: unknown) => ({ isNull: a }) }));
vi.mock("@armyofagents/db", () => {
  const t = (n: string) => new Proxy({}, { get: (_x, p) => (typeof p === "string" ? Symbol(`${n}.${p}`) : undefined) });
  return { agents: t("a"), internalAgentRuns: t("iar"), discussionEntries: t("de"), issues: t("i"), threadOrchestrationState: t("tos"), memoryItems: t("mi"), discussions: t("disc"), discussionExtractedItems: t("dei"), embeddingQueue: t("eq"), memoryItemVersions: t("miv"), memoryRetrievals: t("mr"), suggestions: t("sug"), companySecrets: t("cs"), companySecretVersions: t("csv"), companySecretBindings: t("csb"), companySecretProviderConfigs: t("cspc"), runtimeProviderKeys: t("rpk"), secretAccessEvents: t("sae") };
});
vi.mock("../adapters/registry.js", () => ({ getServerAdapter: () => ({ execute: execMock, getRuntimeCommandSpec: () => ({}) }) }));
vi.mock("../services/costs.js", () => ({ costService: () => ({ createEvent: createEventMock }) }));
// U4b: buildCodexAoaMcpSpec is the brokered-aware selector runner.ts now calls
// for ctx.mcpBridge. This suite exercises the desktop/non-sandbox path
// (acquireExecutionContext mocked to sandbox:null -> brokered:false), where
// buildCodexAoaMcpSpec falls through to plain buildMcpBridgeSpec — so the
// SAME mock produces byte-identical output.
vi.mock("../services/internal-agent/cli-mode.js", () => ({ buildMcpConfig: buildMcpMock, buildMcpBridgeSpec: buildBridgeSpecMock, buildCodexAoaMcpSpec: buildBridgeSpecMock }));
vi.mock("../services/heartbeat.js", () => ({ resolveAdapterExecutionContextUnguarded: () => ({ executionTarget: {}, runtimeCommandSpec: {} }), resolveGuardedAdapterExecutionContext: () => ({ executionTarget: {}, runtimeCommandSpec: {} }), applyEnvironmentAcquisitionConfig: (config: unknown) => config }));
// U4: crew acquires a sandbox lease before buildMcpConfig — stub the desktop/
// local no-sandbox return shape so this suite stays on its existing byte-
// identical local path.
vi.mock("../services/acquire-execution-context.js", () => ({
  acquireExecutionContext: vi.fn().mockResolvedValue({ sandbox: null, lease: null, warmResolved: false }),
}));
vi.mock("../services/internal-agent/aoa-agents/bridge-path.js", () => ({ resolveBridgeEntrypoint: () => "/x/mcp-bridge.js" }));
vi.mock("../services/mcp-connectors-loader.js", () => ({
  resolveAgentConnectors: resolveConnectorsMock,
  loadConnectorEgressHosts: vi.fn().mockResolvedValue([]),
}));
// T1: the runner opens a run transcript before adapter.execute. run-log-store
// imports `node:fs` — a DIFFERENT specifier than the `node:fs/promises` this
// file mocks — so without this an otherwise fully-mocked suite does REAL
// filesystem I/O, writing .ndjson files keyed on fixture ids that repeat across
// test files. vitest runs files in parallel workers and begin() TRUNCATES, so
// that is a latent cross-file flake, not just litter.
// Phase 4: the crew runner routes through the unified provider resolver before
// provider-status detection. A self-hosted miss returns host_login_fallback in
// production (never throws); the proxy-table mock db here can't serve the
// resolver's provider_connections/provider_assignments query, so stub it to a
// passthrough (agent_env_override ⇒ applyResolvedCredential is a no-op). Masks
// no real bug — it only replaces a query the mock DB cannot answer.
vi.mock("../services/provider-resolution.js", () => ({
  resolveProviderCredential: vi.fn(async () => ({ source: "agent_env_override" })),
  applyResolvedCredential: (config: unknown) => config,
  toExecutionTargetHint: () => ({ credentialKind: null, executionTargetSlug: null }),
}));

vi.mock("../services/run-log-store.js", () => ({
  getRunLogStore: () => ({
    begin: async () => ({ store: "local_file", logRef: "test-run.ndjson" }),
    append: async () => {},
    finalize: async () => ({ bytes: 0, compressed: false }),
    read: async () => ({ content: "" }),
  }),
}));
// T5: the runner now resolves an execution workspace before adapter.execute,
// which mkdir's the per-agent home and stat's candidate cwds through this same
// mocked module. `workspace-resolution.ts` imports the DEFAULT export, the
// runner the named writeFile/unlink — provide both shapes.
vi.mock("node:fs/promises", () => {
  const api = {
    writeFile: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
  };
  return { ...api, default: api };
});
vi.mock("../middleware/logger.js", () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } }));
// T5: crew workspace resolution reads the instance experimental flags. Without
// this stub the access THROWS and the resolver's tolerant catch absorbs it —
// the suite would then only ever exercise the failure branch, and the fs/table
// stubs above would be dead.
vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: vi.fn(() => ({
    getExperimental: vi.fn().mockResolvedValue({ enableIsolatedWorkspaces: true }),
  })),
}));

vi.mock("../services/thread-agent-actions.js", () => ({
  threadAgentActionService: () => ({
    commitThreadAgentActions: commitMock,
  }),
}));

// The crew context bundle — module-mocked. Its internals are tested separately.
vi.mock("../services/internal-agent/aoa-agents/crew-context-bundle.js", () => ({
  buildCrewContextBundle: bundleMock,
}));

import { runAoaAgent } from "../services/internal-agent/aoa-agents/runner.js";
import { threadOrchestrationState } from "@armyofagents/db";

// Thenable chain stub (mirrors aoa-runner.test.ts).
function ch(ret: unknown[]) {
  const c: any = {};
  c.values = () => c; c.set = () => c; c.where = () => c; c.from = () => c;
  c.returning = () => Promise.resolve(ret);
  c.then = (r: (v: unknown[]) => unknown) => Promise.resolve(ret).then(r);
  return c;
}

describe("runAoaAgent — context bundle wiring (Task 4.3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bundleMock.mockReset();
    execMock.mockClear();
    execMock.mockResolvedValue({ exitCode: 0 });
  });

  it("thread-mention run: prompt sent to the adapter CONTAINS the prior entries + a ## Context section (not just 'Thread: <id>')", async () => {
    // The bundle the runner will inject (a rendered conversation).
    bundleMock.mockResolvedValue(
      "Recent conversation:\nfounder: we need a precedent for enterprise auth\nScout: SAML 2.0 is our standard",
    );

    const db: any = {
      select: () => ch([{ id: "scout-1", companyId: "co-1", name: "Scout", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: { aoa: { instruction: "## Persona\nScout.", role: "scout" } } }]),
      insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: "run-ctx" }]) }) }),
      update: () => ch([{ id: "x" }]),
    };

    await runAoaAgent(db, "scout-1", {
      companyId: "co-1",
      source: "thread.participation",
      threadId: "thread-77",
      mention: "@Scout what precedent applies?",
      effectiveAutonomy: 1,
    });

    // The bundle builder was called with the run's thread context.
    expect(bundleMock).toHaveBeenCalledTimes(1);
    const bundleArgs = bundleMock.mock.calls[0][1];
    expect(bundleArgs).toMatchObject({ companyId: "co-1", threadId: "thread-77", agentId: "scout-1" });

    // The adapter received the bundle inside its prompt.
    const execArg = execMock.mock.calls[0][0];
    const prompt = String(execArg.config.promptTemplate);
    expect(prompt).toContain("## Context");
    expect(prompt).toContain("founder: we need a precedent for enterprise auth");
    expect(prompt).toContain("Scout: SAML 2.0 is our standard");
    // The IDs-only line is still present, but it is no longer ALL the agent gets.
    expect(prompt).toContain("Thread: thread-77");
  });

  it("task run: passes issueId into the bundle builder", async () => {
    bundleMock.mockResolvedValue("Task: Build the SSO form\nUpstream deliverable:\n# Spec");

    const db: any = {
      select: () => ch([{ id: "eng-1", companyId: "co-1", name: "Engineer", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: { aoa: { instruction: "## Persona\nEngineer.", role: "engineer" } } }]),
      insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: "run-task" }]) }) }),
      // checkout + getById both go through issueService — mocked below so the
      // task-claim path is satisfied without a real service.
      update: () => ch([{ id: "x" }]),
    };

    // Stub issueService so checkout()/getById() don't hit a real db. The runner
    // imports it dynamically inside the issueId branches.
    vi.doMock("../services/issues.js", () => ({
      issueService: () => ({
        checkout: vi.fn().mockResolvedValue(undefined),
        // After execute, the silent-stuck guard reads the task; return a moved
        // task (status not in_progress) so it does NOT throw.
        getById: vi.fn().mockResolvedValue({ id: "task-9", status: "done", executionRunId: null }),
      }),
    }));

    await runAoaAgent(db, "eng-1", {
      companyId: "co-1",
      source: "dispatcher.task",
      issueId: "task-9",
      effectiveAutonomy: 2,
    });

    expect(bundleMock).toHaveBeenCalledTimes(1);
    const bundleArgs = bundleMock.mock.calls[0][1];
    expect(bundleArgs).toMatchObject({ companyId: "co-1", issueId: "task-9", agentId: "eng-1" });

    const execArg = execMock.mock.calls[0][0];
    const prompt = String(execArg.config.promptTemplate);
    expect(prompt).toContain("## Context");
    expect(prompt).toContain("Build the SSO form");
  });

  it("bundle builder throwing NEVER breaks the run (best-effort; prompt still sent without ## Context)", async () => {
    bundleMock.mockRejectedValue(new Error("bundle exploded"));

    const db: any = {
      select: () => ch([{ id: "scout-1", companyId: "co-1", name: "Scout", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: { aoa: { instruction: "## Persona\nScout.", role: "scout" } } }]),
      insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: "run-x" }]) }) }),
      update: () => ch([{ id: "x" }]),
    };

    const result = await runAoaAgent(db, "scout-1", {
      companyId: "co-1",
      source: "thread.participation",
      threadId: "thread-88",
      mention: "@Scout",
      effectiveAutonomy: 1,
    });

    // Run still completed (bundle failure swallowed).
    expect(result.status).not.toBe("failed");
    // Adapter still ran, prompt still sent — just no Context section.
    const execArg = execMock.mock.calls[0][0];
    const prompt = String(execArg.config.promptTemplate);
    expect(prompt).toContain("Thread: thread-88");
    expect(prompt).not.toContain("## Context");
  });

  // Codex round-8: the direct/mention self-flush must re-arm the controller when it leaves retryable
  // rows, like every other commit path (controller reschedule / reaper / GC re-seal) — else a mixed
  // flush strands `failed`/lost-race rows until an unrelated future human entry.
  it("direct self-flush re-arms pendingRun when the flush leaves retryable rows", async () => {
    bundleMock.mockResolvedValue("ctx");
    // One action commits, another transiently fails (or loses the CAS) — retryable work is left behind.
    commitMock.mockResolvedValueOnce({ committed: 1, suppressed: 0, blocked: 0, failed: 1, lostRace: 0 });

    const updateTables: unknown[] = [];
    const db: any = {
      select: () => ch([{ id: "scout-1", companyId: "co-1", name: "Scout", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: { aoa: { instruction: "## Persona\nScout.", role: "scout" } } }]),
      insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: "run-rearm" }]) }) }),
      update: (table: unknown) => { updateTables.push(table); return ch([{ id: "x" }]); },
    };

    await runAoaAgent(db, "scout-1", {
      companyId: "co-1",
      source: "thread.participation",
      threadId: "thread-rearm",
      mention: "@Scout",
      effectiveAutonomy: 1,
    });

    expect(updateTables).toContain(threadOrchestrationState); // re-armed for the next sweep
  });

  it("direct self-flush does NOT re-arm when the flush left no retryable rows", async () => {
    bundleMock.mockResolvedValue("ctx");
    // Default commitMock returns failed:0, lostRace:0 — a clean flush, nothing to re-drive.

    const updateTables: unknown[] = [];
    const db: any = {
      select: () => ch([{ id: "scout-1", companyId: "co-1", name: "Scout", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: { aoa: { instruction: "## Persona\nScout.", role: "scout" } } }]),
      insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: "run-clean" }]) }) }),
      update: (table: unknown) => { updateTables.push(table); return ch([{ id: "x" }]); },
    };

    await runAoaAgent(db, "scout-1", {
      companyId: "co-1",
      source: "thread.participation",
      threadId: "thread-clean",
      mention: "@Scout",
      effectiveAutonomy: 1,
    });

    expect(updateTables).not.toContain(threadOrchestrationState); // clean flush → no spurious re-arm
  });
});
