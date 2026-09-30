// Contract test for runAoaDispatch — the generalized AoA dispatcher.
//
// Phase 1 is the VERBATIM Decision-#99 linked-run orphan reclaim (same
// predicates as extraction-sweeper.ts): orphan = entry 'processing' AND its
// LINKED current run still 'running' & older than staleMs → terminalize that
// run → 'failed' AND reset the entry → 'pending'. Phase 2 generalizes the
// drain: each 'pending' entry is gated per-company by an enabled `outbox`
// trigger (listEnabledOutboxAgents). A company with no enabled outbox agent
// is SKIPPED; otherwise the extraction agent is resolved (memoized per
// company) and runExtractionConsumer is invoked under a bounded limiter.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { consumerMock, ensureExtractionMock, isCrewPausedMock, listOutboxMock, publishLiveEventMock, runAoaMock } =
  vi.hoisted(() => ({
    consumerMock: vi.fn().mockResolvedValue(undefined),
    ensureExtractionMock: vi.fn().mockResolvedValue("ext-1"),
    isCrewPausedMock: vi.fn(({ companyPaused, threadPaused }: { companyPaused: boolean; threadPaused: boolean }) =>
      companyPaused || threadPaused,
    ),
    listOutboxMock: vi.fn().mockResolvedValue(["ext-1"]),
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
    // Plan 3 Task 4/8: dispatcher now queries internalAgentConfig for
    // autonomyLevel + crewPaused before each wakeup run.
    internalAgentConfig: t("internal_agent_config"),
  };
});
// Mock the Plan-3 gate modules so existing dispatcher tests don't need to
// add internalAgentConfig/agent query slots to their sequence DBs. Tests that
// specifically exercise the gates do so via crew-autonomy / crew-killswitch /
// crew-cost-caps.
vi.mock("../services/internal-agent/aoa-agents/autonomy.js", () => ({
  isRoleActiveAtAutonomy: () => true, // all roles active in dispatcher contract tests
  // A2: the fail-closed gate calls Object.keys(ROLE_MIN_AUTONOMY) to decide
  // whether a payload.role is a KNOWN crew role. Mirror the real role-key set
  // so a fixture's payload.role (e.g. "chronicler") is recognized and the gate
  // takes the payload-role branch instead of falling to resolveCrewRole.
  ROLE_MIN_AUTONOMY: {
    scribe: 0, memory_keeper: 0, curator: 0, router: 2, navigator: 2,
    planner: 2, dispatcher: 2, adjutant: 0, maker: 1, engineer: 1,
    scout: 1, chronicler: 0,
  },
}));
// A2: the dispatcher's fail-closed autonomy gate now resolves an absent/unknown
// payload.role via the leaf resolveCrewRole. Module-mock it (→ null) so it adds
// NO real db.select — the positional _selectOrder sequences below stay byte-
// stable. With isRoleActiveAtAutonomy mocked → true, any RESOLVED role is active;
// the only behavioral consequence is that a role-LESS wakeup at autonomy < 2 is
// now (correctly) skipped_autonomy. Fixtures that exercise dispatch therefore
// carry a known payload.role (see the M4/FX5 fixture's role).
vi.mock("../services/internal-agent/aoa-agents/resolve-crew-role.js", () => ({
  resolveCrewRole: vi.fn().mockResolvedValue(null),
}));
// A3: pre-spend budget hard-stop. Module-mock budgetService so getInvocationBlock
// returns null (budget clear) and adds NO real db.select on budgetPolicies —
// the positional _selectOrder sequences below stay byte-stable. (A real call
// would issue agent- and company-scoped budgetPolicies selects and shift the
// sequence, breaking these fixtures.)
vi.mock("../services/budgets.js", () => ({
  budgetService: () => ({ getInvocationBlock: vi.fn().mockResolvedValue(null) }),
}));
vi.mock("../services/internal-agent/aoa-agents/kill-switch.js", () => ({
  isCrewPaused: isCrewPausedMock,
}));
vi.mock("../services/internal-agent/cost-caps.js", () => ({
  runRateExceeded: () => false, // run-rate never exceeded in dispatcher contract tests
  resolveRoleModel: ({ companyDefault }: { roleModel: string | null; companyDefault: string }) => companyDefault,
  DEFAULT_CREW_RATE_LIMIT: { maxRunsPerWindow: 10, windowMinutes: 10 },
  // A5: run-COUNT brake constant. runRateExceeded is mocked → false above, so the
  // count brake never fires here; the brake's select still runs (one extra slot
  // per dispatching wakeup, AFTER the D3 spend-brake count select).
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
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import { runAoaDispatch } from "../services/internal-agent/aoa-agents/dispatcher.js";

/**
 * Sequence-aware mock DB — VERBATIM the makeDb harness from
 * extraction-sweeper.test.ts (renamed makeSeqDb), extended for FX1.
 * Select slots, in dispatcher call order:
 *   0 = Phase-1 orphan-select (#99 verbatim: processing + linked run 'running' + stale)
 *   1 = Phase-2 pending-drain
 *   (2 = Phase-3 wakeup-select → defaults to [])
 *   3 = Phase-4 FX1 reclaim-select (processing + linked run 'failed')
 * Phase-4 runs LAST (after the wakeup drain) so the #99 select ordering the
 * other suites depend on is unchanged; it is functionally order-independent
 * (output is terminal 'failed', feeds no later phase).
 * - update().set(v).where() pushes `v` into `_sets` so we can assert which
 *   updates were issued (run-fail vs entry-reset vs FX1 entry→failed, by
 *   payload shape).
 */
function makeSeqDb(selectQueue: unknown[][]) {
  let si = 0;
  const sets: any[] = [];
  const db: any = {
    _sets: sets,
    select: () => {
      const n = si++;
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
        sets.push(v);
        return { where: () => Promise.resolve([]) };
      },
    }),
  };
  return db;
}

const runFail = (s: any) => s.status === "failed";
const entryReset = (s: any) =>
  s.extractionStatus === "pending" && s.extractionRunId === null;
// FX1 Phase-1b: entry terminalized → 'failed' (NOT pending) with a
// sourceInfo.extractionError jsonb_set payload.
const entryFailReclaim = (s: any) =>
  s.extractionStatus === "failed" && s.sourceInfo !== undefined;

describe("runAoaDispatch — generalized #99 dispatcher", () => {
  // Phase 1 (Task C1): the autonomous Scribe outbox drain is OFF by default
  // in production — Memory Keeper (phase=done sweep) and Adjutant own
  // extraction via tool calls. These tests pin the legacy autonomous-drain
  // mechanism (Phase-2 dispatch through `runExtractionConsumer`), so they
  // explicitly opt INTO the drain by setting the env flag before each test.
  // Cleaned up in `afterEach` so other suites in the same vitest worker are
  // unaffected.
  const ORIGINAL_DRAIN_FLAG = process.env.AOA_SCRIBE_AUTONOMOUS_DRAIN_ENABLED;
  beforeEach(() => {
    process.env.AOA_SCRIBE_AUTONOMOUS_DRAIN_ENABLED = "true";
    consumerMock.mockClear();
    ensureExtractionMock.mockClear();
    listOutboxMock.mockClear();
    publishLiveEventMock.mockClear();
    runAoaMock.mockClear();
    isCrewPausedMock.mockClear();
    isCrewPausedMock.mockImplementation(
      ({ companyPaused, threadPaused }: { companyPaused: boolean; threadPaused: boolean }) =>
        companyPaused || threadPaused,
    );
    consumerMock.mockResolvedValue(undefined);
    runAoaMock.mockResolvedValue(undefined);
    ensureExtractionMock.mockResolvedValue("ext-1");
    listOutboxMock.mockResolvedValue(["ext-1"]);
  });
  afterEach(() => {
    if (ORIGINAL_DRAIN_FLAG === undefined) {
      delete process.env.AOA_SCRIBE_AUTONOMOUS_DRAIN_ENABLED;
    } else {
      process.env.AOA_SCRIBE_AUTONOMOUS_DRAIN_ENABLED = ORIGINAL_DRAIN_FLAG;
    }
  });

  it("Phase-2: company WITH an enabled outbox agent → entry dispatched via runExtractionConsumer(db, companyId, entryId, agentId)", async () => {
    const db = makeSeqDb([
      [], // Phase-1 orphan-select: nothing stale
      [{ id: "e1", companyId: "co-1" }], // Phase-2 pending-drain
    ]);
    listOutboxMock.mockResolvedValue(["ext-1"]);
    ensureExtractionMock.mockResolvedValue("ext-1");

    await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });

    expect(listOutboxMock).toHaveBeenCalledWith(db, "co-1");
    expect(ensureExtractionMock).toHaveBeenCalledWith(db, "co-1");
    expect(consumerMock).toHaveBeenCalledWith(db, "co-1", "e1", "ext-1");
  });

  it("Phase-2 gate: company with NO enabled outbox agent → its pending entry is NOT dispatched", async () => {
    const db = makeSeqDb([
      [], // Phase-1: nothing stale
      [{ id: "e2", companyId: "co-no-outbox" }], // Phase-2 pending
    ]);
    listOutboxMock.mockResolvedValue([]); // no enabled outbox trigger

    await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });

    expect(listOutboxMock).toHaveBeenCalledWith(db, "co-no-outbox");
    // Gated out: neither the agent is resolved nor the consumer invoked.
    expect(ensureExtractionMock).not.toHaveBeenCalled();
    expect(consumerMock).not.toHaveBeenCalled();
  });

  // ── #99 Phase-1 linked-run reclaim (relocated verbatim from the retired
  //    extraction-sweeper.test.ts canary; this test now carries that
  //    coverage and must stay rigorous). The invariant has TWO halves:
  //    (positive) a STALE linked run → terminalize run + reset entry, and
  //    (negative) NOTHING stale → ZERO reclaim writes even when there is
  //    genuine pending work to drain (no false-reclaim of healthy in-flight).
  it("Phase-1 reclaim (#99 verbatim) POSITIVE: stale linked run terminalized → 'failed' AND entry reset → 'pending' (exactly one of each, then re-dispatched)", async () => {
    const db = makeSeqDb([
      [{ id: "e1", runId: "r1" }], // orphan-select (projected {id, runId})
      [{ id: "e1", companyId: "co-1" }], // pending-drain (now pending)
    ]);

    await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });

    // Exactly one stale linked run terminalized → 'failed' (guarded
    // status='running'); errorMessage is the aoa-dispatcher variant. The
    // exact-count guard proves no spurious extra run writes.
    const runFailSets = db._sets.filter(runFail);
    expect(runFailSets).toHaveLength(1);
    expect(runFailSets[0]).toMatchObject({
      status: "failed",
      errorMessage: "reclaimed: orphaned (aoa-dispatcher)",
    });
    expect(runFailSets[0].completedAt).toBeInstanceOf(Date);
    // Exactly one entry atomically reset → 'pending', extractionRunId null.
    const entryResetSets = db._sets.filter(entryReset);
    expect(entryResetSets).toHaveLength(1);
    // Precisely those two writes — nothing else was mutated.
    expect(db._sets).toHaveLength(2);
    // …and the just-reclaimed entry is then re-dispatched through the gate.
    expect(consumerMock).toHaveBeenCalledWith(db, "co-1", "e1", "ext-1");
  });

  it("Phase-1 reclaim (#99 verbatim) NEGATIVE: orphan-select empty (no stale linked run) → ZERO reclaim writes, but genuine pending is still drained", async () => {
    const db = makeSeqDb([
      [], // orphan-select: linked run recent/terminal → excluded by the query
      [{ id: "e3", companyId: "co-3" }], // a genuine pending entry still exists
    ]);

    await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });

    // No false-reclaim of healthy in-flight: NOTHING was terminalized/reset.
    expect(db._sets).toHaveLength(0);
    expect(db._sets.some(runFail)).toBe(false);
    expect(db._sets.some(entryReset)).toBe(false);
    // …yet the genuine pending entry was still drained exactly once.
    expect(consumerMock).toHaveBeenCalledWith(db, "co-3", "e3", "ext-1");
    expect(consumerMock).toHaveBeenCalledTimes(1);
  });

  it("memoizes the per-company outbox-check and extraction-agent within a tick", async () => {
    const db = makeSeqDb([
      [],
      [
        { id: "e1", companyId: "co-1" },
        { id: "e2", companyId: "co-1" },
      ],
    ]);
    listOutboxMock.mockResolvedValue(["ext-1"]);
    ensureExtractionMock.mockResolvedValue("ext-1");

    await runAoaDispatch(db, { limiterMax: 1, staleMs: 600_000 });

    expect(listOutboxMock).toHaveBeenCalledTimes(1);
    expect(ensureExtractionMock).toHaveBeenCalledTimes(1);
    expect(consumerMock).toHaveBeenCalledTimes(2);
  });

  it("no-op when nothing stuck and nothing pending", async () => {
    const db = makeSeqDb([[], []]);
    await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });
    expect(db._sets).toHaveLength(0);
    expect(consumerMock).not.toHaveBeenCalled();
  });

  // ── FX1 Part A / Phase-4: a disjoint reclaim. The existing Phase-1 (#99)
  //    reclaim handles entries whose linked run is still 'running' & stale →
  //    reset to 'pending' (retry). FX1 adds: an entry 'processing' whose
  //    linked run is already 'failed' (the runner's catch terminalized the
  //    RUN but — pre-FX1 — left the entry stuck 'processing' forever). These
  //    must be terminalized → 'failed' (NOT 'pending'; the run already
  //    failed, retrying it is wrong) with the discussion.extraction.failed
  //    LiveEvent. Mirrors extraction.ts. Runs LAST (select slot 3, after the
  //    Phase-3 wakeup select) so the #99 ordering other suites depend on is
  //    unchanged.
  it("Phase-4: processing entry w/ linked FAILED run → entry extractionStatus='failed' (NOT pending) + discussion.extraction.failed LiveEvent", async () => {
    const db = makeSeqDb([
      [], // 0: Phase-1 orphan-select: nothing 'running'+stale
      [], // 1: Phase-2 pending-drain: nothing pending
      [], // 2: Phase-3 wakeup-select: nothing queued
      // 3: Phase-4 reclaim-select — processing entry whose linked run failed.
      // Shape follows the Phase-4 select (id + discussionId + company).
      [
        {
          id: "e9",
          discussionId: "disc-9",
          companyId: "co-9",
        },
      ],
    ]);

    await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });

    // The entry was terminalized → 'failed' (NOT pending) with a
    // sourceInfo.extractionError jsonb_set payload (mirrors extraction.ts).
    const failSets = db._sets.filter(entryFailReclaim);
    expect(failSets).toHaveLength(1);
    expect(failSets[0].extractionStatus).toBe("failed");
    expect(failSets[0].sourceInfo).toBeDefined();
    // It must NOT have been reset to 'pending' (no retry loop on a run that
    // already failed).
    expect(db._sets.some(entryReset)).toBe(false);

    // discussion.extraction.failed LiveEvent published for the reclaimed entry.
    expect(publishLiveEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "co-9",
        type: "discussion.extraction.failed",
        payload: expect.objectContaining({
          discussionId: "disc-9",
          entryId: "e9",
          error: "reclaimed: extraction run failed (aoa-dispatcher)",
        }),
      }),
    );
    // It was NOT dispatched to the extraction consumer (terminal, not retry).
    expect(consumerMock).not.toHaveBeenCalled();
  });

  it("Phase-4: nothing failed-linked → no FX1 terminalize writes, no failed LiveEvent", async () => {
    const db = makeSeqDb([[], []]);
    await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });
    expect(db._sets.some(entryFailReclaim)).toBe(false);
    expect(publishLiveEventMock).not.toHaveBeenCalled();
  });

  // ── M4 / FX5: Phase-2 (extraction backlog, up to 200/tick) and Phase-3
  //    (@mention / delegate_to_subagent wakeups) must DRAIN CONCURRENTLY.
  //    Pre-fix the dispatcher fully `await`ed Phase-2 before it even queried
  //    Phase-3, with a SINGLE shared limiter — so under an extraction backlog
  //    every wakeup waited behind the entire extraction batch each tick and
  //    one noisy company starved others. This harness records select-slot
  //    order and supports the Phase-3 atomic-claim `.returning()`. The Phase-2
  //    consumer blocks on a manually-resolved gate; the test asserts the
  //    Phase-3 wakeup is claimed/run (runAoaAgent invoked) BEFORE Phase-2 is
  //    allowed to finish — proving the two drains overlap. It also asserts the
  //    Phase-1→Phase-2 ordering invariant and that Phase-4 still runs, and
  //    that the select calls are still issued in the original positional order
  //    (slot0 Phase-1, slot1 Phase-2, slot2 Phase-3, slot3 Phase-4) so the
  //    positional-select-sensitive sibling suites stay byte-stable.
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

  it("M4/FX5: Phase-3 wakeup drain is NOT serialized behind Phase-2's full batch (drains overlap; Phase-1 still precedes Phase-2; Phase-4 still runs; positional select order preserved)", async () => {
    // Phase-2 consumer blocks until we explicitly release it.
    let releasePhase2!: () => void;
    const phase2Gate = new Promise<void>((res) => {
      releasePhase2 = res;
    });
    let phase2Resolved = false;
    consumerMock.mockImplementation(async () => {
      await phase2Gate;
      phase2Resolved = true;
    });

    // runAoaAgent (Phase-3) records whether it ran while Phase-2 was still
    // blocked. If the drains overlap it will; if Phase-3 is serialized behind
    // Phase-2 it can only run after we release the gate.
    let phase3RanWhilePhase2Blocked = false;
    runAoaMock.mockImplementation(async () => {
      if (!phase2Resolved) phase3RanWhilePhase2Blocked = true;
    });

    const db = makeConcurrencyDb(
      [
        // slot 0 — Phase-1 orphan-select: nothing stale (keeps writes clean)
        [],
        // slot 1 — Phase-2 pending-drain: a gated-in pending entry
        [{ id: "e1", companyId: "co-1" }],
        // slot 2 — Phase-3 wakeup-select: a queued aoa wakeup.
        // T1.2 (codex F6): the dispatcher now selects + passes through the
        // wakeup's original source (was hardcoded "wakeup" in runAoaAgent
        // call). Fixture must include source for the codex-F6 assertion
        // below to be meaningful.
        // A2 (fail-closed autonomy): payload now carries a KNOWN crew role
        // (adjutant, min-autonomy 0 → active at L0). Pre-A2 this fixture had no
        // role and still dispatched at autonomy 0 — but that was the BUG the
        // fail-closed gate fixes (no-role → Drive-only). This test exercises the
        // Phase-2/Phase-3 DRAIN-OVERLAP invariant, not autonomy, so the wakeup
        // must legitimately pass the gate. With a role present resolveCrewRole is
        // not consulted; the role makes the wakeup a valid dispatch at L0.
        [{ id: "w1", agentId: "a1", companyId: "co-1", source: "thread_mention", payload: { role: "adjutant", note: "x" } }],
        // slot 3 — Phase-4 reclaim-select: nothing failed-linked
        [],
        // slot 4 — Plan-3 Task 4/8: resolveCompanyConfig select (per wakeup,
        // memoized by company). Returns an empty row so crewPaused=false
        // (default) and autonomyLevel=0 (default). Autonomy+kill-switch gates
        // are mocked to always pass, so this select is a no-op for the test.
        [],
        // slot 5 — Plan-3 Task 9: D3 SPEND-brake count select (paid runs only).
        // runRateExceeded is mocked to always return false so 0 runs here is
        // safe; the select still runs to count internal_agent_runs in the window.
        [],
        // slot 6 — A5/T1.9: run-COUNT brake select (ALL runs, no cost filter).
        // runRateExceeded mocked → false so 0 runs is safe; the select still runs.
        [],
        // slot 7 — Plan-3 Task 9: agent row select for per-role model resolution.
        // Returns empty so agentRow=null → falls back to company default model.
        // resolveRoleModel is mocked to return companyDefault directly.
        [],
      ],
      [
        // update[0] = Phase-3 atomic claim queued→processing → claimed
        [{ id: "w1" }],
      ],
    );

    const dispatch = runAoaDispatch(db, { limiterMax: 4, staleMs: 600_000 });

    // Let microtasks settle: Phase-1 (awaited) completes, then Phase-2 and
    // Phase-3 drains both get a chance to start. Phase-2's consumer is parked
    // on the gate; if the drains overlap, Phase-3's claim+runAoaAgent runs now.
    await new Promise((r) => setTimeout(r, 20));

    // The wakeup must have been claimed AND runAoaAgent invoked even though
    // Phase-2's batch is still blocked — proves Phase-3 is NOT serialized
    // behind Phase-2 (the starvation fix).
    expect(runAoaMock).toHaveBeenCalledWith(
      db,
      "a1",
      // T1.2 (codex F6): original wakeup source flows through (was hardcoded "wakeup").
      expect.objectContaining({ companyId: "co-1", source: "thread_mention", wakeupId: "w1", note: "x" }),
    );
    expect(phase3RanWhilePhase2Blocked).toBe(true);
    expect(phase2Resolved).toBe(false); // Phase-2 genuinely still in-flight

    // Now release Phase-2 and let the whole tick finish.
    releasePhase2();
    await dispatch;

    expect(phase2Resolved).toBe(true);
    expect(consumerMock).toHaveBeenCalledWith(db, "co-1", "e1", "ext-1");

    // Ordering invariant: Phase-1 must complete before Phase-2 dispatches
    // (Phase-1 resets orphans → 'pending' which Phase-2's select must see).
    // The orphan select (slot 0) is consumed before the pending select
    // (slot 1), and both before the wakeup select (slot 2) and Phase-4 (slot
    // 3). Plan-3 Task 4/8 adds a resolveCompanyConfig select (slot 4) per
    // wakeup that is always AFTER the wakeup select. Plan-3 Task 9 adds a
    // D3 spend-brake count select (slot 5); A5/T1.9 adds the run-COUNT brake
    // select (slot 6); then the agent-row select (slot 7) — all per wakeup,
    // memoized by the gate mocks so gating is bypassed in this test. The DRAINS
    // overlap, selects are issued in the original positional order.
    expect(db._selectOrder).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    // Phase-4 still runs last (its select slot was consumed; nothing to do).
    expect(db._sets.some(entryFailReclaim)).toBe(false);
  });

  // ── Task 1.6 — Inbox-routing dispatcher branch (D4 / #3 / #4) ─────────────
  //
  // D4: inbox-routing wakeups (source="inbox.routing_ambiguous") are gated on
  // the routing dial (inboundRoutingLevel), NOT crew autonomy. The Navigator
  // must fire even when autonomyLevel=0.
  //
  // #3 / #4: the payload has no threadId by design, so thread-level
  // pause/controller-path gates must NOT apply to this wakeup source. The
  // isInboxRouting guard in the dispatcher makes this explicit rather than
  // relying on the gates being silently inert when threadId is absent.
  //
  // These tests use makeConcurrencyDb (already in this describe block) because
  // it supports .returning() on update() — needed for the atomic claim path.
  // Autonomy, kill-switch, and rate-brake are mocked to always pass (see the
  // module-level vi.mock calls above), so the only gate exercised here is the
  // routing dial.

  it("D4 (Task 1.6): inbox-routing wakeup at inboundRoutingLevel='off' → skipped_routing_off, runAoaAgent NOT called", async () => {
    // Select slot order for this case (single inbox-routing wakeup, dial=off):
    //   0 = Phase-1 orphan-select
    //   1 = Phase-2 pending-drain
    //   2 = Phase-3 wakeup-select
    //   3 = Phase-4 reclaim-select (runs after Promise.all; resolver fires after
    //       resolveCompanyConfig because Phase-4 is awaited after the drains)
    //   4 = resolveCompanyConfig (consumed inside drainPhase3's closure;
    //       Promise.all runs drainPhase3 concurrently with drainPhase2)
    //
    // BUT: Promise.all runs drainPhase2 and drainPhase3 concurrently. drainPhase2
    // returns immediately (no rows). drainPhase3's async closure calls
    // resolveCompanyConfig which issues the next select. Phase-4 select runs
    // only AFTER Promise.all resolves. The select order is therefore:
    //   slot 0 (orphan), slot 1 (pending), slot 2 (wakeup),
    //   slot 3 (resolveCompanyConfig — inside drainPhase3 closure),
    //   slot 4 (Phase-4 reclaim — after Promise.all).
    // Early-return fires before the rate-brake / agent-row selects.
    const db = makeConcurrencyDb(
      [
        [],  // slot 0 — Phase-1 orphan-select
        [],  // slot 1 — Phase-2 pending-drain
        // slot 2 — Phase-3 wakeup-select: one inbox-routing wakeup
        [{ id: "wr-off", agentId: "a-nav", companyId: "co-r", source: "inbox.routing_ambiguous", payload: { inboxItemId: "item-1", candidateThreadIds: ["t1"], distances: [0.2], gap: false } }],
        // slot 3 — resolveCompanyConfig: routing dial is OFF
        [{ crewAutonomyLevel: 0, crewPaused: false, model: "claude-sonnet-4-6", inboundRoutingLevel: "off" }],
        [],  // slot 4 — Phase-4 reclaim-select (after Promise.all)
      ],
      [
        // update[0] = skipped_routing_off write (early-return path, .returning() not used)
      ],
    );

    await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });

    // runAoaAgent must NOT have been called.
    expect(runAoaMock).not.toHaveBeenCalled();

    // The wakeup row must have been updated to skipped_routing_off.
    const skipSet = (db._sets as any[]).find((s: any) => s.status === "skipped_routing_off");
    expect(skipSet).toBeDefined();
    expect(skipSet.finishedAt).toBeInstanceOf(Date);
  });

  it("D4 (Task 1.6): inbox-routing wakeup at inboundRoutingLevel='suggest' with autonomyLevel=0 → runAoaAgent IS called (not blocked by crew-autonomy)", async () => {
    // Select slots (dispatch path — dial != off):
    //   0 = Phase-1 orphan, 1 = Phase-2 pending, 2 = Phase-3 wakeup,
    //   3 = resolveCompanyConfig (inside closure, concurrent with Phase-2),
    //   4 = D3 SPEND-brake window count,
    //   5 = A5/T1.9 run-COUNT brake window count,
    //   6 = agent row select,
    //   7 = effectiveAutonomy threadId lookup (no-op: payload has no threadId),
    //   8 = Phase-4 reclaim-select (after Promise.all).
    // NOTE: effectiveAutonomy lookup only fires if payload.threadId is present.
    // Inbox-routing payload has no threadId, so that DB call is skipped and
    // Phase-4 is slot 7, not slot 8.
    const db = makeConcurrencyDb(
      [
        [],  // slot 0 — Phase-1 orphan-select
        [],  // slot 1 — Phase-2 pending-drain
        // slot 2 — Phase-3 wakeup-select: inbox-routing wakeup
        [{ id: "wr-sug", agentId: "a-nav", companyId: "co-r2", source: "inbox.routing_ambiguous", payload: { inboxItemId: "item-2", candidateThreadIds: [], distances: [], gap: true } }],
        // slot 3 — resolveCompanyConfig: dial=suggest, autonomyLevel=0 (crew would block)
        [{ crewAutonomyLevel: 0, crewPaused: false, model: "claude-sonnet-4-6", inboundRoutingLevel: "suggest" }],
        [],  // slot 4 — D3 SPEND-brake window count
        [],  // slot 5 — A5/T1.9 run-COUNT brake window count
        [{ runtimeConfig: {}, adapterConfig: {} }], // slot 6 — agent row
        [],  // slot 7 — Phase-4 reclaim-select
      ],
      [
        [{ id: "wr-sug" }], // update[0] = atomic claim RETURNING
        [],                  // update[1] = final status update
      ],
    );

    await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });

    // runAoaAgent MUST be called — autonomyLevel=0 does not block inbox-routing.
    expect(runAoaMock).toHaveBeenCalledWith(
      db,
      "a-nav",
      expect.objectContaining({
        companyId: "co-r2",
        source: "inbox.routing_ambiguous",
        wakeupId: "wr-sug",
        inboxItemId: "item-2",
      }),
    );
  });

  it("D4 (Task 1.6): inbox-routing wakeup at inboundRoutingLevel='auto_attach' with autonomyLevel=0 → runAoaAgent IS called", async () => {
    const db = makeConcurrencyDb(
      [
        [], [],  // slots 0-1
        [{ id: "wr-aa", agentId: "a-nav", companyId: "co-r3", source: "inbox.routing_ambiguous", payload: { inboxItemId: "item-3", candidateThreadIds: ["t5"], distances: [0.1], gap: false } }],
        [{ crewAutonomyLevel: 0, crewPaused: false, model: "claude-sonnet-4-6", inboundRoutingLevel: "auto_attach" }],
        [],  // D3 SPEND-brake count
        [],  // A5/T1.9 run-COUNT brake count
        [{ runtimeConfig: {}, adapterConfig: {} }],
        [],  // Phase-4
      ],
      [
        [{ id: "wr-aa" }], // claim
        [],
      ],
    );

    await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });

    expect(runAoaMock).toHaveBeenCalledWith(
      db, "a-nav",
      expect.objectContaining({ source: "inbox.routing_ambiguous", wakeupId: "wr-aa" }),
    );
  });

  it("D4 (Task 1.6): inbox-routing wakeup at inboundRoutingLevel='full_auto' with autonomyLevel=0 → runAoaAgent IS called", async () => {
    const db = makeConcurrencyDb(
      [
        [], [],
        [{ id: "wr-fa", agentId: "a-nav", companyId: "co-r4", source: "inbox.routing_ambiguous", payload: { inboxItemId: "item-4" } }],
        [{ crewAutonomyLevel: 0, crewPaused: false, model: "claude-sonnet-4-6", inboundRoutingLevel: "full_auto" }],
        [],  // D3 SPEND-brake count
        [],  // A5/T1.9 run-COUNT brake count
        [{ runtimeConfig: {}, adapterConfig: {} }],
        [],  // Phase-4
      ],
      [
        [{ id: "wr-fa" }],
        [],
      ],
    );

    await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });

    expect(runAoaMock).toHaveBeenCalledWith(
      db, "a-nav",
      expect.objectContaining({ source: "inbox.routing_ambiguous", wakeupId: "wr-fa" }),
    );
  });

  // Chronicler infra sweep: like inbox-routing, it must bypass the thread-level
  // crewPaused + useControllerPath gates (it's always-on infrastructure). On a
  // modern thread (useControllerPath=true) the wakeup MUST still reach
  // runAoaAgent — the pre-fix behavior swallowed it at the controller-path gate.
  it("infra sweep (sweep.chronicler) on a useControllerPath thread + autonomyLevel=0 → runAoaAgent IS called (not swallowed)", async () => {
    // C1/C2 reorder: effectiveAutonomy (thread override ?? company) is now
    // resolved BEFORE the autonomy gate (was post-claim). For infra sweeps the
    // crewPaused/useControllerPath threadRow fetch is SKIPPED, so the
    // effectiveAutonomy lookup is the FIRST per-wakeup thread select. New slots:
    //   0 Phase-1, 1 Phase-2, 2 Phase-3 wakeup, 3 resolveCompanyConfig,
    //   4 effectiveAutonomy threadId lookup (chronicler payload HAS threadId),
    //   5 D3 SPEND-brake count, 6 A5/T1.9 run-COUNT brake count, 7 agent row,
    //   8 Phase-4.
    const db = makeConcurrencyDb(
      [
        [],  // 0 Phase-1 orphan-select
        [],  // 1 Phase-2 pending-drain
        // 2 Phase-3 wakeup: chronicler sweep, threadId present, on a controller-path thread
        [{ id: "wr-chr", agentId: "a-chr", companyId: "co-chr", source: "sweep.chronicler", payload: { threadId: "t-cp", role: "chronicler" } }],
        // 3 resolveCompanyConfig: company autonomyLevel=0 (blocks agentic crew, but chronicler:0 passes)
        [{ crewAutonomyLevel: 0, crewPaused: false, model: "claude-sonnet-4-6", inboundRoutingLevel: "off" }],
        // 4 effectiveAutonomy thread lookup — thread sets dial=2 (Drive) to make
        //   the thread override observable in the forwarded payload below.
        [{ crewPaused: false, useControllerPath: true, autonomyLevel: 2 }],
        [],  // 5 D3 SPEND-brake window count
        [],  // 6 A5/T1.9 run-COUNT brake window count
        [{ runtimeConfig: {}, adapterConfig: {} }],  // 7 agent row
        [],  // 8 Phase-4 reclaim-select
      ],
      [
        [{ id: "wr-chr" }],  // update[0] = atomic claim RETURNING
        [],                   // update[1] = final status update
      ],
    );

    await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });

    // chronicler:0 passes the gate regardless; the thread's Drive(2) dial flows
    // through to the runner as effectiveAutonomy — pinning the new pre-gate
    // resolution order against regression.
    expect(runAoaMock).toHaveBeenCalledWith(
      db, "a-chr",
      expect.objectContaining({ companyId: "co-chr", source: "sweep.chronicler", wakeupId: "wr-chr", effectiveAutonomy: 2 }),
    );
  });

  // ── Layer B — trusted fields win over the payload spread ──────────────────
  // A wakeup whose stored payload carries a hostile `companyId` (smuggled via
  // agent.dispatch context on some enqueue path) must NOT redirect the run: the
  // dispatcher sets `companyId: w.companyId` AFTER `...(w.payload)`, so the
  // trusted wakeup-row company wins. Pre-fix companyId sat BEFORE the spread and
  // the payload's value clobbered it — a cross-tenant escalation. Modeled on the
  // chronicler fixture (threadId present → effectiveAutonomy lookup slot).
  it("SECURITY (Layer B): a wakeup payload.companyId does NOT override the trusted w.companyId in the runAoaAgent call", async () => {
    const db = makeConcurrencyDb(
      [
        [],  // 0 Phase-1 orphan-select
        [],  // 1 Phase-2 pending-drain
        // 2 Phase-3 wakeup: trusted row company is "co-chr"; payload smuggles a
        // FOREIGN companyId ("co-EVIL") + spoofed source/wakeupId.
        [{ id: "wr-esc", agentId: "a-chr", companyId: "co-chr", source: "sweep.chronicler", payload: { threadId: "t-cp", role: "chronicler", companyId: "co-EVIL", source: "spoofed", wakeupId: "forged" } }],
        // 3 resolveCompanyConfig
        [{ crewAutonomyLevel: 0, crewPaused: false, model: "claude-sonnet-4-6", inboundRoutingLevel: "off" }],
        // 4 effectiveAutonomy thread lookup
        [{ crewPaused: false, useControllerPath: true, autonomyLevel: 2 }],
        [],  // 5 D3 SPEND-brake window count
        [],  // 6 A5/T1.9 run-COUNT brake window count
        [{ runtimeConfig: {}, adapterConfig: {} }],  // 7 agent row
        [],  // 8 Phase-4 reclaim-select
      ],
      [
        [{ id: "wr-esc" }],  // update[0] = atomic claim RETURNING
        [],                   // update[1] = final status update
      ],
    );

    await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });

    // The trusted wakeup-row company + source + wakeupId win over the payload.
    expect(runAoaMock).toHaveBeenCalledWith(
      db, "a-chr",
      expect.objectContaining({ companyId: "co-chr", source: "sweep.chronicler", wakeupId: "wr-esc" }),
    );
    // Explicit: the foreign payload company was NOT forwarded.
    const forwarded = runAoaMock.mock.calls[0][2] as { companyId?: string };
    expect(forwarded.companyId).toBe("co-chr");
    expect(forwarded.companyId).not.toBe("co-EVIL");
  });

  it("infra sweep (sweep.chronicler) respects thread crewPaused before running", async () => {
    const db = makeConcurrencyDb(
      [
        [],
        [],
        [{ id: "wr-chr-paused", agentId: "a-chr", companyId: "co-chr", source: "sweep.chronicler", payload: { threadId: "t-paused", role: "chronicler" } }],
        [{ crewAutonomyLevel: 0, crewPaused: false, model: "claude-sonnet-4-6", inboundRoutingLevel: "off" }],
        [{ crewPaused: true, useControllerPath: true, autonomyLevel: 2 }],
        [],
      ],
      [
        [],
      ],
    );

    await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });

    expect(runAoaMock).not.toHaveBeenCalled();
    expect(db._sets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "skipped_paused" }),
      ]),
    );
  });
});
