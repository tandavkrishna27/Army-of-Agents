// A5 / T1.9 — run-COUNT brake for $0 CLI runs.
//
// The dispatcher's only pre-existing runaway brake (D3, the spend brake) counts
// ONLY paid runs (`gt(internalAgentRuns.costCents, 0)`). CLI-subscription crew
// runs report $0, so that brake is INERT for them — a runaway crew loop spinning
// $0 runs sails straight past it. A5 adds a SEPARATE run-COUNT brake that counts
// ALL crew runs in a rolling window (no cost filter), catching the exact failure
// the spend brake can't see.
//
// This suite drives the dispatcher to the brake region (valid role + high
// autonomy + budget clear + kill-switch off) and asserts:
//   (1) all-runs count >= DEFAULT_CREW_RUN_COUNT_LIMIT.maxRunsPerWindow (40 rows,
//       all costCents=0) → wakeup set status='skipped_rate_limit' AND runAoaAgent
//       NOT called.
//   (2) all-runs count < the limit → proceeds (claimed + runAoaAgent invoked).
//
// cost-caps.js is deliberately NOT mocked here: the REAL runRateExceeded and the
// REAL DEFAULT_CREW_RUN_COUNT_LIMIT drive behavior, so the 40-row boundary is
// genuinely exercised. The spend-brake select (slot 4) returns [] (0 paid runs →
// passes) so we always reach the new count-brake select (slot 5).
import { beforeEach, describe, expect, it, vi } from "vitest";

const { runAoaMock } = vi.hoisted(() => ({
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
// All roles active so the autonomy gate passes and we reach the brake region.
vi.mock("../services/internal-agent/aoa-agents/autonomy.js", () => ({
  isRoleActiveAtAutonomy: () => true,
  ROLE_MIN_AUTONOMY: {
    scribe: 0, memory_keeper: 0, curator: 0, router: 2, navigator: 2,
    planner: 2, dispatcher: 2, adjutant: 0, maker: 1, engineer: 1,
    scout: 1, chronicler: 0,
  },
}));
// resolveCrewRole → a valid role so the autonomy gate passes. Module-mocked so
// it adds NO real db.select (the positional select sequence below stays intact).
vi.mock("../services/internal-agent/aoa-agents/resolve-crew-role.js", () => ({
  resolveCrewRole: vi.fn().mockResolvedValue("scout"),
}));
// Budget clear → reach the brake (and, on the pass path, dispatch).
vi.mock("../services/budgets.js", () => ({
  budgetService: () => ({ getInvocationBlock: vi.fn().mockResolvedValue(null) }),
}));
vi.mock("../services/internal-agent/aoa-agents/kill-switch.js", () => ({
  isCrewPaused: () => false,
}));
// NOTE: ../services/internal-agent/cost-caps.js is intentionally NOT mocked — the
// REAL runRateExceeded + DEFAULT_CREW_RATE_LIMIT + DEFAULT_CREW_RUN_COUNT_LIMIT
// are exercised so the 40-row count boundary is genuinely tested.
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
import { DEFAULT_CREW_RUN_COUNT_LIMIT } from "../services/internal-agent/cost-caps.js";

/**
 * makeConcurrencyDb — VERBATIM the harness from aoa-dispatcher.test.ts. Select
 * results are returned in positional order; update().set(v) pushes `v` into
 * `_sets`; .where().returning() resolves from the returningQueue (atomic claim).
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

// 40 $0 runs → at/over the count limit (maxRunsPerWindow = 40). The brake fires
// when allWindowRuns >= 40 (runRateExceeded uses >=).
const overLimitRuns = Array.from(
  { length: DEFAULT_CREW_RUN_COUNT_LIMIT.maxRunsPerWindow },
  (_v, i) => ({ id: `run-${i}` }),
);

describe("runAoaDispatch — run-COUNT brake (A5 / T1.9)", () => {
  beforeEach(() => {
    runAoaMock.mockClear();
    runAoaMock.mockResolvedValue(undefined);
  });

  it("(1) all-runs count >= limit (40 $0 runs) → skipped_rate_limit AND runAoaAgent NOT called (the $0 over-limit case the spend brake misses)", async () => {
    // Select slots (count-brake FIRES → early return before agent-row/claim):
    //   0 = Phase-1 orphan-select
    //   1 = Phase-2 pending-drain
    //   2 = Phase-3 wakeup-select (one queued aoa wakeup, valid role)
    //   3 = resolveCompanyConfig (autonomy high so the autonomy gate passes)
    //   4 = D3 SPEND-brake count select (paid runs only → [] → 0 < 10 → passes)
    //   5 = A5 run-COUNT brake select (ALL runs → 40 $0 rows → >= 40 → FIRES)
    //   6 = Phase-4 reclaim-select (after Promise.all)
    const db = makeConcurrencyDb(
      [
        [], // 0 Phase-1 orphan
        [], // 1 Phase-2 pending
        // 2 Phase-3 wakeup: valid role (scout), no threadId (no thread lookups)
        [{ id: "w-rc", agentId: "a-rc", companyId: "co-rc", source: "thread_mention", payload: { role: "scout", note: "x" } }],
        // 3 resolveCompanyConfig: autonomy high (Drive) → autonomy gate passes
        [{ crewAutonomyLevel: 3, crewPaused: false, model: "claude-sonnet-4-6", inboundRoutingLevel: "off" }],
        // 4 SPEND brake: zero PAID runs in window → passes (the bug: $0 runs invisible here)
        [],
        // 5 A5 COUNT brake: 40 $0 runs in window → runRateExceeded(40, 40) → FIRES
        overLimitRuns,
        // 6 Phase-4 reclaim-select (after Promise.all)
        [],
      ],
      [
        // No atomic-claim returning is consumed: the count brake returns early.
      ],
    );

    await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });

    // The wakeup row was terminalized → 'skipped_rate_limit' with finishedAt.
    const skipSet = (db._sets as any[]).find((s: any) => s.status === "skipped_rate_limit");
    expect(skipSet).toBeDefined();
    expect(skipSet.finishedAt).toBeInstanceOf(Date);

    // It was NEVER claimed (no 'processing' set) and the runner was NOT invoked —
    // exactly the runaway the cost-only brake is blind to.
    expect((db._sets as any[]).some((s: any) => s.status === "processing")).toBe(false);
    expect(runAoaMock).not.toHaveBeenCalled();
  });

  it("(2) all-runs count < limit → proceeds (NOT skipped; claimed + runAoaAgent called)", async () => {
    // Select slots (count-brake PASSES → falls through to agent-row + claim):
    //   0 Phase-1, 1 Phase-2, 2 Phase-3 wakeup, 3 resolveCompanyConfig,
    //   4 D3 SPEND-brake count ([]), 5 A5 COUNT brake (3 rows < 40 → passes),
    //   6 agent-row select (per-role model resolution),
    //   (budget pre-flight → mocked null; atomic claim → returning),
    //   (no threadId → no effectiveAutonomy lookup),
    //   7 Phase-4 reclaim-select (after Promise.all).
    const db = makeConcurrencyDb(
      [
        [], // 0 Phase-1 orphan
        [], // 1 Phase-2 pending
        [{ id: "w-ok", agentId: "a-ok", companyId: "co-ok", source: "thread_mention", payload: { role: "scout", note: "y" } }], // 2 wakeup
        [{ crewAutonomyLevel: 3, crewPaused: false, model: "claude-sonnet-4-6", inboundRoutingLevel: "off" }], // 3 config
        [], // 4 SPEND brake: 0 paid runs → passes
        [{ id: "run-a" }, { id: "run-b" }, { id: "run-c" }], // 5 A5 COUNT brake: 3 runs < 40 → passes
        [{ runtimeConfig: {}, adapterConfig: {} }], // 6 agent row
        [], // 7 Phase-4 reclaim-select
      ],
      [
        [{ id: "w-ok" }], // update[0] = atomic claim RETURNING (claimed)
        [],                // update[1] = final status update
      ],
    );

    await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });

    // NOT braked.
    expect((db._sets as any[]).some((s: any) => s.status === "skipped_rate_limit")).toBe(false);
    // It WAS claimed (atomic claim set status='processing') and dispatched.
    expect((db._sets as any[]).some((s: any) => s.status === "processing")).toBe(true);
    expect(runAoaMock).toHaveBeenCalledWith(
      db,
      "a-ok",
      expect.objectContaining({ companyId: "co-ok", source: "thread_mention", wakeupId: "w-ok", note: "y" }),
    );
  });
});
