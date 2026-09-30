/**
 * Phase G4.1 — Integration tests for the thread pipeline wiring.
 *
 * Scope (pragmatic — see plan): exercise the boundaries between
 *   thread-events listener → wakeup queue → dispatcher → adjutant runs
 * with mocked LLM/adapter outputs and Proxy-backed DB stubs. We do NOT
 * run the full discuss → scope → assign flow end-to-end (that needs the
 * embedded-postgres harness + agent subprocesses; the only test that
 * does so is `aoa-backend.integration.test.ts`, skipped on Windows and
 * gated on CI only).
 *
 * What this file covers:
 *   - human entry → debounce → Adjutant wakeup with dedupKey + hopCount=0
 *   - rapid human entries to the same thread dedupe to ONE wakeup row
 *   - thread phase advance → wakeups queued for phase-advance-trigger agents
 *     (Planner on scope, Dispatcher on assign), with correct payload + role
 *   - hopCount stamping: human-triggered = 0, agent-triggered = ≥1
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { drizzleOperatorStubs } from "../helpers/drizzle-mock.js";

vi.mock("drizzle-orm", () => drizzleOperatorStubs());

vi.mock("../../middleware/logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

import {
  createThreadEventListener,
  MAX_HOP_COUNT,
  type ThreadEventListener,
} from "../../services/thread-events.js";

// ---------------------------------------------------------------------------
// Sequence DB harness — mirrors thread-events.test.ts so we capture both
// .select() rows (in order) AND .insert() values + onConflict flags.
// ---------------------------------------------------------------------------

type MockRow = Record<string, unknown>;

interface InsertCall {
  values: Record<string, unknown>;
  tableName?: string;
  onConflictDoNothing: boolean;
  returning: boolean;
}

interface SequenceDbConfig {
  selects?: MockRow[][];
  inserts?: MockRow[][];
}

function tableNameOf(value: unknown): string | undefined {
  if (value && typeof value === "object") {
    const meta = (value as Record<string, unknown>)["_"];
    if (meta && typeof meta === "object") {
      const name = (meta as Record<string, unknown>).name;
      if (typeof name === "string") return name;
    }
  }
  return undefined;
}

function createSequenceDb(config: SequenceDbConfig = {}) {
  let selectIdx = 0;
  let insertIdx = 0;
  const selects = config.selects ?? [];
  const inserts = config.inserts ?? [];
  const insertCalls: InsertCall[] = [];

  function makeSelectChain(): any {
    const chain: any = {};
    for (const m of ["from", "where", "innerJoin", "leftJoin", "orderBy", "limit"]) {
      chain[m] = (..._args: unknown[]) => chain;
    }
    chain.then = (resolve: (v: MockRow[]) => unknown) =>
      Promise.resolve(resolve(selects[selectIdx++] ?? []));
    return chain;
  }

  function makeInsertChain(tableName?: string): any {
    const idx = insertIdx++;
    const call: InsertCall = {
      values: {},
      tableName,
      onConflictDoNothing: false,
      returning: false,
    };
    insertCalls.push(call);

    const chain: any = {
      values: (v: Record<string, unknown>) => {
        call.values = v;
        return chain;
      },
      onConflictDoNothing: () => {
        call.onConflictDoNothing = true;
        return chain;
      },
      returning: (..._args: unknown[]) => {
        call.returning = true;
        return chain;
      },
      then: (resolve: (v: MockRow[]) => unknown) =>
        Promise.resolve(resolve(inserts[idx] ?? [])),
    };
    return chain;
  }

  return {
    select: (..._args: unknown[]) => makeSelectChain(),
    insert: (table: unknown) => makeInsertChain(tableNameOf(table)),
    insertCalls,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const COMPANY_ID = "co-integration";
const THREAD_ID = "thread-pipeline-1";
const ADJUTANT_ID = "adj-pipeline-1";

function activeThreadRow(overrides: Partial<MockRow> = {}): MockRow {
  return {
    id: THREAD_ID,
    companyId: COMPANY_ID,
    crewPaused: false,
    adjutantEnabled: true,
    // Task 3.2 — proactive wake is Assist+ only. These pipeline tests assert the
    // proactive Adjutant wake PROCEEDS (debounce → dedup'd wakeup), so the thread
    // dial is Assist (1): thread.autonomyLevel != null ⇒ fireAdjutantWakeup uses it
    // directly and never fetches internal_agent_config, so the existing select
    // sequence is unchanged. Manual-suppression is covered in proactive-wake-dial.test.ts.
    autonomyLevel: 1,
    ...overrides,
  };
}

function happyAdjutantSelects(): MockRow[][] {
  return [
    [activeThreadRow()],          // discussions row (re-checked at fire time)
    [{ id: ADJUTANT_ID }],        // agents (Adjutant)
  ];
}

function humanEntry(overrides: Partial<{
  id: string;
  discussionId: string;
  authorAgentId: string | null;
  inputType: string;
  createdBy: string;
}> = {}) {
  return {
    id: "entry-pipeline-1",
    discussionId: THREAD_ID,
    authorAgentId: null,
    inputType: "write",
    createdBy: "user-1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests — listener → wakeup queue wiring
// ---------------------------------------------------------------------------

describe("integration: thread pipeline wiring", () => {
  let listener: ThreadEventListener | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    if (listener) {
      listener.shutdown();
      listener = null;
    }
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("human entry → 30s debounce → Adjutant wakeup with correct dedupKey + hopCount=0", async () => {
    const db = createSequenceDb({
      selects: happyAdjutantSelects(),
      inserts: [[{ id: "wakeup-1" }]],
    });
    listener = createThreadEventListener(db as any);

    await listener.onEntryCreated(humanEntry());
    await vi.advanceTimersByTimeAsync(30_000);
    // Flush queued microtasks — the timer callback chains an async path.
    await Promise.resolve();
    await Promise.resolve();

    expect(db.insertCalls).toHaveLength(1);
    const call = db.insertCalls[0];
    expect(call.tableName).toBe("agent_wakeup_requests");
    expect(call.onConflictDoNothing).toBe(true);
    expect(call.values).toMatchObject({
      companyId: COMPANY_ID,
      agentId: ADJUTANT_ID,
      source: "thread.event",
      reason: "human_entry_debounce",
      status: "queued",
      dedupKey: `${ADJUTANT_ID}:${THREAD_ID}:queued`,
    });
    // hopCount=0 because this wakeup is human-originated; the cap only
    // counts agent→agent edges, not the initial human→Adjutant edge.
    expect(call.values.payload).toMatchObject({
      threadId: THREAD_ID,
      hopCount: 0,
    });
  });

  it("two rapid human entries within the debounce window dedupe to ONE wakeup row", async () => {
    const db = createSequenceDb({
      selects: happyAdjutantSelects(),
      inserts: [[{ id: "wakeup-coalesced" }]],
    });
    listener = createThreadEventListener(db as any);

    // Two posts only 2s apart — the second resets the debounce timer.
    await listener.onEntryCreated(humanEntry({ id: "rapid-1" }));
    await vi.advanceTimersByTimeAsync(2_000);
    await listener.onEntryCreated(humanEntry({ id: "rapid-2" }));

    // Inside the window — nothing should have queued yet.
    await vi.advanceTimersByTimeAsync(25_000);
    expect(db.insertCalls).toHaveLength(0);

    // Cross the 30s boundary measured from the second entry.
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.resolve();
    await Promise.resolve();

    // Exactly ONE wakeup row was inserted — the listener's in-process
    // debounce coalesces; the DB-side partial unique index on dedupKey is
    // the second-line of defense (.onConflictDoNothing()) for clustered
    // dispatch.
    expect(db.insertCalls).toHaveLength(1);
    expect(db.insertCalls[0].values.dedupKey).toBe(
      `${ADJUTANT_ID}:${THREAD_ID}:queued`,
    );
  });

  it("agent-authored entry does NOT queue a wakeup (cascade firewall)", async () => {
    const db = createSequenceDb({ selects: happyAdjutantSelects() });
    listener = createThreadEventListener(db as any);

    await listener.onEntryCreated(
      humanEntry({ authorAgentId: "agent-x", inputType: "agent" }),
    );
    await vi.advanceTimersByTimeAsync(40_000);

    // Listener swallows agent/system/scope_proposal — no insert.
    expect(db.insertCalls).toHaveLength(0);
  });

  it("re-checks thread.crewPaused at fire time (toggle mid-debounce is honored)", async () => {
    const db = createSequenceDb({
      // Only ONE select stage. If the listener tried to query the Adjutant
      // it would consume an empty stage; we assert it bailed before that.
      selects: [[activeThreadRow({ crewPaused: true })]],
    });
    listener = createThreadEventListener(db as any);

    await listener.onEntryCreated(humanEntry());
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    await Promise.resolve();

    expect(db.insertCalls).toHaveLength(0);
  });

  // ── hopCount stamping ────────────────────────────────────────────────────

  it("dispatchMention from human-originated context (hopCount=0) stamps stored hopCount=1", async () => {
    const db = createSequenceDb({
      // dispatchMention selects the target agent's companyId once.
      selects: [[{ companyId: COMPANY_ID }]],
      inserts: [[{ id: "wakeup-mention" }]],
    });
    listener = createThreadEventListener(db as any);

    const result = await listener.dispatchMention({
      agentId: "agent-target",
      threadId: THREAD_ID,
      entryId: "entry-mention",
      currentHopCount: 0,
    });

    expect(result.blocked).toBe(false);
    expect(result.wakeupId).toBe("wakeup-mention");
    expect(db.insertCalls).toHaveLength(1);
    const v = db.insertCalls[0].values as Record<string, unknown>;
    expect(v.source).toBe("thread.mention");
    expect(v.reason).toBe("agent_mentioned");
    expect((v.payload as Record<string, unknown>).hopCount).toBe(1);
    expect(v.dedupKey).toBe(`agent-target:${THREAD_ID}:queued`);
  });

  it("dispatchMention at currentHopCount=MAX_HOP_COUNT returns blocked + no insert", async () => {
    const db = createSequenceDb({
      // Even if we configured selects + inserts, the listener must short-
      // circuit BEFORE either is consumed.
      selects: [[{ companyId: COMPANY_ID }]],
      inserts: [[{ id: "should-not-be-used" }]],
    });
    listener = createThreadEventListener(db as any);

    const result = await listener.dispatchMention({
      agentId: "agent-target",
      threadId: THREAD_ID,
      entryId: "entry-mention",
      currentHopCount: MAX_HOP_COUNT,
    });

    expect(result.blocked).toBe(true);
    expect(result.wakeupId).toBeNull();
    expect(db.insertCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests — phase advance does NOT emit legacy wakeups (work=task model)
// ---------------------------------------------------------------------------
//
// SUPERSEDED by work=task redesign (Task 2.6 + 2.7):
//   - The Dispatcher role is retired (Task 2.7). crew-task-service is now the
//     sole creator of crew work.
//   - The Planner is now a normal crew worker: the Adjutant proposes a
//     "write the plan" task assigned to the Planner via propose_crew_work.
//     No special phase-advance trigger wires Planner on scope advance.
//   - advancePhase() at "assign" + L2 calls crew-task-service.approveAndDispatch
//     (the new path) — NOT agentWakeupRequests with source="phase-advance".
//
// These tests assert the ABSENCE of the retired pipeline.
// The new auto-approve behavior is covered by thread-advance-autoapprove.test.ts.

vi.mock("../../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));
vi.mock("../../services/goals.js", () => ({
  goalService: vi.fn(() => ({})),
}));
vi.mock("../../errors.js", () => ({
  notFound: (m: string) => Object.assign(new Error(m), { status: 404 }),
  badRequest: (m: string) => Object.assign(new Error(m), { status: 400 }),
  forbidden: (m: string) => Object.assign(new Error(m), { status: 403 }),
}));

// crew-task-service is dynamically imported inside advancePhase for the "assign"
// target. Mock it so the L2 auto-approve path doesn't blow up in unit tests.
vi.mock("../../services/crew-task-service.js", () => ({
  crewTaskService: vi.fn(() => ({
    approveAndDispatch: vi.fn().mockResolvedValue({ approved: true, createdIssueIds: [] }),
    proposeWork: vi.fn(),
  })),
  resolveCreationGate: vi.fn(() => "await_human"),
}));

// Phase-advance tests need a wider mock surface (drizzle ops + the threads
// service's table imports). The second vi.mock() call for the same module
// overrides the first, so this factory must include the tables the listener
// tests above also need (agents, agentWakeupRequests, discussions) AND
// preserve the `_` table-name metadata that tableNameOf() reads in the
// listener-side sequence DB. Also includes memoryItems + goals + projects
// which threads.ts transitively imports via memory.ts / embeddings.ts.
vi.mock("@armyofagents/db", () => {
  const t = (n: string) =>
    new Proxy(
      {},
      {
        get: (_x, p) => {
          // Preserve table-name metadata for the listener-side sequence DB.
          if (p === "_") return { name: n };
          if (p === "$inferSelect" || p === "$inferInsert") return {};
          return typeof p === "string" ? `${n}.${p}` : undefined;
        },
      },
    );
  return {
    discussions: t("discussions"),
    discussionEntries: t("discussion_entries"),
    agents: t("agents"),
    aoaAgentTriggers: t("aoa_agent_triggers"),
    agentWakeupRequests: t("agent_wakeup_requests"),
    activityLog: t("activity_log"),
    userRoles: t("user_roles"),
    authUsers: t("auth_users"),
    companyMemberships: t("company_memberships"),
    notifications: t("notifications"),
    threadParticipants: t("thread_participants"),
    threadLinks: t("thread_links"),
    discussionExtractedItems: t("discussion_extracted_items"),
    scopeItemDependencies: t("scope_item_dependencies"),
    taskDependencies: t("task_dependencies"),
    issues: t("issues"),
    threadPlanSteps: t("thread_plan_steps"),
    memoryItems: t("memory_items"),
    goals: t("goals"),
    projects: t("projects"),
    internalAgentConfig: t("internal_agent_config"),
  };
});

import { threadService } from "../../services/threads.js";

const PHASE_ACTOR = { userId: "user-pipeline", isHuman: true, role: "founder" as const };

const THREAD_ROW = {
  id: THREAD_ID,
  phase: "discuss",
  companyId: COMPANY_ID,
  ownerUserId: null,
  visibility: "company_members",
  scopeType: null,
  scopeId: null,
  autonomyLevel: null,
  useControllerPath: false,
};

function buildPhaseAdvanceDb(selectResults: Array<unknown[]>) {
  let selectCallIdx = 0;

  // Track any inserts so we can assert they are absent.
  const capturedInserts: unknown[] = [];
  const insertValuesMock = vi.fn().mockImplementation((vals: unknown) => {
    capturedInserts.push(vals);
    return Promise.resolve([{ id: "w-pipeline" }]);
  });
  const insertMock = vi.fn().mockReturnValue({ values: insertValuesMock });

  const updateSetMock = vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue([{ id: THREAD_ID }]),
  });
  const updateMock = vi.fn().mockReturnValue({ set: updateSetMock });

  const selectMock = vi.fn().mockImplementation(() => {
    const idx = selectCallIdx++;
    const result = selectResults[idx] ?? [];
    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: vi.fn().mockImplementation((cb: (r: unknown[]) => unknown) =>
            Promise.resolve(cb(result)),
          ),
          limit: vi.fn().mockReturnValue({
            then: vi.fn().mockImplementation((cb: (r: unknown[]) => unknown) =>
              Promise.resolve(cb(result)),
            ),
          }),
        }),
        then: vi.fn().mockImplementation((cb: (r: unknown[]) => unknown) =>
          Promise.resolve(cb(result)),
        ),
      }),
    };
  });

  return { select: selectMock, update: updateMock, insert: insertMock, capturedInserts };
}

describe("integration: phase advance — legacy Planner/Dispatcher wakeups are NOT emitted (work=task model)", () => {
  beforeEach(() => {
    vi.useRealTimers(); // these tests don't use fake timers
    vi.clearAllMocks();
  });

  // Regression: the OLD pipeline inserted agentWakeupRequests with
  // source="phase-advance" when discuss→scope fired (waking the Planner).
  // That pipeline is gone. advancePhase() must NOT insert any wakeup rows
  // on scope advance — not via aoaAgentTriggers, not directly.
  it("discuss → scope: NO agentWakeupRequests insert (Planner wakeup pipeline retired)", async () => {
    const db = buildPhaseAdvanceDb([
      [THREAD_ROW],   // fetch thread row
      // Old pipeline: would have queried aoaAgentTriggers here. Gone.
    ]);

    await threadService(db as never).advancePhase(
      COMPANY_ID,
      THREAD_ID,
      "scope",
      PHASE_ACTOR,
    );

    // crewTaskService is mocked → no real insert. The legacy path would have
    // called db.insert(agentWakeupRequests) directly. Assert it did not.
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.capturedInserts).toHaveLength(0);
  });

  // Regression: the OLD pipeline inserted agentWakeupRequests with
  // source="phase-advance" when scope→assign fired (waking the Dispatcher).
  // Dispatcher is retired. advancePhase() for "assign" at L0/L1 must NOT
  // insert any phase-advance wakeup rows.
  it("scope → assign (L0, await_human): NO legacy Dispatcher wakeup insert", async () => {
    const SCOPE_THREAD = { ...THREAD_ROW, phase: "scope", autonomyLevel: 0 };
    const db = buildPhaseAdvanceDb([
      [SCOPE_THREAD],         // fetch thread row
      [{ autonomyLevel: 0 }], // company config fetch (thread L0 wins; gate → await_human, no insert)
    ]);

    await threadService(db as never).advancePhase(
      COMPANY_ID,
      THREAD_ID,
      "assign",
      PHASE_ACTOR,
    );

    expect(db.insert).not.toHaveBeenCalled();
    expect(db.capturedInserts).toHaveLength(0);
  });

  it("phase result contains the new phase regardless of which pipeline runs", async () => {
    const db = buildPhaseAdvanceDb([[THREAD_ROW]]);

    const result = await threadService(db as never).advancePhase(
      COMPANY_ID,
      THREAD_ID,
      "scope",
      PHASE_ACTOR,
    );

    expect(result).toMatchObject({ id: THREAD_ID, phase: "scope" });
  });
});
