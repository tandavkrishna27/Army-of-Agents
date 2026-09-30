// T6 (P3) — company/marketplace skills must reach a CREW run.
//
// Crew agents (kind='aoa') execute through `runAoaAgent`, never the heartbeat.
// The heartbeat was the ONLY caller of `listRuntimeSkillEntries`
// (heartbeat.ts:3869-3885), so a skill a founder attached in the Agent Skills
// tab reached org agents and silently reached no crew agent at all — while the
// tab told them "Skills injected into this agent's context on every run".
//
// What the runner must do, mirroring heartbeat:
//   1. resolve the agent's attached skills and put them on `context.skills`,
//      which the claude-local adapter materializes into `--add-dir <skillsDir>`;
//   2. OMIT the key entirely when the resolution is empty — the adapter reads
//        const dbSkills = (context.skills ?? []) as …;
//        buildSkillsDir(dbSkills.length > 0 ? dbSkills : undefined)
//      (claude-local/src/server/execute.ts:374-375), so `[]` and "absent" must
//      stay indistinguishable or the bundled-skills branch changes shape;
//   3. WARN and continue on a resolver failure — never fail the run, never go
//      quiet (broken skill storage has to be visible).
//
// 🚨 DISCRIMINATOR. The tolerant catch produces the SAME observable shape as a
// legitimately-empty resolution: no `skills` key on the context. A test that
// only asserted "no skills key" would therefore pass whether resolution worked
// and found nothing or blew up entirely. So:
//   - the delivery test asserts the exact entries reached `adapter.execute`,
//     which is false the moment delivery breaks;
//   - every NON-failure test asserts the failure warn was NOT emitted;
//   - the failure test asserts it WAS, with its diagnostic fields.
//
// Harness: proxy-table + hoisted-mock db that drives `runAoaAgent` for real,
// copied from aoa-runner-task-execution.test.ts. Windows-runnable.

import { beforeEach, describe, expect, it, vi } from "vitest";

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
  listRuntimeSkillEntriesMock,
  fakeCrewTurnMock,
  logWarnMock,
  logInfoMock,
} = vi.hoisted(() => ({
  writeFileMock: vi.fn().mockResolvedValue(undefined),
  unlinkMock: vi.fn().mockResolvedValue(undefined),
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
  listRuntimeSkillEntriesMock: vi.fn().mockResolvedValue([]),
  // null ⇒ "no fake turn, run the real adapter" (the production default).
  fakeCrewTurnMock: vi.fn().mockResolvedValue(null),
  logWarnMock: vi.fn(),
  logInfoMock: vi.fn(),
}));

vi.mock("node:fs/promises", () => {
  const api = { writeFile: writeFileMock, unlink: unlinkMock, mkdir: mkdirMock, stat: statMock };
  return { ...api, default: api };
});

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
    companySkills: makeTable("company_skills"),
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
    executionTarget: {},
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

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: vi.fn(() => ({
    getExperimental: vi.fn().mockResolvedValue({ enableIsolatedWorkspaces: true }),
  })),
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
  publishLiveEvent: publishLiveEventMock,
  publishIssueStatusChanged: publishIssueStatusChangedMock,
  threadWorkingAgents: { add: vi.fn(), remove: vi.fn(() => []), list: vi.fn(() => []) },
  broadcastThreadPresence: vi.fn(),
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => ({ checkout: checkoutMock, getById: getByIdMock }),
}));

// Lets test (d) short-circuit adapter.execute exactly the way
// AOA_E2E_FAKE_CREW_LLM=1 does in production, without reproducing the harness's
// thread/control-file preconditions.
vi.mock("../services/internal-agent/aoa-agents/fake-crew-llm.js", () => ({
  maybeExecuteFakeCrewTurn: fakeCrewTurnMock,
}));

// THE subject under test's collaborator. The real module pulls in the adapter
// registry plus the agent/project/secret services, so it is stubbed to exactly
// the one method the runner is allowed to call.
vi.mock("../services/company-skills.js", () => ({
  companySkillService: vi.fn(() => ({
    listRuntimeSkillEntries: listRuntimeSkillEntriesMock,
  })),
}));

// A STABLE child logger (the shared harness mints a fresh one per `.child()`
// call, which would make the run's own warn unobservable from here).
vi.mock("../middleware/logger.js", () => {
  const child: any = {
    info: logInfoMock,
    warn: logWarnMock,
    error: vi.fn(),
    debug: vi.fn(),
  };
  child.child = () => child;
  return { logger: child };
});

import { runAoaAgent } from "../services/internal-agent/aoa-agents/runner.js";

/** The exact message fragment the crew skill-resolution failure warn carries. */
const SKILL_FAILURE_WARN = /skill/i;

function skillWarnCalls() {
  return logWarnMock.mock.calls.filter(
    ([, message]: [unknown, unknown]) =>
      typeof message === "string" && SKILL_FAILURE_WARN.test(message),
  );
}

/** The context object the adapter was actually handed. Throws if never called. */
function executedContext(): Record<string, unknown> {
  expect(adapterExecute, "adapter.execute must have run").toHaveBeenCalledTimes(1);
  return adapterExecute.mock.calls[0]![0].context as Record<string, unknown>;
}

function makeDb() {
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
        Promise.resolve(source === "work_questions" ? [] : [agentRow]).then(resolve);
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

/** Shape returned by companySkillService.listRuntimeSkillEntries. */
const ATTACHED_SKILL = {
  key: "company/co-1/market-research",
  name: "Market Research",
  markdown: "---\nname: Market Research\n---\n\n# Market Research\n\nHow we size a market.",
  trustLevel: "markdown_only",
};

const ATTACHED_SKILL_WITH_FILES = {
  key: "acme/skills/deep-dive",
  name: "Deep Dive",
  markdown: "# Deep Dive",
  trustLevel: "scripts_executables",
  files: [{ path: "scripts/run.sh", content: "echo hi" }],
};

describe("T6: crew runs receive the agent's attached company skills", () => {
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
    // Task already moved on → the silent-stuck guard is a no-op, so every test
    // here observes a plain completed run.
    getByIdMock.mockClear().mockResolvedValue({
      id: "TASK-1",
      status: "in_review",
      executionRunId: "run-1",
    });
    listRuntimeSkillEntriesMock.mockClear().mockResolvedValue([]);
    fakeCrewTurnMock.mockClear().mockResolvedValue(null);
    logWarnMock.mockClear();
    logInfoMock.mockClear();
  });

  it("(a) resolves the agent's skills and hands them to adapter.execute on context.skills", async () => {
    listRuntimeSkillEntriesMock.mockResolvedValueOnce([ATTACHED_SKILL]);
    const db = makeDb();

    await runAoaAgent(db as any, "a-1", TASK_PAYLOAD);

    // Resolved for THIS company + THIS agent (a swapped argument order would
    // silently resolve nothing in production).
    expect(listRuntimeSkillEntriesMock).toHaveBeenCalledTimes(1);
    expect(listRuntimeSkillEntriesMock).toHaveBeenCalledWith("co-1", "a-1");

    // The entries the adapter actually received — key, name AND markdown, since
    // markdown is the only part the CLI ends up reading.
    expect(executedContext().skills).toEqual([ATTACHED_SKILL]);

    // Not a silently-degraded run.
    expect(skillWarnCalls()).toEqual([]);
  });

  it("(a') carries multi-file skills through verbatim (ancillary files reach the adapter)", async () => {
    listRuntimeSkillEntriesMock.mockResolvedValueOnce([
      ATTACHED_SKILL,
      ATTACHED_SKILL_WITH_FILES,
    ]);
    const db = makeDb();

    await runAoaAgent(db as any, "a-1", TASK_PAYLOAD);

    const skills = executedContext().skills as Array<Record<string, unknown>>;
    expect(skills).toHaveLength(2);
    // buildSkillsDir writes `files` alongside SKILL.md; dropping them would make
    // a scripts_executables skill arrive as markdown only.
    expect(skills[1]!.files).toEqual(ATTACHED_SKILL_WITH_FILES.files);
    expect(skillWarnCalls()).toEqual([]);
  });

  it("(b) an EMPTY resolution omits the key entirely — `\"skills\" in context === false`", async () => {
    listRuntimeSkillEntriesMock.mockResolvedValueOnce([]);
    const db = makeDb();

    await runAoaAgent(db as any, "a-1", TASK_PAYLOAD);

    const context = executedContext();
    // Not `toBeFalsy()`: the adapter branches on
    // `dbSkills.length > 0 ? dbSkills : undefined`, and `context.skills = []`
    // would take the SAME branch as absent today — but only by accident of the
    // `?? []` default. The contract is that the key is never written.
    expect("skills" in context).toBe(false);

    // …and the emptiness came from a SUCCESSFUL resolution, not the catch. Without
    // this the test passes identically when resolution is broken.
    expect(listRuntimeSkillEntriesMock).toHaveBeenCalledTimes(1);
    expect(skillWarnCalls()).toEqual([]);
  });

  it("(c) a resolver FAILURE warns and the run continues without skills", async () => {
    listRuntimeSkillEntriesMock.mockRejectedValueOnce(new Error("skill storage unreadable"));
    const db = makeDb();

    const result = await runAoaAgent(db as any, "a-1", TASK_PAYLOAD);

    // The run is unaffected — a skill-resolution problem is not a run failure.
    expect(result.status).not.toBe("failed");
    expect(adapterExecute).toHaveBeenCalledTimes(1);
    expect("skills" in executedContext()).toBe(false);

    // 🚨 The half that makes (b) meaningful: the failure is LOUD. Broken skill
    // storage must not read as "this agent has no skills attached".
    const warns = skillWarnCalls();
    expect(warns).toHaveLength(1);
    const [payload] = warns[0]! as [Record<string, unknown>, string];
    // SANITIZED err — { name, message }, never the raw Error. A skill-resolution
    // failure is most plausibly a DB error, and a node-postgres error's own-
    // enumerable `query`/`parameters` would ride pino's err serializer into the
    // log; parity with heartbeat's team-coord block (heartbeat.ts:3923) strips it
    // to identity only. The diagnostic identity still has to survive.
    const err = payload.err as { name: string; message: string };
    expect(err).not.toBeInstanceOf(Error);
    expect(err.name).toBe("Error");
    expect(err.message).toBe("skill storage unreadable");
    expect(payload.agentId).toBe("a-1");
    expect(payload.companyId).toBe("co-1");
  });

  it("(d) resolution is skipped for a fake-crew turn — there is no spawn to deliver to", async () => {
    // A fake-crew turn (AOA_E2E_FAKE_CREW_LLM) short-circuits adapter.execute
    // entirely, so resolving skills for it spends DB reads (and, for local_path
    // skills, ancillary-file reads) on a context nothing consumes. That is why
    // the block lives inside the runner's `!adapterResult` branch alongside T5's
    // workspace resolution; this test is what stops a future edit hoisting it to
    // the top of the runner.
    fakeCrewTurnMock.mockResolvedValueOnce({ exitCode: 0 });
    const db = makeDb();

    await runAoaAgent(db as any, "a-1", TASK_PAYLOAD);

    expect(adapterExecute).not.toHaveBeenCalled();
    expect(listRuntimeSkillEntriesMock).not.toHaveBeenCalled();
  });
});
