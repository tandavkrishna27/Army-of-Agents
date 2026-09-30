// Contract test for the dispatcher Phase-3 pre-spend budget hard-stop (A3).
//
// budgetService(db).getInvocationBlock(agentId, companyId) returns a human
// reason string when the agent/company hard-stop budget is exceeded, else null.
// Before A3 the dispatcher had NO pre-spend budget check: a wakeup whose agent
// was over budget would still pass the run-rate brake, get atomically claimed,
// and dispatch runAoaAgent — burning the very spend the hard-stop is meant to
// prevent. A3 inserts the check IMMEDIATELY BEFORE the atomic claim:
//   - blocked (reason string) → wakeup row set status='skipped_budget',
//     finishedAt set; runAoaAgent NOT called; no claim.
//   - clear (null)            → falls through to claim + runAoaAgent.
//
// Harness: the same makeConcurrencyDb used by aoa-dispatcher.test.ts (it
// supports .returning() on update(), needed for the atomic claim path).
//
// budgetService is MODULE-MOCKED so getInvocationBlock issues ZERO real
// db.select on budgetPolicies — a real call would shift the positional select
// sequence the harness depends on. The mock factory references a top-level var,
// so it must be created with vi.hoisted().
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetInvocationBlock } = vi.hoisted(() => ({
  mockGetInvocationBlock: vi.fn(),
}));
const { runAoaMock } = vi.hoisted(() => ({
  runAoaMock: vi.fn().mockResolvedValue(undefined),
}));

// A3: module-mock budgetService → its getInvocationBlock is the hoisted spy.
// No real budgetPolicies select is issued, so the positional select sequence
// below is unchanged.
vi.mock("../services/budgets.js", () => ({
  budgetService: () => ({ getInvocationBlock: mockGetInvocationBlock }),
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
vi.mock("../services/internal-agent/aoa-agents/autonomy.js", () => ({
  isRoleActiveAtAutonomy: () => true, // all roles active so we reach the budget check
  ROLE_MIN_AUTONOMY: {
    scribe: 0, memory_keeper: 0, curator: 0, router: 2, navigator: 2,
    planner: 2, dispatcher: 2, adjutant: 0, maker: 1, engineer: 1,
    scout: 1, chronicler: 0,
  },
}));
// resolveCrewRole → a valid role ("scout") so the autonomy gate passes and we
// reach the budget pre-flight. Module-mocked so it adds NO real db.select.
vi.mock("../services/internal-agent/aoa-agents/resolve-crew-role.js", () => ({
  resolveCrewRole: vi.fn().mockResolvedValue("scout"),
}));
vi.mock("../services/internal-agent/aoa-agents/kill-switch.js", () => ({
  isCrewPaused: () => false, // never paused → reach the budget check
}));
vi.mock("../services/internal-agent/cost-caps.js", () => ({
  runRateExceeded: () => false, // run-rate never exceeded → reach the budget check
  resolveRoleModel: ({ companyDefault }: { roleModel: string | null; companyDefault: string }) => companyDefault,
  DEFAULT_CREW_RATE_LIMIT: { maxRunsPerWindow: 10, windowMinutes: 10 },
  // A5: run-COUNT brake constant. runRateExceeded mocked → false so it never
  // fires; its select still runs (one extra slot AFTER the D3 spend-brake count)
  // before the budget pre-flight on both the blocked and clear paths.
  DEFAULT_CREW_RUN_COUNT_LIMIT: { windowMinutes: 5, maxRunsPerWindow: 40 },
}));
vi.mock("../services/internal-agent/aoa-agents/runner.js", () => ({
  runAoaAgent: runAoaMock,
}));
vi.mock("../services/internal-agent/subagents/extraction-consumer.js", () => ({
  runExtractionConsumer: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/internal-agent/aoa-agents/ensure-extraction-agent.js", () => ({
  ensureExtractionAgent: vi.fn().mockResolvedValue("ext-1"),
}));
vi.mock("../services/internal-agent/aoa-agents/triggers.js", () => ({
  listEnabledOutboxAgents: vi.fn().mockResolvedValue([]),
}));
vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));
vi.mock("../middleware/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { runAoaDispatch } from "../services/internal-agent/aoa-agents/dispatcher.js";

/**
 * makeConcurrencyDb — VERBATIM the harness from aoa-dispatcher.test.ts. Select
 * results are returned in positional order; update().set(v) pushes `v` into
 * `_sets` so we can assert which writes were issued; .where().returning()
 * resolves from the returningQueue (for the atomic claim).
 */
function makeConcurrencyDb(
  selectQueue: unknown[][],
  returningQueue: unknown[][],
) {
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

describe("runAoaDispatch — Phase-3 pre-spend budget hard-stop (A3)", () => {
  beforeEach(() => {
    mockGetInvocationBlock.mockReset();
    runAoaMock.mockClear();
    runAoaMock.mockResolvedValue(undefined);
  });

  it("BLOCKED: getInvocationBlock returns a reason → wakeup set status='skipped_budget' AND runAoaAgent NOT called (no claim, no dispatch)", async () => {
    mockGetInvocationBlock.mockResolvedValue(
      "Agent budget exceeded: 5000 of 4000 cents used this month",
    );

    // Select slots (single wakeup, budget-blocked path):
    //   0 = Phase-1 orphan-select
    //   1 = Phase-2 pending-drain
    //   2 = Phase-3 wakeup-select (one queued aoa wakeup)
    //   3 = resolveCompanyConfig (inside drainPhase3 closure)
    //   4 = D3 SPEND-brake window count
    //   5 = A5/T1.9 run-COUNT brake window count
    //   6 = agent row select (per-role model resolution)
    //   7 = Phase-4 reclaim-select (after Promise.all)
    // The budget pre-flight fires AFTER slot 6 (model resolution) and BEFORE
    // the atomic claim — on the blocked path it returns early, so NO claim
    // update and NO effectiveAutonomy threadId lookup occur.
    const db = makeConcurrencyDb(
      [
        [],
        [],
        [{ id: "w-blk", agentId: "a-blk", companyId: "co-blk", source: "thread_mention", payload: { role: "scout", note: "x" } }],
        [{ crewAutonomyLevel: 3, crewPaused: false, model: "claude-sonnet-4-6", inboundRoutingLevel: "off" }],
        [], // D3 SPEND-brake count
        [], // A5/T1.9 run-COUNT brake count
        [{ runtimeConfig: {}, adapterConfig: {} }], // agent row
        [], // Phase-4
      ],
      [
        // No atomic-claim returning is consumed on the blocked path.
      ],
    );

    await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });

    // The budget gate was consulted with (agentId, companyId).
    expect(mockGetInvocationBlock).toHaveBeenCalledWith("a-blk", "co-blk");

    // The wakeup row was terminalized → 'skipped_budget' with finishedAt.
    const skipSet = (db._sets as any[]).find((s: any) => s.status === "skipped_budget");
    expect(skipSet).toBeDefined();
    expect(skipSet.finishedAt).toBeInstanceOf(Date);

    // It was NEVER claimed (no 'processing' set) and the runner was NOT invoked.
    expect((db._sets as any[]).some((s: any) => s.status === "processing")).toBe(false);
    expect(runAoaMock).not.toHaveBeenCalled();
  });

  it("CLEAR: getInvocationBlock returns null → wakeup proceeds (claimed + runAoaAgent called; NOT skipped_budget)", async () => {
    mockGetInvocationBlock.mockResolvedValue(null);

    // Select slots (single wakeup, clear path — proceeds to claim + dispatch):
    //   0 Phase-1, 1 Phase-2, 2 Phase-3 wakeup, 3 resolveCompanyConfig,
    //   4 D3 SPEND-brake count, 5 A5/T1.9 run-COUNT brake count, 6 agent row,
    //   7 Phase-4.
    // payload has no threadId → no effectiveAutonomy lookup; Phase-4 is slot 7.
    const db = makeConcurrencyDb(
      [
        [],
        [],
        [{ id: "w-ok", agentId: "a-ok", companyId: "co-ok", source: "thread_mention", payload: { role: "scout", note: "y" } }],
        [{ crewAutonomyLevel: 3, crewPaused: false, model: "claude-sonnet-4-6", inboundRoutingLevel: "off" }],
        [], // D3 SPEND-brake count
        [], // A5/T1.9 run-COUNT brake count
        [{ runtimeConfig: {}, adapterConfig: {} }], // agent row
        [], // Phase-4
      ],
      [
        [{ id: "w-ok" }], // update[0] = atomic claim RETURNING (claimed)
        [],                // update[1] = final status update
      ],
    );

    await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });

    expect(mockGetInvocationBlock).toHaveBeenCalledWith("a-ok", "co-ok");

    // NOT skipped_budget on the clear path.
    expect((db._sets as any[]).some((s: any) => s.status === "skipped_budget")).toBe(false);

    // It WAS claimed (atomic claim set status='processing') and dispatched.
    expect((db._sets as any[]).some((s: any) => s.status === "processing")).toBe(true);
    expect(runAoaMock).toHaveBeenCalledWith(
      db,
      "a-ok",
      expect.objectContaining({ companyId: "co-ok", source: "thread_mention", wakeupId: "w-ok", note: "y" }),
    );
  });
});
