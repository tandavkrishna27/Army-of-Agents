// T5 — crew execution-workspace resolution (Decision #110, clause 7).
//
// THE DEFECT THIS GUARDS. The crew runner never set a workspace on the
// execution context, so `claude-local/src/server/execute.ts:188`
//
//     const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
//
// fell all the way through to `process.cwd()` — the AoA SERVER'S OWN
// REPOSITORY. Every crew run therefore executed inside this codebase and picked
// up AoA's own CLAUDE.md (this project's development instructions) as agent
// context. D16's tier two ("the workspace repo's own CLAUDE.md is allowed") was
// satisfied by accident, by the wrong repo.
//
// The runner now mirrors heartbeat's resolution: `context.paperclipWorkspace`
// is ALWAYS populated, with the per-agent home
// (<AOA_HOME>/instances/<id>/workspaces/<agentId>) as the floor. `process.cwd()`
// must never again be reachable for a crew run — that is what test (b) asserts.
//
// Harness: proxy-table + hoisted-mock db, modelled on
// aoa-runner-task-execution.test.ts — it drives `runAoaAgent` for real, so this
// is wiring proof (L2), not just a unit test of the helper.

import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

const {
  writeFileMock,
  unlinkMock,
  mkdirMock,
  statMock,
  adapterExecute,
  createEventMock,
  buildMcpMock,
  buildBridgeSpecMock,
  checkoutMock,
  getByIdMock,
  getExperimentalMock,
  warnMock,
  infoMock,
  loggerMock,
} = vi.hoisted(() => {
  const warn = vi.fn();
  const info = vi.fn();
  // `.child()` returns THIS object, not a fresh one — otherwise the runner's
  // child logger is unreachable from the test and the discriminator below
  // cannot be asserted.
  const logger: Record<string, unknown> = { info, warn, error: vi.fn(), debug: vi.fn() };
  logger.child = () => logger;
  return {
  warnMock: warn,
  infoMock: info,
  loggerMock: logger,
  writeFileMock: vi.fn().mockResolvedValue(undefined),
  unlinkMock: vi.fn().mockResolvedValue(undefined),
  mkdirMock: vi.fn().mockResolvedValue(undefined),
  // Default: every candidate path "exists" as a directory. Individual tests
  // override to model a project cwd that is not on disk yet.
  statMock: vi.fn().mockResolvedValue({ isDirectory: () => true }),
  adapterExecute: vi.fn().mockResolvedValue({ exitCode: 0 }),
  createEventMock: vi.fn().mockResolvedValue(undefined),
  buildMcpMock: vi.fn(() => ({})),
  buildBridgeSpecMock: vi.fn(() => ({
    command: "node",
    args: ["/bridge.js"],
    env: { AOA_SESSION_COMPANY_ID: "c" },
  })),
  checkoutMock: vi.fn().mockResolvedValue({ id: "TASK-1", status: "in_progress" }),
  getByIdMock: vi.fn().mockResolvedValue({ id: "TASK-1", status: "in_review", executionRunId: "run-1" }),
  getExperimentalMock: vi.fn().mockResolvedValue({ enableIsolatedWorkspaces: true }),
  };
});

// `workspace-resolution.ts` uses the DEFAULT export (`import fs from
// "node:fs/promises"`); the runner uses named writeFile/unlink. Provide both.
vi.mock("node:fs/promises", () => {
  const api = { writeFile: writeFileMock, unlink: unlinkMock, mkdir: mkdirMock, stat: statMock };
  return { ...api, default: api };
});

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...a: unknown[]) => ({ and: a })),
  asc: vi.fn((a: unknown) => ({ asc: a })),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...vals: unknown[]) => ({ sql: strings.join("?"), vals }),
    {},
  ),
}));

vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) =>
    new Proxy({} as Record<string, unknown>, {
      get(_t, prop) {
        if (prop === "_") return { name };
        if (prop === "$inferSelect" || prop === "$inferInsert") return {};
        if (typeof prop === "string") return Symbol(`${name}.${prop}`);
        return undefined;
      },
    });
  return {
    agents: makeTable("agents"),
    internalAgentRuns: makeTable("internal_agent_runs"),
    discussionEntries: makeTable("discussion_entries"),
    issues: makeTable("issues"),
    projects: makeTable("projects"),
    projectWorkspaces: makeTable("project_workspaces"),
    workQuestions: makeTable("work_questions"),
    // Reached transitively via services/memory.ts — same set the task-execution
    // suite has to declare.
    memoryItems: makeTable("memory_items"),
    discussions: makeTable("discussions"),
    discussionExtractedItems: makeTable("discussion_extracted_items"),
    embeddingQueue: makeTable("embedding_queue"),
    memoryItemVersions: makeTable("memory_item_versions"),
    memoryRetrievals: makeTable("memory_retrievals"),
    suggestions: makeTable("suggestions"),
  };
});

vi.mock("../adapters/registry.js", () => ({
  getServerAdapter: vi.fn(() => ({ execute: adapterExecute })),
}));

vi.mock("../services/internal-agent/cli-mode.js", () => ({
  buildMcpConfig: buildMcpMock,
  buildMcpBridgeSpec: buildBridgeSpecMock,
  // U4b: buildCodexAoaMcpSpec is the brokered-aware selector runner.ts now
  // calls for ctx.mcpBridge. This suite exercises the desktop/non-sandbox
  // path (acquireExecutionContext mocked to sandbox:null -> brokered:false),
  // where buildCodexAoaMcpSpec falls through to plain buildMcpBridgeSpec — so
  // the SAME mock produces byte-identical output.
  buildCodexAoaMcpSpec: buildBridgeSpecMock,
}));

vi.mock("../services/heartbeat.js", () => ({
  resolveAdapterExecutionContextUnguarded: vi.fn(() => ({ executionTarget: {}, runtimeCommandSpec: {} })),
  resolveGuardedAdapterExecutionContext: vi.fn(() => ({ executionTarget: {}, runtimeCommandSpec: {} })),
  applyEnvironmentAcquisitionConfig: (config: unknown) => config,
}));

// U4: crew acquires a sandbox lease before buildMcpConfig — stub the desktop/
// local no-sandbox return shape so this suite stays on its existing byte-
// identical local path.
vi.mock("../services/acquire-execution-context.js", () => ({
  acquireExecutionContext: vi.fn().mockResolvedValue({ sandbox: null, lease: null, warmResolved: false }),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: vi.fn(() => ({ getExperimental: getExperimentalMock })),
}));

vi.mock("../services/internal-agent/aoa-agents/bridge-path.js", () => ({
  resolveBridgeEntrypoint: vi.fn(() => "/bridge"),
}));

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

vi.mock("../services/costs.js", () => ({
  costService: vi.fn(() => ({ createEvent: createEventMock })),
}));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
  publishIssueStatusChanged: vi.fn(),
  threadWorkingAgents: { add: vi.fn(), remove: vi.fn(() => []), list: vi.fn(() => []) },
  broadcastThreadPresence: vi.fn(),
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => ({ checkout: checkoutMock, getById: getByIdMock }),
}));

// ONE logger object, reused for every `.child()` call, so the runner's child
// logger is INSPECTABLE. Blocking review finding #1: the regression guard below
// asserts `cwd === AGENT_HOME` + `source === "agent_home"`, which is exactly
// what the resolver's tolerant CATCH also returns — so without a discriminator
// the guard would still pass if the entire happy path started throwing. The
// warn line is that discriminator: only the catch emits it.
vi.mock("../middleware/logger.js", () => ({ logger: loggerMock }));

import { runAoaAgent } from "../services/internal-agent/aoa-agents/runner.js";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";

const AGENT_ID = "a-1";
const AGENT_HOME = resolveDefaultAgentWorkspaceDir(AGENT_ID);

const AGENT_ROW = {
  id: AGENT_ID,
  companyId: "co-1",
  name: "Scout",
  adapterType: "process",
  runtimeConfig: { aoa: { role: "scout" } },
  adapterConfig: {} as Record<string, unknown>,
};

/**
 * Table-aware db harness. Unlike the task-execution suite (whose single-table
 * select always returns the agent row), workspace resolution reads FOUR tables,
 * so the mock has to answer each one distinctly or the assertions are vacuous.
 */
function makeDb(rows: {
  issue?: Record<string, unknown> | null;
  project?: Record<string, unknown> | null;
  projectWorkspaces?: Array<Record<string, unknown>>;
  /** The `discussions` row backing payload.threadId (scopeType/scopeId). */
  thread?: Record<string, unknown> | null;
  agentConfig?: Record<string, unknown>;
  failProjectWorkspaceLookup?: boolean;
}) {
  const agentRow = { ...AGENT_ROW, adapterConfig: rows.agentConfig ?? {} };
  const sets: any[] = [];
  const db: any = {
    _sets: sets,
    select: () => {
      const c: any = {};
      let source = "";
      c.from = (table: { _?: { name?: string } }) => {
        source = table?._?.name ?? "";
        return c;
      };
      c.where = () => c;
      c.orderBy = () => c;
      const resolveRows = () => {
        switch (source) {
          case "issues":
            return rows.issue ? [rows.issue] : [];
          case "projects":
            return rows.project ? [rows.project] : [];
          case "project_workspaces":
            if (rows.failProjectWorkspaceLookup) throw new Error("project workspace lookup exploded");
            return rows.projectWorkspaces ?? [];
          case "discussions":
            return rows.thread ? [rows.thread] : [];
          case "work_questions":
            return [];
          default:
            return [agentRow];
        }
      };
      c.then = (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) => {
        try {
          return Promise.resolve(resolveRows()).then(resolve);
        } catch (err) {
          return reject ? Promise.resolve(reject(err)) : Promise.reject(err);
        }
      };
      return c;
    },
    insert: () => ({
      values: (v: any) => {
        sets.push({ insert: v });
        return { returning: () => Promise.resolve([{ id: "run-1" }]) };
      },
    }),
    update: () => {
      const u: any = {};
      let payload: any;
      u.set = (v: any) => {
        payload = v;
        return u;
      };
      u.where = () => {
        sets.push({ set: payload });
        const p: any = Promise.resolve([]);
        p.returning = () => Promise.resolve([{ id: "TASK-1" }]);
        p.catch = (cb: any) => Promise.resolve().catch(cb);
        return p;
      };
      return u;
    },
  };
  return db;
}

const TASK_PAYLOAD = { companyId: "co-1", source: "dispatcher.task", issueId: "TASK-1" };
// A thread run: no issueId, so the project comes from the thread's own scope.
const THREAD_PAYLOAD = { companyId: "co-1", source: "thread.participation", threadId: "th-1" };

/** The `context` the runner handed to adapter.execute for this run. */
function executedContext(): Record<string, unknown> {
  expect(adapterExecute).toHaveBeenCalledTimes(1);
  return adapterExecute.mock.calls[0]![0].context as Record<string, unknown>;
}

function executedWorkspace(): Record<string, unknown> {
  const ws = executedContext().paperclipWorkspace;
  expect(ws, "crew runs must always carry an execution workspace").toBeTruthy();
  return ws as Record<string, unknown>;
}

/** The message of every `log.warn` the run emitted. */
function warnMessages(): string[] {
  return warnMock.mock.calls.map((c) => String(c[1] ?? ""));
}

const RESOLUTION_FAILED = /crew workspace resolution failed/i;

/**
 * 🚨 THE DISCRIMINATOR. `resolveCrewExecutionWorkspace`'s catch returns exactly
 * `{ cwd: agentHome, source: "agent_home" }` — byte-identical to what the HAPPY
 * path returns for a project-less run. So an assertion on cwd/source alone
 * cannot tell "resolved correctly, no project" from "everything threw". Every
 * happy-path test calls this; only the catch emits the warn line, so a future
 * change that broke the whole resolver would now turn these tests RED instead
 * of leaving them green with the label intact.
 */
function expectResolvedWithoutFallingBack(): void {
  expect(
    warnMessages().filter((m) => RESOLUTION_FAILED.test(m)),
    "resolution must have SUCCEEDED — a warn here means the tolerant catch produced this result, so the assertions below prove nothing",
  ).toEqual([]);
}

describe("T5: crew execution-workspace resolution", () => {
  beforeEach(() => {
    writeFileMock.mockClear().mockResolvedValue(undefined);
    unlinkMock.mockClear().mockResolvedValue(undefined);
    mkdirMock.mockClear().mockResolvedValue(undefined);
    statMock.mockClear().mockResolvedValue({ isDirectory: () => true });
    adapterExecute.mockClear().mockResolvedValue({ exitCode: 0 });
    createEventMock.mockClear().mockResolvedValue(undefined);
    buildMcpMock.mockClear().mockReturnValue({});
    checkoutMock.mockClear().mockResolvedValue({ id: "TASK-1", status: "in_progress" });
    getByIdMock.mockClear().mockResolvedValue({ id: "TASK-1", status: "in_review", executionRunId: "run-1" });
    getExperimentalMock.mockClear().mockResolvedValue({ enableIsolatedWorkspaces: true });
    warnMock.mockClear();
    infoMock.mockClear();
  });

  it("(a) resolves the project workspace for a task on a workspace-backed project", async () => {
    const db = makeDb({
      issue: { projectId: "proj-1", executionWorkspaceSettings: null },
      project: {
        executionWorkspacePolicy: { enabled: true, defaultMode: "shared_workspace" },
        functionType: "software_development",
      },
      projectWorkspaces: [
        {
          id: "pw-1",
          cwd: "/repos/customer-app",
          repoUrl: "https://example.test/customer-app.git",
          repoRef: "main",
        },
      ],
    });

    await runAoaAgent(db as any, AGENT_ID, TASK_PAYLOAD);

    expectResolvedWithoutFallingBack();
    const ws = executedWorkspace();
    expect(ws.cwd).toBe("/repos/customer-app");
    expect(ws.source).toBe("project_primary");
    expect(ws.projectId).toBe("proj-1");
    expect(ws.workspaceId).toBe("pw-1");
    expect(ws.repoUrl).toBe("https://example.test/customer-app.git");
    expect(ws.repoRef).toBe("main");
    // Mirrors heartbeat's shape: crew never realizes a worktree (deferred to
    // W3b), so strategy is the shared project primary and the worktree fields
    // are explicitly null rather than absent.
    expect(ws.strategy).toBe("project_primary");
    expect(ws.branchName).toBeNull();
    expect(ws.worktreePath).toBeNull();
    expect(ws.agentHome).toBe(AGENT_HOME);
    // Hints mirror heartbeat's `context.paperclipWorkspaces`.
    expect(executedContext().paperclipWorkspaces).toEqual([
      {
        workspaceId: "pw-1",
        cwd: "/repos/customer-app",
        repoUrl: "https://example.test/customer-app.git",
        repoRef: "main",
      },
    ]);
  });

  it("(b) 🚨 REGRESSION GUARD: a task with no project falls back to the per-agent home, NEVER the AoA repo", async () => {
    const db = makeDb({ issue: { projectId: null, executionWorkspaceSettings: null }, project: null });

    await runAoaAgent(db as any, AGENT_ID, TASK_PAYLOAD);

    // FIRST: prove this is the resolved result, not the catch's. The catch
    // returns the identical cwd + source, so without this the guard could not
    // fail even if the entire happy path started throwing.
    expectResolvedWithoutFallingBack();

    const ws = executedWorkspace();
    expect(ws.cwd).toBe(AGENT_HOME);
    expect(ws.source).toBe("agent_home");

    // The whole point of T5. `process.cwd()` under vitest is the server package
    // inside this repository; the repo root is its parent. Neither may ever be
    // the crew cwd, nor an ancestor of it.
    const cwd = String(ws.cwd);
    expect(cwd).not.toBe(process.cwd());
    expect(path.resolve(cwd)).not.toBe(path.resolve(process.cwd()));
    expect(path.relative(process.cwd(), cwd).startsWith("..")).toBe(true);
    // …and the resolved cwd is under the AoA instance root, not a source tree.
    expect(path.resolve(cwd).startsWith(path.resolve(AGENT_HOME))).toBe(true);
    // Created eagerly so the adapter's ensureAbsoluteDirectory finds it.
    expect(mkdirMock).toHaveBeenCalledWith(AGENT_HOME, { recursive: true });
  });

  it("(b') a `none` execution-workspace policy also lands in the per-agent home, not the AoA repo", async () => {
    const db = makeDb({
      issue: { projectId: "proj-1", executionWorkspaceSettings: null },
      // executionWorkspacePolicy `enabled: false` is the "none" shape.
      project: { executionWorkspacePolicy: { enabled: false }, functionType: "marketing" },
      projectWorkspaces: [],
    });

    await runAoaAgent(db as any, AGENT_ID, TASK_PAYLOAD);

    expectResolvedWithoutFallingBack();
    const ws = executedWorkspace();
    expect(ws.cwd).toBe(AGENT_HOME);
    expect(ws.source).toBe("agent_home");
    expect(String(ws.cwd)).not.toBe(process.cwd());
    // Project identity is still carried even though no directory resolved.
    expect(ws.projectId).toBe("proj-1");
  });

  it("(c) a resolution failure does not crash the run — and still never yields the AoA repo", async () => {
    const db = makeDb({
      issue: { projectId: "proj-1", executionWorkspaceSettings: null },
      project: { executionWorkspacePolicy: { enabled: true, defaultMode: "shared_workspace" } },
      failProjectWorkspaceLookup: true,
    });

    const result = await runAoaAgent(db as any, AGENT_ID, TASK_PAYLOAD);

    expect(result.status).not.toBe("failed");
    const ws = executedWorkspace();
    expect(ws.cwd).toBe(AGENT_HOME);
    expect(ws.source).toBe("agent_home");
    expect(String(ws.cwd)).not.toBe(process.cwd());

    // The POSITIVE side of the discriminator: this is the one test where the
    // catch SHOULD have produced the result, so the warn must be present. If
    // this ever stops firing, `expectResolvedWithoutFallingBack` in the other
    // tests has gone vacuous and would no longer catch anything.
    const failureWarns = warnMock.mock.calls.filter((c) => RESOLUTION_FAILED.test(String(c[1] ?? "")));
    expect(failureWarns).toHaveLength(1);
    // …and it carries enough to identify WHICH lookup failed.
    expect(failureWarns[0]![0]).toMatchObject({
      companyId: "co-1",
      agentId: AGENT_ID,
      issueId: "TASK-1",
      executionProjectId: "proj-1",
    });
  });

  it("(d) precedence: a configured adapter cwd outranks the agent-home floor but NOT a real workspace", async () => {
    // agent_home floor + configured cwd → the adapter prefers the configured
    // cwd (claude-local execute.ts:186 `useConfiguredInsteadOfAgentHome`).
    // The runner's job is to emit source:"agent_home" so that branch can fire.
    const floorDb = makeDb({
      issue: { projectId: null, executionWorkspaceSettings: null },
      project: null,
      agentConfig: { cwd: "/configured/dir" },
    });
    await runAoaAgent(floorDb as any, AGENT_ID, TASK_PAYLOAD);
    expect(executedWorkspace().source).toBe("agent_home");
    expect(adapterExecute.mock.calls[0]![0].config.cwd).toBe("/configured/dir");

    adapterExecute.mockClear();

    // A REAL project workspace outranks the configured cwd: source is
    // project_primary, so the adapter takes the workspace cwd.
    const workspaceDb = makeDb({
      issue: { projectId: "proj-1", executionWorkspaceSettings: null },
      project: { executionWorkspacePolicy: { enabled: true, defaultMode: "shared_workspace" } },
      projectWorkspaces: [{ id: "pw-1", cwd: "/repos/customer-app", repoUrl: null, repoRef: null }],
      agentConfig: { cwd: "/configured/dir" },
    });
    await runAoaAgent(workspaceDb as any, AGENT_ID, TASK_PAYLOAD);
    const ws = executedWorkspace();
    expect(ws.source).toBe("project_primary");
    expect(ws.cwd).toBe("/repos/customer-app");
  });

  it("(e) an `adapter_default` project policy keeps the agent home (project workspace deliberately not used)", async () => {
    const db = makeDb({
      issue: { projectId: "proj-1", executionWorkspaceSettings: null },
      project: { executionWorkspacePolicy: { enabled: true, defaultMode: "adapter_default" } },
      projectWorkspaces: [{ id: "pw-1", cwd: "/repos/customer-app", repoUrl: null, repoRef: null }],
    });

    await runAoaAgent(db as any, AGENT_ID, TASK_PAYLOAD);

    expectResolvedWithoutFallingBack();
    const ws = executedWorkspace();
    expect(ws.mode).toBe("agent_default");
    expect(ws.cwd).toBe(AGENT_HOME);
    expect(ws.source).toBe("agent_home");
  });

  it("(f) an UNSCOPED thread-only crew run still gets a workspace — the agent-home floor", async () => {
    const db = makeDb({ issue: null, project: null, thread: { scopeType: null, scopeId: null } });

    await runAoaAgent(db as any, AGENT_ID, THREAD_PAYLOAD);

    expectResolvedWithoutFallingBack();
    const ws = executedWorkspace();
    expect(ws.cwd).toBe(AGENT_HOME);
    expect(ws.source).toBe("agent_home");
    expect(ws.projectId).toBeNull();
    expect(String(ws.cwd)).not.toBe(process.cwd());
    expect(path.relative(process.cwd(), String(ws.cwd)).startsWith("..")).toBe(true);
  });

  it("(g) a thread SCOPED TO A PROJECT resolves that project's workspace", async () => {
    // The dominant crew shape: mention / participation / controller / sweeps.
    // These carry no task, so before the thread-scope lookup they could never
    // reach a project workspace however the thread was scoped.
    const db = makeDb({
      issue: null,
      thread: { scopeType: "project", scopeId: "proj-7" },
      project: { executionWorkspacePolicy: { enabled: true, defaultMode: "shared_workspace" } },
      projectWorkspaces: [
        { id: "pw-7", cwd: "/repos/scoped-app", repoUrl: "https://example.test/s.git", repoRef: "main" },
      ],
    });

    await runAoaAgent(db as any, AGENT_ID, THREAD_PAYLOAD);

    expectResolvedWithoutFallingBack();
    const ws = executedWorkspace();
    expect(ws.cwd).toBe("/repos/scoped-app");
    expect(ws.source).toBe("project_primary");
    expect(ws.projectId).toBe("proj-7");
    expect(ws.workspaceId).toBe("pw-7");
  });

  it("(g') a thread scoped to a DEPARTMENT or a GOAL does not borrow a project workspace", async () => {
    for (const scopeType of ["department", "goal"]) {
      adapterExecute.mockClear();
      warnMock.mockClear();
      const db = makeDb({
        issue: null,
        thread: { scopeType, scopeId: "dept-or-goal-1" },
        // Present but unreachable: only a `project` scope may select it.
        project: { executionWorkspacePolicy: { enabled: true, defaultMode: "shared_workspace" } },
        projectWorkspaces: [{ id: "pw-9", cwd: "/repos/not-mine", repoUrl: null, repoRef: null }],
      });

      await runAoaAgent(db as any, AGENT_ID, THREAD_PAYLOAD);

      expectResolvedWithoutFallingBack();
      const ws = executedWorkspace();
      expect(ws.cwd, `${scopeType}-scoped thread must not borrow a project workspace`).toBe(AGENT_HOME);
      expect(ws.projectId).toBeNull();
    }
  });

  it("(h) a TASK's project outranks the thread scope when a run carries both", async () => {
    const db = makeDb({
      issue: { projectId: "proj-task", executionWorkspaceSettings: null },
      thread: { scopeType: "project", scopeId: "proj-thread" },
      project: { executionWorkspacePolicy: { enabled: true, defaultMode: "shared_workspace" } },
      projectWorkspaces: [{ id: "pw-task", cwd: "/repos/task-app", repoUrl: null, repoRef: null }],
    });

    await runAoaAgent(db as any, AGENT_ID, { ...TASK_PAYLOAD, threadId: "th-1" });

    expectResolvedWithoutFallingBack();
    expect(executedWorkspace().projectId).toBe("proj-task");
  });
});
