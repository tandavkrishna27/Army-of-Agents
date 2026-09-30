// server/src/__tests__/runner-thread-presence.test.ts
//
// Thread chat experience Phase 5 — Tasks 5.1 + 5.2 (the crew runner feeds the
// thread typing-presence pill with humanized activity).
//
// When a crew run is a THREAD run (payload.threadId set — an @mention /
// participation dispatch), runAoaAgent must:
//   • add the agent to the thread working-agents presence store BEFORE the
//     adapter runs — threadWorkingAgents.add(threadId, agentId, name, activity)
//     — and broadcastThreadPresence so the chat lights "<Agent> is <activity>…";
//   • carry a HUMANIZED activity derived from the crew role (scout→researching,
//     planner→writing the plan, engineer→creating an artifact, adjutant→
//     reviewing the thread, default→typing);
//   • REMOVE the agent in a `finally` AFTER the run — GUARANTEED even when the
//     adapter throws (so a crashed run never leaves a ghost pill);
//   • do NONE of this for a non-thread run (task-only / entry-only) — those have
//     no chat to show presence in.
//
// We module-mock live-events.js to spy on add/remove/broadcast (these cross the
// runner.ts → live-events.js boundary, so the spies are observable — unlike a
// partial mock of publishLiveEvent called *within* live-events; see
// typing-bridge.test.ts's note). crew-context-bundle.js is mocked inert (its
// own tests live elsewhere). Mirrors aoa-runner-context-bundle.test.ts's set.

import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  execMock,
  createEventMock,
  buildMcpMock,
  buildBridgeSpecMock,
  bundleMock,
  addMock,
  removeMock,
  broadcastMock,
  publishLiveEventMock,
  publishIssueStatusChangedMock,
  callLog,
} = vi.hoisted(() => {
  const callLog: string[] = [];
  return {
    callLog,
    execMock: vi.fn(async () => {
      callLog.push("execute");
      return { exitCode: 0 };
    }),
    createEventMock: vi.fn().mockResolvedValue(undefined),
    buildMcpMock: vi.fn(() => ({ mcpServers: {} })),
    buildBridgeSpecMock: vi.fn(() => ({ command: "node", args: ["/x/mcp-bridge.js"], env: {} })),
    bundleMock: vi.fn().mockResolvedValue(""),
    addMock: vi.fn((threadId: string) => { callLog.push(`add:${threadId}`); }),
    removeMock: vi.fn((threadId: string) => { callLog.push(`remove:${threadId}`); return []; }),
    broadcastMock: vi.fn(),
    publishLiveEventMock: vi.fn(),
    publishIssueStatusChangedMock: vi.fn(),
  };
});

vi.mock("drizzle-orm", () => ({ and: (...a: unknown[]) => ({ and: a }), eq: (a: unknown, b: unknown) => ({ eq: [a, b] }) }));
vi.mock("@armyofagents/db", () => {
  const t = (n: string) => new Proxy({}, { get: (_x, p) => (typeof p === "string" ? Symbol(`${n}.${p}`) : undefined) });
  return { agents: t("a"), internalAgentRuns: t("iar"), discussionEntries: t("de"), issues: t("i"), memoryItems: t("mi"), discussions: t("disc"), discussionExtractedItems: t("dei"), embeddingQueue: t("eq"), memoryItemVersions: t("miv"), memoryRetrievals: t("mr"), suggestions: t("sug") };
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


// The context bundle — inert (tested separately).
vi.mock("../services/internal-agent/aoa-agents/crew-context-bundle.js", () => ({
  buildCrewContextBundle: bundleMock,
}));

// Presence surface under test — spy on the functions the runner imports.
vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: publishLiveEventMock,
  publishIssueStatusChanged: publishIssueStatusChangedMock,
  threadWorkingAgents: { add: addMock, remove: removeMock, list: vi.fn(() => []) },
  broadcastThreadPresence: broadcastMock,
}));

import { runAoaAgent, humanizedActivityForRole } from "../services/internal-agent/aoa-agents/runner.js";

// Thenable chain stub (mirrors aoa-runner.test.ts).
function ch(ret: unknown[]) {
  const c: any = {};
  c.values = () => c; c.set = () => c; c.where = () => c; c.from = () => c;
  c.returning = () => Promise.resolve(ret);
  c.then = (r: (v: unknown[]) => unknown) => Promise.resolve(ret).then(r);
  return c;
}

function dbForAgent(agent: Record<string, unknown>) {
  return {
    select: () => ch([agent]),
    insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: "run-p" }]) }) }),
    update: () => ch([{ id: "x" }]),
  } as any;
}

describe("runAoaAgent — thread presence feed (Tasks 5.1 + 5.2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callLog.length = 0;
    execMock.mockImplementation(async () => { callLog.push("execute"); return { exitCode: 0 }; });
    bundleMock.mockResolvedValue("");
  });

  it("thread run: adds presence with humanized activity BEFORE execute, removes in finally", async () => {
    const db = dbForAgent({ id: "scout-1", companyId: "co-1", name: "Scout", adapterType: "process", adapterConfig: {}, runtimeConfig: { aoa: { instruction: "Scout.", role: "scout" } } });

    await runAoaAgent(db, "scout-1", {
      companyId: "co-1",
      source: "thread.participation",
      threadId: "thread-77",
      mention: "@Scout what precedent applies?",
      effectiveAutonomy: 1,
    });

    // add called with (threadId, agentId, name, activity) — scout → "researching"
    expect(addMock).toHaveBeenCalledTimes(1);
    expect(addMock).toHaveBeenCalledWith("thread-77", "scout-1", "Scout", "researching");
    // remove called with (threadId, agentId)
    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(removeMock).toHaveBeenCalledWith("thread-77", "scout-1");
    // broadcast fired for the add AND the remove (≥2)
    expect(broadcastMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(broadcastMock).toHaveBeenCalledWith("co-1", "thread-77", expect.any(Number));

    // Ordering: add BEFORE execute BEFORE remove.
    expect(callLog).toEqual(["add:thread-77", "execute", "remove:thread-77"]);
  });

  it("removal is GUARANTEED in the finally even when the adapter THROWS", async () => {
    execMock.mockImplementationOnce(async () => { callLog.push("execute"); throw new Error("boom"); });
    const db = dbForAgent({ id: "eng-1", companyId: "co-1", name: "Engineer", adapterType: "process", adapterConfig: {}, runtimeConfig: { aoa: { instruction: "Engineer.", role: "engineer" } } });

    const result = await runAoaAgent(db, "eng-1", {
      companyId: "co-1",
      source: "thread.participation",
      threadId: "thread-99",
      mention: "@Engineer build it",
      effectiveAutonomy: 1,
    });

    // The run failed (adapter threw) — but presence was still added AND removed.
    expect(result.status).toBe("failed");
    expect(addMock).toHaveBeenCalledWith("thread-99", "eng-1", "Engineer", "creating an artifact");
    expect(removeMock).toHaveBeenCalledWith("thread-99", "eng-1");
    expect(callLog).toEqual(["add:thread-99", "execute", "remove:thread-99"]);
  });

  it("activity is humanized per role: planner → 'writing the plan'", async () => {
    const db = dbForAgent({ id: "plan-1", companyId: "co-1", name: "Planner", adapterType: "process", adapterConfig: {}, runtimeConfig: { aoa: { instruction: "Planner.", role: "planner" } } });
    await runAoaAgent(db, "plan-1", { companyId: "co-1", source: "thread.participation", threadId: "t-p", effectiveAutonomy: 1 });
    expect(addMock).toHaveBeenCalledWith("t-p", "plan-1", "Planner", "writing the plan");
  });

  it("activity is humanized per role: adjutant → 'reviewing the thread'", async () => {
    const db = dbForAgent({ id: "adj-1", companyId: "co-1", name: "Adjutant", adapterType: "process", adapterConfig: {}, runtimeConfig: { aoa: { instruction: "Adjutant.", role: "adjutant" } } });
    await runAoaAgent(db, "adj-1", { companyId: "co-1", source: "thread.participation", threadId: "t-a", effectiveAutonomy: 1 });
    expect(addMock).toHaveBeenCalledWith("t-a", "adj-1", "Adjutant", "reviewing the thread");
  });

  it("unknown role → activity falls back to 'typing'", async () => {
    const db = dbForAgent({ id: "misc-1", companyId: "co-1", name: "Mystery", adapterType: "process", adapterConfig: {}, runtimeConfig: { aoa: { instruction: "Mystery.", role: "mysteryrole" } } });
    await runAoaAgent(db, "misc-1", { companyId: "co-1", source: "thread.participation", threadId: "t-m", effectiveAutonomy: 1 });
    expect(addMock).toHaveBeenCalledWith("t-m", "misc-1", "Mystery", "typing");
  });

  it("background sweep run (source 'sweep.chronicler') does NOT light thread presence", async () => {
    // Thread-chat bug: the Chronicler's background summary sweep
    // (trigger_source = sweep.chronicler) carries a threadId but never POSTS to
    // the thread. Lighting presence for it surfaced a phantom "Chronicler is
    // typing…" pill. Presence must be gated to CONVERSATIONAL runs — any
    // `sweep.*` source skips the presence add entirely (and so the symmetric
    // finally-remove also no-ops, since presenceThreadId was never set).
    const db = dbForAgent({ id: "chron-1", companyId: "co-1", name: "Chronicler", adapterType: "process", adapterConfig: {}, runtimeConfig: { aoa: { instruction: "Chronicler.", role: "chronicler" } } });

    await runAoaAgent(db, "chron-1", {
      companyId: "co-1",
      source: "sweep.chronicler",
      threadId: "thread-sweep",
      effectiveAutonomy: 1,
    });

    expect(addMock).not.toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
    expect(callLog).toEqual(["execute"]);
  });

  it("conversational thread run (source 'thread.controller') DOES light thread presence", async () => {
    // Counterpart to the sweep gate above: a real conversational dispatch
    // (thread.controller / thread.participation / mention / agent.dispatch)
    // still lights the pill. Here the Adjutant runs the thread controller.
    const db = dbForAgent({ id: "adj-2", companyId: "co-1", name: "Adjutant", adapterType: "process", adapterConfig: {}, runtimeConfig: { aoa: { instruction: "Adjutant.", role: "adjutant" } } });

    await runAoaAgent(db, "adj-2", {
      companyId: "co-1",
      source: "thread.controller",
      threadId: "thread-ctrl",
      effectiveAutonomy: 1,
    });

    expect(addMock).toHaveBeenCalledTimes(1);
    expect(addMock).toHaveBeenCalledWith("thread-ctrl", "adj-2", "Adjutant", "reviewing the thread");
    expect(removeMock).toHaveBeenCalledWith("thread-ctrl", "adj-2");
    expect(callLog).toEqual(["add:thread-ctrl", "execute", "remove:thread-ctrl"]);
  });

  it("NON-thread run (entry-only extraction) does NOT touch thread presence", async () => {
    const db = dbForAgent({ id: "scribe-1", companyId: "co-1", name: "Scribe", adapterType: "process", adapterConfig: {}, runtimeConfig: { aoa: { instruction: "Scribe.", role: "scribe" } } });

    await runAoaAgent(db, "scribe-1", {
      companyId: "co-1",
      source: "discussion_entry_pending",
      entryId: "entry-1",
    });

    expect(addMock).not.toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
    expect(callLog).toEqual(["execute"]);
  });

  it("humanizedActivityForRole maps the four crew roles + a default", () => {
    expect(humanizedActivityForRole("scout")).toBe("researching");
    expect(humanizedActivityForRole("planner")).toBe("writing the plan");
    expect(humanizedActivityForRole("engineer")).toBe("creating an artifact");
    expect(humanizedActivityForRole("adjutant")).toBe("reviewing the thread");
    expect(humanizedActivityForRole("anything-else")).toBe("typing");
  });
});
