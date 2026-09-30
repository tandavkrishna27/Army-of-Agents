// Spec B Task 5 — runner `issueId` branch (the integration keystone).
//
// When the dispatcher wakes a crew agent with `payload.issueId`, the runner must:
//   1. stamp the internal_agent_runs row with relatedEntityType="task" (NOT
//      "issue" — that string is not in the column vocabulary) + relatedEntityId.
//   2. CLAIM the task via issueService(db).checkout(issueId, agentId,
//      ["todo","backlog","in_progress"], runId) before running the adapter.
//   3. on a checkout CONFLICT (checkout throws) → mark the run ROW 'failed'
//      (the runs enum has no 'succeeded') with a benign-skip errorMessage, then
//      RETURN { status: "succeeded" } (the AoaRunResult) so the dispatcher's
//      failure brake does NOT count a concurrency skip. Mirrors the entry-claim
//      race precedent (runner.ts:139-152).
//   4. SILENT-STUCK GUARD: after the adapter returns, if the task is still
//      'in_progress' AND its executionRunId === this runId (the agent exited
//      without calling set_task_status — non-claude / hung run), RELEASE the
//      task back to 'todo' (clear executionRunId/checkoutRunId) and THROW so the
//      run is marked failed loudly instead of leaving the task stuck forever.
//
// Harness: proxy-table + hoisted-mock + `_sets`-recording db (mirrors
// aoa-runner-failure-terminalize.test.ts). The dynamic `import("../../issues.js")`
// the runner performs is intercepted by `vi.mock("../services/issues.js", ...)`
// (vitest resolves both relative ids to the same module). Windows-runnable.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  writeFileMock,
  unlinkMock,
  adapterExecute,
  createEventMock,
  buildMcpMock,
  buildBridgeSpecMock,
  publishLiveEventMock,
  publishIssueStatusChangedMock,
  mkdirMock,
  statMock,
  checkoutMock,
  getByIdMock,
} = vi.hoisted(() => ({
  writeFileMock: vi.fn().mockResolvedValue(undefined),
  unlinkMock: vi.fn().mockResolvedValue(undefined),
  // T5: the runner now resolves an execution workspace before adapter.execute,
  // which mkdir's the per-agent home and stat's candidate cwds. Both go through
  // this same mocked module, so they have to exist here or every task run
  // throws.
  mkdirMock: vi.fn().mockResolvedValue(undefined),
  statMock: vi.fn().mockResolvedValue({ isDirectory: () => true }),
  adapterExecute: vi.fn().mockResolvedValue({ exitCode: 0 }),
  createEventMock: vi.fn().mockResolvedValue(undefined),
  buildMcpMock: vi.fn(() => ({})),
  buildBridgeSpecMock: vi.fn(() => ({
    command: "node",
    args: ["/bridge.js"],
    env: { AOA_SESSION_COMPANY_ID: "c" },
  })),
  publishLiveEventMock: vi.fn(),
  publishIssueStatusChangedMock: vi.fn(),
  checkoutMock: vi.fn().mockResolvedValue({ id: "TASK-1", status: "in_progress" }),
  getByIdMock: vi.fn().mockResolvedValue(null),
}));

// `workspace-resolution.ts` imports the DEFAULT export; the runner uses the
// named writeFile/unlink. Provide both shapes.
vi.mock("node:fs/promises", () => {
  const api = { writeFile: writeFileMock, unlink: unlinkMock, mkdir: mkdirMock, stat: statMock };
  return { ...api, default: api };
});

// P4: the runner resolves provider credentials via resolveProviderCredential
// (dynamic import). In production (real db) a self-hosted miss returns
// host_login_fallback and never throws; but this proxy-table mock db doesn't stub
// the provider_connections/assignments query, so the unmocked resolver would throw
// and fail the run. Mock it to the no-op override (mirrors aoa-runner.test.ts:68).
vi.mock("../services/provider-resolution.js", () => ({
  resolveProviderCredential: vi.fn(async () => ({ source: "agent_env_override" })),
  applyResolvedCredential: (config: unknown) => config,
  toExecutionTargetHint: () => ({ credentialKind: null, executionTargetSlug: null }),
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...a: unknown[]) => ({ and: a })),
  asc: vi.fn((a: unknown) => ({ asc: a })),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...vals: unknown[]) => ({
      sql: strings.join("?"),
      vals,
    }),
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
  resolveAdapterExecutionContextUnguarded: vi.fn(() => ({
    executionTarget: {},
    runtimeCommandSpec: {},
  })),
  resolveGuardedAdapterExecutionContext: vi.fn(() => ({
    // MIG-006: a real `type` so the shadow seam can be proved to read the RESOLVED
    // target rather than a constant. Production `AdapterExecutionTarget` always
    // carries one (runner.ts branches on `executionTarget.type`).
    executionTarget: { type: "provider-sandbox" },
    runtimeCommandSpec: {},
  })),
  applyEnvironmentAcquisitionConfig: (config: unknown) => config,
}));

// U4: crew acquires a sandbox lease before buildMcpConfig — stub the desktop/
// local no-sandbox return shape so this suite stays on its existing byte-
// identical local path.
vi.mock("../services/acquire-execution-context.js", () => ({
  acquireExecutionContext: vi.fn().mockResolvedValue({ sandbox: null, lease: null, warmResolved: false }),
}));

vi.mock("../services/internal-agent/aoa-agents/bridge-path.js", () => ({
  resolveBridgeEntrypoint: vi.fn(() => "/bridge"),
}));

// T5: crew workspace resolution reads the instance experimental flags. Stub the
// service so this suite keeps modelling only the task-execution branch.
vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: vi.fn(() => ({
    getExperimental: vi.fn().mockResolvedValue({ enableIsolatedWorkspaces: true }),
  })),
}));

// T1: the runner opens a run transcript before adapter.execute. run-log-store
// imports `node:fs` — a DIFFERENT specifier than the `node:fs/promises` this
// file mocks — so without this an otherwise fully-mocked suite does REAL
// filesystem I/O, writing .ndjson files keyed on fixture ids that repeat across
// test files. vitest runs files in parallel workers and begin() TRUNCATES, so
// that is a latent cross-file flake, not just litter.
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
  publishLiveEvent: publishLiveEventMock,
  // Task 5.6: runner.ts now also imports these from live-events. The silent-
  // stuck → todo release publishes issue.status_changed via this helper; stub it
  // so the call is observable (and never an undefined-call swallowed by the
  // best-effort wrapper). Presence helpers are stubbed for the (no-threadId)
  // task path where they are never invoked.
  publishIssueStatusChanged: publishIssueStatusChangedMock,
  threadWorkingAgents: { add: vi.fn(), remove: vi.fn(() => []), list: vi.fn(() => []) },
  broadcastThreadPresence: vi.fn(),
}));

// The runner reaches the issue surface via a DYNAMIC import("../../issues.js").
// Mock it here; vitest matches the resolved module id regardless of the
// caller-relative specifier. issueService(db) returns our hoisted spies.
vi.mock("../services/issues.js", () => ({
  issueService: () => ({ checkout: checkoutMock, getById: getByIdMock }),
}));

vi.mock("../middleware/logger.js", () => {
  function makeLogger(): any {
    const l: any = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    l.child = () => makeLogger();
    return l;
  }
  return { logger: makeLogger() };
});

import { runAoaAgent } from "../services/internal-agent/aoa-agents/runner.js";
import { setDistributedShadowPort } from "../services/distributed-shadow-port.js";

// Db harness that records every update().set() payload + its where() arg into
// `_sets`. For a task wakeup (issueId set, NO entryId) the runner only calls
// db.select() once — to load the agent row. All issue access (checkout/getById)
// goes through the MOCKED issueService, not db.* — so the db mock here only has
// to model the agent load, the run insert, and the run/issue update writes.
function makeDb(options: { parkedQuestion?: boolean } = {}) {
  const agentRow = {
    id: "a-1",
    companyId: "co-1",
    name: "Scout",
    adapterType: "process",
    runtimeConfig: { aoa: { role: "scout" } },
    adapterConfig: {},
  };
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
      c.then = (resolve: (v: unknown[]) => unknown) =>
        Promise.resolve(
          source === "work_questions"
            ? (options.parkedQuestion ? [{ id: "question-1" }] : [])
            : [agentRow],
        ).then(resolve);
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
      u.where = (w: any) => {
        sets.push({ set: payload, where: w });
        const p: any = Promise.resolve([]);
        // A real guarded UPDATE…RETURNING returns the matched row; the runner's
        // task-release reads released.length to decide whether to publish/throw.
        // Return one row so the release "fires" (the test setups all have the task
        // still in_progress + owned by this run).
        p.returning = () => Promise.resolve([{ id: "TASK-1" }]);
        p.catch = (cb: any) => Promise.resolve().catch(cb);
        return p;
      };
      return u;
    },
  };
  return db;
}

const TASK_PAYLOAD = {
  companyId: "co-1",
  source: "dispatcher.task",
  issueId: "TASK-1",
};

describe("Spec B Task 5: runner issueId branch", () => {
  beforeEach(() => {
    writeFileMock.mockClear().mockResolvedValue(undefined);
    unlinkMock.mockClear().mockResolvedValue(undefined);
    mkdirMock.mockClear().mockResolvedValue(undefined);
    statMock.mockClear().mockResolvedValue({ isDirectory: () => true });
    adapterExecute.mockClear().mockResolvedValue({ exitCode: 0 });
    createEventMock.mockClear().mockResolvedValue(undefined);
    buildMcpMock.mockClear().mockReturnValue({});
    publishLiveEventMock.mockClear();
    publishIssueStatusChangedMock.mockClear();
    checkoutMock.mockClear().mockResolvedValue({ id: "TASK-1", status: "in_progress" });
    // Default getById → a non-stuck task so the silent-stuck guard is a no-op
    // (status not in_progress). Individual tests override.
    getByIdMock.mockClear().mockResolvedValue({ id: "TASK-1", status: "in_review", executionRunId: "run-1" });
  });

  it("(a) stamps the run row relatedEntityType='task' + relatedEntityId=issueId (NOT 'issue')", async () => {
    const db = makeDb();
    await runAoaAgent(db as any, "a-1", TASK_PAYLOAD);

    const insertRow = db._sets.find((s: any) => s.insert)?.insert;
    expect(insertRow).toBeDefined();
    expect(insertRow.relatedEntityType).toBe("task");
    expect(insertRow.relatedEntityType).not.toBe("issue");
    expect(insertRow.relatedEntityId).toBe("TASK-1");
  });

  it("(b) claims the task via checkout(issueId, agentId, ['todo','backlog','in_progress'], runId)", async () => {
    const db = makeDb();
    await runAoaAgent(db as any, "a-1", TASK_PAYLOAD);

    expect(checkoutMock).toHaveBeenCalledTimes(1);
    expect(checkoutMock).toHaveBeenCalledWith(
      "TASK-1",
      "a-1",
      ["todo", "backlog", "in_progress"],
      "run-1",
    );
  });

  it("(c) checkout CONFLICT (throws) → run returns { status:'succeeded' }, run ROW set 'failed' (benign skip), adapter NOT called", async () => {
    checkoutMock.mockRejectedValueOnce(new Error("Issue checkout conflict"));
    const db = makeDb();

    const result = await runAoaAgent(db as any, "a-1", TASK_PAYLOAD);

    // AoaRunResult is 'succeeded' — a concurrency skip is benign; the
    // dispatcher's failure brake must NOT count it.
    expect(result.status).toBe("succeeded");

    // The run ROW is terminalized 'failed' (the runs enum has no 'succeeded').
    const runFail = db._sets.find(
      (s: any) =>
        s.set?.status === "failed" &&
        typeof s.set?.errorMessage === "string" &&
        /checkout conflict/i.test(s.set.errorMessage),
    );
    expect(runFail).toBeDefined();

    // The adapter was never invoked — we bailed before execute.
    expect(adapterExecute).not.toHaveBeenCalled();
    // And no benign 'succeeded' string leaked onto any run row write.
    const anySucceededRow = db._sets.some((s: any) => s.set?.status === "succeeded");
    expect(anySucceededRow).toBe(false);
  });

  it("(d) silent-stuck: task still in_progress + executionRunId===runId after execute → released to 'todo' and run ends failed", async () => {
    // Agent exited WITHOUT calling set_task_status: getById reports the task is
    // still locked by THIS run. The guard must release it and throw.
    getByIdMock.mockResolvedValueOnce({
      id: "TASK-1",
      status: "in_progress",
      executionRunId: "run-1",
    });
    const db = makeDb();

    const result = await runAoaAgent(db as any, "a-1", TASK_PAYLOAD);

    // The throw lands in the catch → run row marked failed → failed AoaRunResult.
    // (No effectiveAutonomy on the payload → unknown dial → guard fires, as before
    // this fix. The Manual exemption requires a positive effectiveAutonomy===0.)
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toMatch(/still in progress|not advanced/i);

    // The task was RELEASED back to 'todo' with the execution lock cleared.
    const release = db._sets.find(
      (s: any) => s.set?.status === "todo" && s.set?.executionRunId === null,
    );
    expect(release).toBeDefined();
    expect(release.set.checkoutRunId).toBe(null);

    // Task 5.6: the silent-stuck release is a crew status-MOVE (in_progress →
    // todo) that bypasses issueService.update — it must publish
    // issue.status_changed (company-broadcast) so the board drops the card back.
    expect(publishIssueStatusChangedMock).toHaveBeenCalledWith("co-1", "TASK-1", "todo");
  });

  it("(d') no release when task already moved on (status not in_progress) — guard is a no-op", async () => {
    getByIdMock.mockResolvedValueOnce({
      id: "TASK-1",
      status: "in_review",
      executionRunId: "run-1",
    });
    const db = makeDb();

    const result = await runAoaAgent(db as any, "a-1", TASK_PAYLOAD);

    // Agent moved the task forward → normal completion, no release write.
    expect(result.status).not.toBe("failed");
    const release = db._sets.find((s: any) => s.set?.status === "todo");
    expect(release).toBeUndefined();
  });

  it("keeps an in-progress task parked when this Crew run owns an open blocking question", async () => {
    getByIdMock.mockResolvedValueOnce({
      id: "TASK-1",
      status: "in_progress",
      executionRunId: "run-1",
    });
    const db = makeDb({ parkedQuestion: true });

    const result = await runAoaAgent(db as any, "a-1", TASK_PAYLOAD);

    expect(result.status).toBe("succeeded");
    const release = db._sets.find((s: any) => s.set?.status === "todo");
    expect(release).toBeUndefined();
    expect(publishIssueStatusChangedMock).not.toHaveBeenCalledWith("co-1", "TASK-1", "todo");
  });

  it("(e) crew MCP params carry actorType='agent' + agentKind='aoa' (crew actor identity — T8 Defect A)", async () => {
    // ask_human's identity gate keys on actorType==='agent'; when the runner
    // omits actorType the bridge defaults AOA_ACTOR_TYPE to 'board' and the
    // gate fails for every crew agent. Assert both the config and bridge-spec
    // builders receive the corrected actor identity.
    buildMcpMock.mockClear();
    buildBridgeSpecMock.mockClear();
    const db = makeDb();

    await runAoaAgent(db as any, "a-1", TASK_PAYLOAD);

    expect(buildBridgeSpecMock).toHaveBeenCalledTimes(1);
    const bridgeParams = buildBridgeSpecMock.mock.calls[0]![0] as any;
    expect(bridgeParams.actorType).toBe("agent");
    expect(bridgeParams.agentKind).toBe("aoa");
    // Guard against a regression to the unset/'board' actor.
    expect(bridgeParams.actorType).not.toBe("board");
    expect(bridgeParams.actorType).not.toBeUndefined();

    // buildMcpConfig (the claude {mcpServers} envelope) gets the SAME params.
    const cfgParams = buildMcpMock.mock.calls[0]![0] as any;
    expect(cfgParams.actorType).toBe("agent");
  });

  it("(d'') no release when a DIFFERENT run owns the task (executionRunId !== runId)", async () => {
    getByIdMock.mockResolvedValueOnce({
      id: "TASK-1",
      status: "in_progress",
      executionRunId: "some-other-run",
    });
    const db = makeDb();

    const result = await runAoaAgent(db as any, "a-1", TASK_PAYLOAD);

    // Not our lock → do not touch it; complete normally.
    expect(result.status).not.toBe("failed");
    const release = db._sets.find((s: any) => s.set?.status === "todo");
    expect(release).toBeUndefined();
  });

  // ── Autonomy-aware completion guard (T10 fix) ──────────────────────────────
  // The silent-stuck guard's release-to-todo + throw must fire ONLY when the
  // agent was PERMITTED to advance the task (effectiveAutonomy >= 1) but didn't.
  // At Manual (effectiveAutonomy === 0) the A4 dial-gate FORBIDS any advance, so
  // a task still in_progress after the run is the EXPECTED terminal state — not a
  // failure. Before this fix every Manual crew run failed here (the agent's
  // correctly-refused set_task_status call could never satisfy the guard).

  it("(f) MANUAL (effectiveAutonomy=0): task still in_progress + owned by this run → run SUCCEEDS, NOT released to todo, lock cleared, no throw", async () => {
    // Same silent-stuck state as (d) — but at Manual the agent was never allowed
    // to advance, so this is a success, not a stall.
    getByIdMock.mockResolvedValueOnce({
      id: "TASK-1",
      status: "in_progress",
      executionRunId: "run-1",
    });
    const db = makeDb();

    const result = await runAoaAgent(db as any, "a-1", {
      ...TASK_PAYLOAD,
      effectiveAutonomy: 0,
    });

    // The run is NOT failed — the agent did its work; Manual just means the
    // founder advances the card.
    expect(result.status).toBe("succeeded");

    // NOT released to 'todo' (no ping-pong back to the queue).
    const release = db._sets.find((s: any) => s.set?.status === "todo");
    expect(release).toBeUndefined();

    // The execution lock IS cleared so the task is founder-actionable and not
    // stuck-locked — status stays untouched (undefined in the write). This is the
    // discriminator: it proves the guard block WAS entered and took the Manual
    // branch (not that the guard was skipped because the task wasn't in_progress).
    const lockClear = db._sets.find(
      (s: any) =>
        s.set?.executionRunId === null &&
        s.set?.checkoutRunId === null &&
        s.set?.status === undefined,
    );
    expect(lockClear).toBeDefined();

    // No board broadcast of a todo status-move; the card did not move.
    expect(publishIssueStatusChangedMock).not.toHaveBeenCalledWith("co-1", "TASK-1", "todo");
  });

  it("(g) ASSIST (effectiveAutonomy=1): task still in_progress + owned by this run → guard STILL fires (release + fail) — regression guard for the guard", async () => {
    // Identical task state to (f), only the dial differs. At Assist the agent WAS
    // permitted to advance (→ in_review) but didn't → a genuine stall the guard
    // must still catch. This pins that the autonomy gate did not neuter the
    // guard's real purpose.
    getByIdMock.mockResolvedValueOnce({
      id: "TASK-1",
      status: "in_progress",
      executionRunId: "run-1",
    });
    const db = makeDb();

    const result = await runAoaAgent(db as any, "a-1", {
      ...TASK_PAYLOAD,
      effectiveAutonomy: 1,
    });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toMatch(/still in progress|not advanced/i);

    const release = db._sets.find(
      (s: any) => s.set?.status === "todo" && s.set?.executionRunId === null,
    );
    expect(release).toBeDefined();
    expect(release.set.checkoutRunId).toBe(null);
    expect(publishIssueStatusChangedMock).toHaveBeenCalledWith("co-1", "TASK-1", "todo");
  });

  it("(h) ASSIST (effectiveAutonomy=1): task moved to in_review (agent succeeded) → guard no-op, run completes", async () => {
    getByIdMock.mockResolvedValueOnce({
      id: "TASK-1",
      status: "in_review",
      executionRunId: "run-1",
    });
    const db = makeDb();

    const result = await runAoaAgent(db as any, "a-1", {
      ...TASK_PAYLOAD,
      effectiveAutonomy: 1,
    });

    expect(result.status).not.toBe("failed");
    const release = db._sets.find((s: any) => s.set?.status === "todo");
    expect(release).toBeUndefined();
  });
  // ─── MIG-006 ───────────────────────────────────────────────────────────────
  describe("MIG-006 — the crew shadow observation", () => {
    afterEach(() => setDistributedShadowPort(null));

    it("records nothing when no port is registered, and the dispatch is unchanged", async () => {
      const db = makeDb();
      const result = await runAoaAgent(db as any, "a-1", TASK_PAYLOAD);
      expect(result.status).toBe("succeeded");
      expect(adapterExecute).toHaveBeenCalledTimes(1);
    });

    it("records exactly one observation carrying the crew run's own identity", async () => {
      const record = vi.fn(async () => {});
      setDistributedShadowPort({ record });
      const db = makeDb();
      await runAoaAgent(db as any, "a-1", TASK_PAYLOAD);

      expect(record).toHaveBeenCalledTimes(1);
      const observed = record.mock.calls[0]?.[0] as {
        source: { kind: string; crewRunId: string };
        principal: { kind: string; id: string };
        routing: { executionTargetType: string };
      };
      expect(observed.source.kind).toBe("crew_run");
      expect(observed.source.crewRunId).toBe("run-1");
      // A crew_run has no run/issue fields — the FROZEN .strict() variant refuses them,
      // and the task this dispatch happens to serve is NOT the source identity.
      expect(observed.source).not.toHaveProperty("runId");
      expect(observed.source).not.toHaveProperty("issueId");
      expect(observed.principal).toEqual({ kind: "agent", id: "a-1" });
      // The RESOLVED target, not a constant the seam invented.
      expect(observed.routing.executionTargetType).toBe("provider-sandbox");
    });

    it("observes BEFORE the adapter runs — intent, not outcome", async () => {
      const order: string[] = [];
      setDistributedShadowPort({
        record: async () => {
          order.push("shadow");
        },
      });
      adapterExecute.mockImplementationOnce(async () => {
        order.push("execute");
        return { status: "completed", output: "done" };
      });
      const db = makeDb();
      await runAoaAgent(db as any, "a-1", TASK_PAYLOAD);
      expect(order).toEqual(["shadow", "execute"]);
    });

    it("a port that throws never fails the dispatch", async () => {
      setDistributedShadowPort({
        record: async () => {
          throw new Error("shadow exploded");
        },
      });
      const db = makeDb();
      const result = await runAoaAgent(db as any, "a-1", TASK_PAYLOAD);
      expect(result.status).toBe("succeeded");
      expect(adapterExecute).toHaveBeenCalledTimes(1);
    });
  });
});
