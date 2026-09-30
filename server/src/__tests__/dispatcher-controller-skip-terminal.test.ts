// Task 1.1 — Terminalize the controller-path peer-wake skip (no orphaned `queued`).
//
// THE BUG (confirmed live: 1 stranded `queued` row): the AoA dispatcher's
// drainPhase3 has a defense-in-depth gate — when a peer-wake wakeup's thread row
// has `useControllerPath = true`, the orchestration controller owns that thread's
// conversation, so the peer-wake pipeline must NOT also run the agent. Pre-fix,
// the skip branch (`dispatcher.ts` ~:393) just `return`ed WITHOUT writing a
// terminal status, leaving the wakeup `queued` FOREVER — invisible, un-reaped,
// re-evaluated every tick.
//
// THE FIX: mirror the SIBLING skip branches (skipped_paused / skipped_autonomy /
// skipped_rate_limit / skipped_budget) — write a distinct terminal status
// (`skipped_controller_path` + `finishedAt`) BEFORE returning, so the wakeup
// table tells you WHY the wakeup ended and the row is reaped.
//
// Harness: VERBATIM the makeConcurrencyDb positional-sequence mock from
// aoa-dispatcher.test.ts (records `_sets` + `_selectOrder`; supports `.returning()`
// on update()). The controller-path skip is an EARLY return, so only the
// terminal write occurs and runAoaAgent is never reached.
//
// Select-slot order inside drainPhase3 for a controller-path thread-bearing
// wakeup (source 'thread_mention', threadId present):
//   0 Phase-1 orphan, 1 Phase-2 pending, 2 Phase-3 wakeup,
//   3 resolveCompanyConfig,
//   4 threadRow pause/controller lookup (fires: !inbox && !infra && threadId) →
//     crewPaused=false (not paused) + useControllerPath=true → SKIP here,
//   5 Phase-4 reclaim (after Promise.all).
// The skip fires BEFORE the effectiveAutonomy/brake/agent-row/claim selects.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { consumerMock, ensureExtractionMock, listOutboxMock, publishLiveEventMock, runAoaMock } =
  vi.hoisted(() => ({
    consumerMock: vi.fn().mockResolvedValue(undefined),
    ensureExtractionMock: vi.fn().mockResolvedValue("ext-1"),
    listOutboxMock: vi.fn().mockResolvedValue([]),
    publishLiveEventMock: vi.fn(),
    runAoaMock: vi.fn().mockResolvedValue(undefined),
  }));

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...a: unknown[]) => ({ and: a })),
  or: vi.fn((...a: unknown[]) => ({ or: a })),
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  lt: vi.fn((a: unknown, b: unknown) => ({ lt: [a, b] })),
  lte: vi.fn((a: unknown, b: unknown) => ({ lte: [a, b] })),
  gt: vi.fn((a: unknown, b: unknown) => ({ gt: [a, b] })),
  isNull: vi.fn((c: unknown) => ({ isNull: c })),
  inArray: vi.fn((c: unknown, v: unknown) => ({ inArray: [c, v] })),
  notInArray: vi.fn((c: unknown, v: unknown) => ({ notInArray: [c, v] })),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...vals: unknown[]) => ({
      sql: strings.join("?"),
      vals,
    }),
    {},
  ),
}));
vi.mock("@armyofagents/db", () => {
  const t = (n: string) =>
    new Proxy({} as Record<string, unknown>, {
      get: (_x, p) => (typeof p === "string" ? Symbol(`${n}.${p}`) : undefined),
    });
  return {
    discussionEntries: t("discussion_entries"),
    discussions: t("discussions"),
    internalAgentRuns: t("internal_agent_runs"),
    agentWakeupRequests: t("agent_wakeup_requests"),
    agents: t("agents"),
    internalAgentConfig: t("internal_agent_config"),
  };
});
// Autonomy gate mocked to always pass — irrelevant to this test (the
// controller-path skip fires BEFORE the autonomy gate is reached).
vi.mock("../services/internal-agent/aoa-agents/autonomy.js", () => ({
  isRoleActiveAtAutonomy: () => true,
  ROLE_MIN_AUTONOMY: {
    scribe: 0, memory_keeper: 0, curator: 0, router: 2, navigator: 2,
    planner: 2, dispatcher: 2, adjutant: 0, maker: 1, engineer: 1,
    scout: 1, chronicler: 0,
  },
}));
vi.mock("../services/internal-agent/aoa-agents/resolve-crew-role.js", () => ({
  resolveCrewRole: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/budgets.js", () => ({
  budgetService: () => ({ getInvocationBlock: vi.fn().mockResolvedValue(null) }),
}));
// IMPORTANT: kill-switch returns false (not paused) so execution reaches the
// useControllerPath branch — the gate under test — rather than short-circuiting
// at skipped_paused above it.
vi.mock("../services/internal-agent/aoa-agents/kill-switch.js", () => ({
  isCrewPaused: () => false,
}));
vi.mock("../services/internal-agent/cost-caps.js", () => ({
  runRateExceeded: () => false,
  resolveRoleModel: ({ companyDefault }: { roleModel: string | null; companyDefault: string }) => companyDefault,
  DEFAULT_CREW_RATE_LIMIT: { maxRunsPerWindow: 10, windowMinutes: 10 },
  DEFAULT_CREW_RUN_COUNT_LIMIT: { windowMinutes: 5, maxRunsPerWindow: 40 },
}));
vi.mock("../services/internal-agent/aoa-agents/runner.js", () => ({
  runAoaAgent: runAoaMock,
}));
vi.mock("../services/internal-agent/subagents/extraction-consumer.js", () => ({
  runExtractionConsumer: consumerMock,
}));
vi.mock("../services/internal-agent/aoa-agents/ensure-extraction-agent.js", () => ({
  ensureExtractionAgent: ensureExtractionMock,
}));
vi.mock("../services/internal-agent/aoa-agents/triggers.js", () => ({
  listEnabledOutboxAgents: listOutboxMock,
}));
vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: publishLiveEventMock,
}));
vi.mock("../middleware/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { runAoaDispatch } from "../services/internal-agent/aoa-agents/dispatcher.js";

// makeConcurrencyDb — VERBATIM the harness from aoa-dispatcher.test.ts. Records
// `_sets` (every update().set() payload) + the positional `_selectOrder`, and
// supports `.returning()` on update() for the atomic-claim path (unused here).
function makeConcurrencyDb(selectQueue: unknown[][], returningQueue: unknown[][]) {
  let si = 0;
  let ui = 0;
  const selectOrder: number[] = [];
  const sets: any[] = [];
  const db: any = {
    _sets: sets,
    _selectOrder: selectOrder,
    select: () => {
      const n = si++;
      selectOrder.push(n);
      const c: any = {};
      c.from = () => c;
      c.innerJoin = () => c;
      c.leftJoin = () => c;
      c.where = () => c;
      c.limit = () => c;
      c.then = (resolve: (v: unknown[]) => unknown) =>
        Promise.resolve(selectQueue[n] ?? []).then(resolve);
      return c;
    },
    update: () => ({
      set: (v: any) => {
        const idx = ui++;
        sets.push(v);
        const ret = returningQueue[idx] ?? [];
        return {
          where: () => ({
            returning: () => Promise.resolve(ret),
            then: (resolve: (x: unknown) => unknown) =>
              Promise.resolve(undefined).then(resolve),
          }),
        };
      },
    }),
  };
  return db;
}

const skippedControllerPath = (s: any) => s.status === "skipped_controller_path";

describe("runAoaDispatch — controller-path peer-wake skip is terminalized (Task 1.1)", () => {
  beforeEach(() => {
    consumerMock.mockClear();
    ensureExtractionMock.mockClear();
    listOutboxMock.mockClear();
    publishLiveEventMock.mockClear();
    runAoaMock.mockClear();
    runAoaMock.mockResolvedValue(undefined);
    listOutboxMock.mockResolvedValue([]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // THE FIX, asserted: a queued kind='aoa' peer-wake wakeup whose thread row has
  // useControllerPath=true is TERMINALIZED with status 'skipped_controller_path'
  // + finishedAt (not left 'queued'), and runAoaAgent is NOT called (the
  // controller owns the thread; the peer-wake pipeline stays dormant).
  it("controller-path thread wakeup → status 'skipped_controller_path' + finishedAt; runAoaAgent NOT called", async () => {
    const db = makeConcurrencyDb(
      [
        [], // 0 Phase-1 orphan-select
        [], // 1 Phase-2 pending-drain
        // 2 Phase-3 wakeup-select: a queued peer-wake on a controller-path thread.
        [{ id: "w-ctrl", agentId: "a-1", companyId: "co-1", source: "thread_mention", payload: { threadId: "th-controller", role: "scout" } }],
        // 3 resolveCompanyConfig
        [{ crewAutonomyLevel: 2, crewPaused: false, model: "claude-sonnet-4-6", inboundRoutingLevel: "off" }],
        // 4 threadRow pause/controller/effective-autonomy lookup: NOT paused, controller-path=true → SKIP here
        [{ crewPaused: false, useControllerPath: true, autonomyLevel: 2 }],
        // 5 Phase-4 reclaim-select (after Promise.all; the skip returns before any
        //   effectiveAutonomy / brake / agent-row / claim selects)
        [],
      ],
      [
        // No atomic claim — the controller-path skip is an early return; only the
        // skipped_controller_path write occurs (it does not use .returning()).
      ],
    );

    await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });

    // Terminalized: exactly the skipped_controller_path write for this wakeup id,
    // carrying a finishedAt Date (mirrors skipped_paused / skipped_autonomy / etc.).
    const skipSet = (db._sets as any[]).find(skippedControllerPath);
    expect(skipSet).toBeDefined();
    expect(skipSet.status).toBe("skipped_controller_path");
    expect(skipSet.finishedAt).toBeInstanceOf(Date);

    // The controller owns the thread — the peer-wake pipeline must NOT run the agent.
    expect(runAoaMock).not.toHaveBeenCalled();

    // No row was left un-terminalized as a side effect: the only write is the skip
    // (no atomic 'processing' claim, no 'succeeded'/'failed' final write).
    expect((db._sets as any[]).some((s) => s.status === "processing")).toBe(false);
    expect((db._sets as any[]).filter(skippedControllerPath)).toHaveLength(1);
  });

  // Negative control: a NON-controller-path thread wakeup is unaffected — it does
  // NOT receive a skipped_controller_path write (it proceeds down the normal
  // dispatch path and reaches runAoaAgent). Proves the new write is scoped to the
  // controller-path branch only and cannot regress legacy peer-wake threads.
  it("non-controller-path thread wakeup → NO skipped_controller_path write (dispatch proceeds)", async () => {
    const db = makeConcurrencyDb(
      [
        [], // 0 Phase-1 orphan
        [], // 1 Phase-2 pending
        // 2 Phase-3 wakeup: legacy thread (useControllerPath=false)
        [{ id: "w-legacy", agentId: "a-2", companyId: "co-2", source: "thread_mention", payload: { threadId: "th-legacy", role: "scout" } }],
        // 3 resolveCompanyConfig (Drive so the autonomy gate passes)
        [{ crewAutonomyLevel: 2, crewPaused: false, model: "claude-sonnet-4-6", inboundRoutingLevel: "off" }],
        // 4 threadRow/effectiveAutonomy lookup: NOT paused, controller-path=FALSE → no skip
        [{ crewPaused: false, useControllerPath: false, autonomyLevel: 2 }],
        // 5 D3 SPEND-brake count
        [],
        // 6 A5/T1.9 run-COUNT brake count
        [],
        // 7 agent-row model select
        [{ runtimeConfig: {}, adapterConfig: {} }],
        // 8 Phase-4 failed-run reclaim-select (after Promise.all)
        [],
      ],
      [
        [{ id: "w-legacy" }], // update[0] = atomic claim RETURNING (claimed)
        [],                    // update[1] = final status update
      ],
    );

    await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });

    // The legacy thread must NOT receive the controller-path terminal status.
    expect((db._sets as any[]).some(skippedControllerPath)).toBe(false);
    // It proceeds to dispatch (proves the branch is scoped correctly).
    expect(runAoaMock).toHaveBeenCalledWith(
      db,
      "a-2",
      expect.objectContaining({ companyId: "co-2", source: "thread_mention", wakeupId: "w-legacy" }),
    );
  });
});
