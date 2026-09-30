// Spec B Task 7 — crew-task executor END-TO-END COMPOSITION FENCE.
//
// THE CHAIN (from the plan):
//   assign a task to a crew (kind='aoa') agent at Drive autonomy
//     → the Spec A chokepoint `enqueueIssueAssigneeWakeup` resolves kind='aoa'
//       and enqueues an agent_wakeup_requests row carrying { issueId, role }
//       (NOT a heartbeat.skipped.aoa_kind drop)
//     → the dispatcher reads that row's `payload` column and spreads it into the
//       runAoaAgent call (dispatcher.ts:555-566 — `...(w.payload ?? {})`)
//     → `runAoaAgent` sees `payload.issueId` and CHECKS OUT the task
//       (todo/backlog/in_progress → in_progress, executionRunId=runId via
//       checkout(issueId, agentId, ["todo","backlog","in_progress"], runId))
//       and stamps the run row relatedEntityType:"task" (Task 5 vocabulary — NOT
//       "issue", which is not in the column enum).
//
// WHY A TWO-SEAM COMPOSITION TEST (not one run through the real dispatcher):
//   The per-seam behavior is ALREADY proven —
//     • Spec A chokepoint:  issue-assignee-wakeup.test.ts  (crew assign → aoa
//       wakeup payload with issueId + role, NOT heartbeat).
//     • Task 5 runner:      aoa-runner-task-execution.test.ts  (payload.issueId →
//       checkout + relatedEntityType "task").
//   The dispatcher's drain harness (makeConcurrencyDb / makeSeqDb in
//   aoa-dispatcher.test.ts et al.) is a positional-sequence mock — driving a
//   FULL real-dispatcher tick from a crew assignment through to runAoaAgent
//   would mean threading that fragile sequence db, and is explicitly out of
//   scope per the plan's pragmatic latitude. Instead this E2E proves the
//   COMPOSITION: the two seams agree on the SAME payload shape. We capture the
//   EXACT payload the chokepoint hands the wakeup-enqueue, reproduce the
//   dispatcher's literal `{ companyId, source, wakeupId, ...payload }` spread
//   (the only transform between the row and the runner), and feed THAT into the
//   real runAoaAgent. If the chokepoint ever stopped stamping `issueId`/`role`,
//   or the runner ever stopped honoring `payload.issueId`, this fence REDs.
//
// HARNESS: reuses BOTH existing styles verbatim, in one file —
//   • the runner dependency surface + proxy-table + hoisted-mock + `_sets`-
//     recording db from aoa-runner-task-execution.test.ts (seam 2), and
//   • the chokepoint mocks (heartbeat / resolve-crew-role) from
//     issue-assignee-wakeup.test.ts (seam 1).
//   Both seams reach the issue surface through the SAME `../services/issues.js`
//   module, so ONE issueService mock exposes all four methods the two seams use
//   (resolveAgentKinds + enqueueAoaMentionWakeup for seam 1; checkout + getById
//   for seam 2). vitest resolves the runner's dynamic `import("../../issues.js")`
//   and the chokepoint's static `import` to the same mocked module. Windows-runnable.

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  // seam 1 (chokepoint) spies
  resolveAgentKindsMock,
  enqueueAoaWakeupMock,
  heartbeatWakeupMock,
  resolveCrewRoleMock,
  // seam 2 (runner) spies — names mirror aoa-runner-task-execution.test.ts
  writeFileMock,
  unlinkMock,
  adapterExecute,
  createEventMock,
  buildMcpMock,
  buildBridgeSpecMock,
  publishLiveEventMock,
  checkoutMock,
  getByIdMock,
} = vi.hoisted(() => ({
  resolveAgentKindsMock: vi.fn(),
  enqueueAoaWakeupMock: vi.fn().mockResolvedValue(undefined),
  heartbeatWakeupMock: vi.fn().mockResolvedValue(undefined),
  resolveCrewRoleMock: vi.fn(),
  writeFileMock: vi.fn().mockResolvedValue(undefined),
  unlinkMock: vi.fn().mockResolvedValue(undefined),
  adapterExecute: vi.fn().mockResolvedValue({ exitCode: 0 }),
  createEventMock: vi.fn().mockResolvedValue(undefined),
  buildMcpMock: vi.fn(() => ({})),
  buildBridgeSpecMock: vi.fn(() => ({
    command: "node",
    args: ["/bridge.js"],
    env: { AOA_SESSION_COMPANY_ID: "c" },
  })),
  publishLiveEventMock: vi.fn(),
  checkoutMock: vi.fn().mockResolvedValue({ id: "TASK-1", status: "in_progress" }),
  getByIdMock: vi.fn().mockResolvedValue(null),
}));

// T5: the runner now resolves an execution workspace before adapter.execute,
// which mkdir's the per-agent home and stat's candidate cwds through this same
// mocked module. `workspace-resolution.ts` imports the DEFAULT export, the
// runner the named writeFile/unlink — provide both shapes.
vi.mock("node:fs/promises", () => {
  const api = {
    writeFile: writeFileMock,
    unlink: unlinkMock,
    mkdir: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
  };
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
    // T5: reached by the runner's execution-workspace resolution.
    projects: makeTable("projects"),
    projectWorkspaces: makeTable("project_workspaces"),
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

// Chokepoint (seam 1) routes org assignees through heartbeat; runner (seam 2)
// reaches heartbeat.resolveAdapterExecutionContextUnguarded. ONE mock serves both.
vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: () => ({ wakeup: heartbeatWakeupMock }),
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

// T1: the runner opens a run transcript before adapter.execute. run-log-store
// imports `node:fs` — a DIFFERENT specifier than the `node:fs/promises` this
// file mocks — so without this an otherwise fully-mocked suite does REAL
// filesystem I/O, writing .ndjson files keyed on fixture ids that repeat across
// test files. vitest runs files in parallel workers and begin() TRUNCATES, so
// that is a latent cross-file flake, not just litter.
// T5: crew workspace resolution reads the instance experimental flags. Without
// this stub the access THROWS and the resolver's tolerant catch absorbs it —
// the suite would then only ever exercise the failure branch, and the fs/table
// stubs above would be dead.
vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: vi.fn(() => ({
    getExperimental: vi.fn().mockResolvedValue({ enableIsolatedWorkspaces: true }),
  })),
}));

vi.mock("../services/run-log-store.js", () => ({
  getRunLogStore: () => ({
    begin: async () => ({ store: "local_file", logRef: "test-run.ndjson" }),
    append: async () => {},
    finalize: async () => ({ bytes: 0, compressed: false }),
    read: async () => ({ content: "" }),
  }),
}));

vi.mock("../services/internal-agent/aoa-agents/resolve-crew-role.js", () => ({
  resolveCrewRole: resolveCrewRoleMock,
}));

vi.mock("../services/costs.js", () => ({
  costService: vi.fn(() => ({ createEvent: createEventMock })),
}));

vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: publishLiveEventMock,
  // Phase 5: runner.ts imports these too. Stubbed so the (no-threadId) task
  // chain never calls an undefined export.
  publishIssueStatusChanged: vi.fn(),
  threadWorkingAgents: { add: vi.fn(), remove: vi.fn(() => []), list: vi.fn(() => []) },
  broadcastThreadPresence: vi.fn(),
}));

// SINGLE issue-surface mock for BOTH seams. The chokepoint (static import) uses
// resolveAgentKinds + enqueueAoaMentionWakeup; the runner (dynamic import) uses
// checkout + getById. vitest resolves both specifiers to this one module.
vi.mock("../services/issues.js", () => ({
  issueService: () => ({
    resolveAgentKinds: resolveAgentKindsMock,
    enqueueAoaMentionWakeup: enqueueAoaWakeupMock,
    checkout: checkoutMock,
    getById: getByIdMock,
  }),
}));

// P4: the runner resolves provider credentials (dynamic import). Production
// self-hosted misses return host_login_fallback (no throw); this mock db doesn't
// stub the provider_connections query, so the unmocked resolver would throw and
// fail the run. Mock to the no-op override (mirrors aoa-runner.test.ts:68).
vi.mock("../services/provider-resolution.js", () => ({
  resolveProviderCredential: vi.fn(async () => ({ source: "agent_env_override" })),
  applyResolvedCredential: (config: unknown) => config,
  toExecutionTargetHint: () => ({ credentialKind: null, executionTargetSlug: null }),
}));

vi.mock("../middleware/logger.js", () => {
  function makeLogger(): any {
    const l: any = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    l.child = () => makeLogger();
    return l;
  }
  return { logger: makeLogger() };
});

import { enqueueIssueAssigneeWakeup } from "../services/issue-assignee-wakeup.js";
import { runAoaAgent } from "../services/internal-agent/aoa-agents/runner.js";

// Db harness identical in shape to aoa-runner-task-execution.test.ts: records
// every insert().values() + update().set()/where() into `_sets`. For a task
// wakeup the runner only db.select()s once (the agent row); all issue access
// goes through the MOCKED issueService.
function makeRunnerDb() {
  const agentRow = {
    id: "a-crew",
    companyId: "co",
    name: "Engineer",
    adapterType: "process",
    runtimeConfig: { aoa: { role: "engineer" } },
    adapterConfig: {},
  };
  const sets: any[] = [];
  const db: any = {
    _sets: sets,
    select: () => {
      const c: any = {};
      c.from = () => c;
      c.where = () => c;
      c.then = (resolve: (v: unknown[]) => unknown) =>
        Promise.resolve([agentRow]).then(resolve);
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
        p.returning = () => Promise.resolve([]);
        p.catch = (cb: any) => Promise.resolve().catch(cb);
        return p;
      };
      return u;
    },
  };
  return db;
}

describe("Spec B Task 7: crew-task executor E2E composition fence", () => {
  beforeEach(() => {
    resolveAgentKindsMock.mockReset();
    enqueueAoaWakeupMock.mockReset().mockResolvedValue(undefined);
    heartbeatWakeupMock.mockReset().mockResolvedValue(undefined);
    resolveCrewRoleMock.mockReset();
    writeFileMock.mockClear().mockResolvedValue(undefined);
    unlinkMock.mockClear().mockResolvedValue(undefined);
    adapterExecute.mockClear().mockResolvedValue({ exitCode: 0 });
    createEventMock.mockClear().mockResolvedValue(undefined);
    buildMcpMock.mockClear().mockReturnValue({});
    publishLiveEventMock.mockClear();
    checkoutMock.mockClear().mockResolvedValue({ id: "TASK-1", status: "in_progress" });
    // Default getById → a task the agent already moved forward, so the runner's
    // silent-stuck guard is a no-op (status not in_progress). The happy-path
    // composition test does not exercise the guard.
    getByIdMock.mockClear().mockResolvedValue({
      id: "TASK-1",
      status: "in_review",
      executionRunId: "run-1",
    });
  });

  // The seam the dispatcher owns between the wakeup ROW and the runner is a
  // single object spread (dispatcher.ts:555-566). We reproduce it EXACTLY so the
  // composition mirrors production wire, not a hand-built payload.
  function dispatcherSpread(
    row: { companyId: string; agentId: string; source: string | null | undefined; id: string; payload: unknown },
  ) {
    return {
      companyId: row.companyId,
      source: row.source as string,
      wakeupId: row.id,
      ...((row.payload ?? {}) as Record<string, unknown>),
    };
  }

  it("FULL CHAIN: crew assignment → wakeup payload {issueId,role} → runner checkout + run row relatedEntityType 'task'", async () => {
    // ── SEAM 1: the Spec A chokepoint. A kind='aoa' assignee at Drive autonomy.
    resolveAgentKindsMock.mockResolvedValue(new Map([["a-crew", "aoa"]]));
    resolveCrewRoleMock.mockResolvedValue("engineer");

    await enqueueIssueAssigneeWakeup({} as any, {
      companyId: "co",
      agentId: "a-crew",
      issueId: "TASK-1",
      source: "assignment",
      reason: "issue_assigned",
      mutation: "create",
    });

    // It enqueued an AoA wakeup (NOT a heartbeat — no heartbeat.skipped.aoa_kind
    // drop, no dual heartbeat_run).
    expect(heartbeatWakeupMock).not.toHaveBeenCalled();
    expect(enqueueAoaWakeupMock).toHaveBeenCalledTimes(1);

    // Capture the EXACT (companyId, agentId, opts) the chokepoint handed the
    // enqueue. `opts.payload` is verbatim what lands in the wakeup row's
    // `payload` column (issues.ts enqueueAoaMentionWakeup inserts it as-is).
    const [enqCompanyId, enqAgentId, enqOpts] = enqueueAoaWakeupMock.mock.calls[0];
    expect(enqCompanyId).toBe("co");
    expect(enqAgentId).toBe("a-crew");
    const wakeupPayload = (enqOpts as { payload: Record<string, unknown> }).payload;

    // The contract seam 2 depends on: the row carries issueId + role.
    expect(wakeupPayload).toMatchObject({ issueId: "TASK-1", role: "engineer" });

    // ── WIRE: reproduce the dispatcher's literal spread of the row → runner.
    const runnerPayload = dispatcherSpread({
      companyId: "co",
      agentId: "a-crew",
      source: (enqOpts as { source?: string }).source,
      id: "wk-1",
      payload: wakeupPayload,
    });
    // The chokepoint's issueId + role survive the spread intact.
    expect(runnerPayload.issueId).toBe("TASK-1");
    expect(runnerPayload.role).toBe("engineer");

    // ── SEAM 2: feed THAT payload to the real runner (mocked adapter).
    const db = makeRunnerDb();
    const result = await runAoaAgent(db as any, "a-crew", runnerPayload as any);

    // (1) The run row was stamped relatedEntityType="task" (NOT "issue") with
    //     relatedEntityId = the chokepoint's issueId.
    const insertRow = db._sets.find((s: any) => s.insert)?.insert;
    expect(insertRow).toBeDefined();
    expect(insertRow.relatedEntityType).toBe("task");
    expect(insertRow.relatedEntityType).not.toBe("issue");
    expect(insertRow.relatedEntityId).toBe("TASK-1");

    // (2) The runner CHECKED OUT the task with the canonical claim signature,
    //     using the SAME issueId that originated at the chokepoint and the runId
    //     minted on the run-row insert.
    expect(checkoutMock).toHaveBeenCalledTimes(1);
    expect(checkoutMock).toHaveBeenCalledWith(
      "TASK-1",
      "a-crew",
      ["todo", "backlog", "in_progress"],
      "run-1",
    );

    // (3) The adapter ran (the agent got dispatched), and the run reports clean.
    expect(adapterExecute).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("succeeded");
  });

  it("PAYLOAD IDENTITY: the issueId the runner checks out is byte-for-byte the chokepoint's issueId", async () => {
    // Use a distinct id so a hardcoded "TASK-1" anywhere in the seam would FAIL
    // this — proves the value propagates rather than coinciding.
    const ISSUE_ID = "ISSUE-7f3c-distinct";
    resolveAgentKindsMock.mockResolvedValue(new Map([["a-crew", "aoa"]]));
    resolveCrewRoleMock.mockResolvedValue("scout");
    checkoutMock.mockResolvedValue({ id: ISSUE_ID, status: "in_progress" });
    getByIdMock.mockResolvedValue({ id: ISSUE_ID, status: "in_review", executionRunId: "run-1" });

    await enqueueIssueAssigneeWakeup({} as any, {
      companyId: "co",
      agentId: "a-crew",
      issueId: ISSUE_ID,
      source: "assignment",
      reason: "issue_assigned",
    });

    const enqPayload = (enqueueAoaWakeupMock.mock.calls[0][2] as { payload: Record<string, unknown> }).payload;
    expect(enqPayload.issueId).toBe(ISSUE_ID);

    const runnerPayload = dispatcherSpread({
      companyId: "co",
      agentId: "a-crew",
      source: "assignment",
      id: "wk-2",
      payload: enqPayload,
    });

    const db = makeRunnerDb();
    await runAoaAgent(db as any, "a-crew", runnerPayload as any);

    // The exact distinct id flowed chokepoint → wakeup payload → runner checkout.
    expect(checkoutMock).toHaveBeenCalledWith(
      ISSUE_ID,
      "a-crew",
      ["todo", "backlog", "in_progress"],
      "run-1",
    );
    const insertRow = db._sets.find((s: any) => s.insert)?.insert;
    expect(insertRow.relatedEntityId).toBe(ISSUE_ID);
    expect(insertRow.relatedEntityType).toBe("task");
  });

  it("NEGATIVE CONTROL: an org (kind!='aoa') assignee never reaches the crew runner — heartbeat path, no wakeup row", async () => {
    // Same entry point, different agent kind. The chokepoint must NOT enqueue an
    // AoA wakeup; it routes to heartbeat. This is the boundary that keeps org
    // agents off the crew executor — its violation would be a real regression.
    resolveAgentKindsMock.mockResolvedValue(new Map([["a-org", "org"]]));

    await enqueueIssueAssigneeWakeup({} as any, {
      companyId: "co",
      agentId: "a-org",
      issueId: "TASK-9",
      source: "assignment",
      reason: "issue_assigned",
    });

    expect(enqueueAoaWakeupMock).not.toHaveBeenCalled();
    expect(heartbeatWakeupMock).toHaveBeenCalledWith(
      "a-org",
      expect.objectContaining({ payload: expect.objectContaining({ issueId: "TASK-9" }) }),
    );
    // No crew runner involvement at all on the org path.
    expect(checkoutMock).not.toHaveBeenCalled();
  });
});
