// C1/C2/C3 — role-activation gate must use the EFFECTIVE autonomy dial.
//
// THE BUG (root-caused by audit): the role-activation gate read the COMPANY
// dial (companyCfg.autonomyLevel) while the completion gate read the EFFECTIVE
// dial (thread.autonomyLevel ?? company). They diverge for thread-bearing
// wakeups:
//   C1 — thread=Drive(2), company=Manual(0): an @mentioned crew role (e.g.
//        engineer, min-autonomy 1) was wrongly skipped_autonomy because the
//        gate read company=0. The per-thread Drive override was silently dead.
//   C2 — thread=Manual(0), company=Drive(2): the agent RAN (gate read
//        company=2) and burned an LLM call, but the completion gate (effective
//        dial = thread 0) then refused everything.
// FIX: compute effectiveAutonomy = thread.autonomyLevel ?? company BEFORE the
// activation gate and gate on it. The post-claim duplicate block is removed;
// runAoaAgent reuses the earlier effectiveAutonomy.
//
// C3 — Commander (founder-proxy, identified by runtimeConfig.aoa.role==='lead')
// must NOT be autonomy-gated at Layer 1. It has no trigger role → resolveCrewRole
// returns null → pre-fix it was treated Drive-only and a founder delegating at
// dial 0/1 got silently skipped_autonomy. The fetch query now projects
// agents.runtimeConfig so the gate can exempt Commander unconditionally.
//
// Harness: reuses the makeConcurrencyDb positional-sequence mock (supports
// `.returning()` on update(), needed for the atomic claim). resolveCrewRole and
// budgetService are MODULE-MOCKED (→ null) so they add NO real db.select — the
// positional select-slot order is deterministic. isRoleActiveAtAutonomy +
// ROLE_MIN_AUTONOMY are the REAL implementations so the dial math is genuinely
// tested (NOT mocked — this is the whole point of the suite).
//
// POST-FIX select-slot order inside drainPhase3, per wakeup (thread-bearing,
// non-inbox/non-infra source like 'thread_mention'):
//   0 Phase-1 orphan, 1 Phase-2 pending, 2 Phase-3 wakeup,
//   3 resolveCompanyConfig,
//   4 threadRow pause/controller (fires: !inbox && !infra && threadId present),
//   5 effectiveAutonomy threadId lookup (fires: threadId present) — MOVED EARLIER,
//   -- autonomy gate evaluates on effectiveAutonomy here --
//   6 D3 SPEND-brake count, 7 A5/T1.9 run-COUNT brake count, 8 agent-row model,
//   -- budget pre-flight (mocked → null, no select) + atomic claim + dispatch --
//   9 Phase-4 reclaim (after Promise.all).
// For a wakeup with NO threadId, slots 4 (threadRow) and 5 (effectiveAutonomy)
// do NOT fire.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  consumerMock,
  ensureExtractionMock,
  listOutboxMock,
  publishLiveEventMock,
  runAoaMock,
  mockResolveCrewRole,
} = vi.hoisted(() => ({
  consumerMock: vi.fn().mockResolvedValue(undefined),
  ensureExtractionMock: vi.fn().mockResolvedValue("ext-1"),
  listOutboxMock: vi.fn().mockResolvedValue([]),
  publishLiveEventMock: vi.fn(),
  runAoaMock: vi.fn().mockResolvedValue(undefined),
  mockResolveCrewRole: vi.fn().mockResolvedValue(null),
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
// Cost-caps mocked to always pass: autonomy/effective dial is the gate under
// test. autonomy.js is deliberately NOT mocked — isRoleActiveAtAutonomy and
// ROLE_MIN_AUTONOMY are REAL so the dial math is genuinely exercised.
// kill-switch uses the REAL trivial implementation (companyPaused || threadPaused)
// so case (d) genuinely proves crewPaused blocks even an exempt task-dispatch
// wakeup (the pause gate runs BEFORE the autonomy exemption). Cases (a)-(c) pass
// crewPaused:false + no thread pause, so they are unaffected.
vi.mock("../services/internal-agent/aoa-agents/kill-switch.js", () => ({
  isCrewPaused: (state: { companyPaused: boolean; threadPaused: boolean }) =>
    state.companyPaused || state.threadPaused,
}));
vi.mock("../services/internal-agent/cost-caps.js", () => ({
  runRateExceeded: () => false,
  resolveRoleModel: ({ companyDefault }: { roleModel: string | null; companyDefault: string }) => companyDefault,
  DEFAULT_CREW_RATE_LIMIT: { maxRunsPerWindow: 10, windowMinutes: 10 },
  DEFAULT_CREW_RUN_COUNT_LIMIT: { windowMinutes: 5, maxRunsPerWindow: 40 },
}));
// Leaf role resolver module-mocked → null so it issues NO real db.select (keeps
// the positional select-slot order deterministic). Cases that use a payload.role
// take the payload-role branch and never consult this; the Commander case (C3)
// relies on it returning null (no trigger role) to prove the exemption fires
// REGARDLESS of an unresolved crew role.
vi.mock("../services/internal-agent/aoa-agents/resolve-crew-role.js", () => ({
  resolveCrewRole: mockResolveCrewRole,
}));
// Budget pre-flight → null (clear) so it issues NO real db.select on
// budgetPolicies and the positional select-slot order stays deterministic.
vi.mock("../services/budgets.js", () => ({
  budgetService: () => ({ getInvocationBlock: vi.fn().mockResolvedValue(null) }),
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

// makeConcurrencyDb — verbatim the harness from aoa-dispatcher.test.ts. Supports
// `.returning()` on update() (atomic-claim path) and records `_sets` + the
// positional `_selectOrder`.
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

const skippedAutonomy = (s: any) => s.status === "skipped_autonomy";

describe("runAoaDispatch — role-activation gates on EFFECTIVE autonomy (C1/C2/C3)", () => {
  beforeEach(() => {
    consumerMock.mockClear();
    ensureExtractionMock.mockClear();
    listOutboxMock.mockClear();
    publishLiveEventMock.mockClear();
    runAoaMock.mockClear();
    mockResolveCrewRole.mockClear();
    runAoaMock.mockResolvedValue(undefined);
    mockResolveCrewRole.mockResolvedValue(null);
    listOutboxMock.mockResolvedValue([]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // (a) C1 PROOF: thread=2 (Drive), company=0 (Manual), role=engineer (min 1).
  // Pre-fix the gate read company=0 → engineer inactive → skipped_autonomy (the
  // per-thread Drive override was silently dead). Post-fix: effective=thread=2 →
  // engineer active (2≥1) → NOT skipped, runAoaAgent IS called.
  it("(a) C1: thread=Drive(2) + company=Manual(0) + engineer → NOT skipped; runAoaAgent IS called", async () => {
    const db = makeConcurrencyDb(
      [
        [], // 0 Phase-1 orphan
        [], // 1 Phase-2 pending
        // 2 Phase-3 wakeup: thread-bearing @mention for an engineer, runtimeConfig present (not Commander)
        [{ id: "w-c1", agentId: "a-c1", companyId: "co-c1", source: "thread_mention", runtimeConfig: { aoa: { role: "member" } }, payload: { threadId: "th-drive", role: "engineer" } }],
        // 3 resolveCompanyConfig: company=Manual(0)
        [{ crewAutonomyLevel: 0, crewPaused: false, model: "claude-sonnet-4-6", inboundRoutingLevel: "off" }],
        // 4 threadRow pause/controller/effective-autonomy lookup
        [{ crewPaused: false, useControllerPath: false, autonomyLevel: 2 }],
        // 5 D3 SPEND-brake count
        [],
        // 6 A5/T1.9 run-COUNT brake count
        [],
        // 7 agent-row model select
        [{ runtimeConfig: { aoa: { role: "member" } }, adapterConfig: {} }],
        // 8 Phase-4 failed-run reclaim-select (after Promise.all)
        [],
      ],
      [
        [{ id: "w-c1" }], // update[0] = atomic claim RETURNING (claimed)
        [],                // update[1] = final status update
      ],
    );

    await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });

    // C1 fixed: the wakeup was NOT gated out by the company dial.
    expect((db._sets as any[]).some(skippedAutonomy)).toBe(false);
    expect(runAoaMock).toHaveBeenCalledWith(
      db,
      "a-c1",
      expect.objectContaining({ companyId: "co-c1", source: "thread_mention", wakeupId: "w-c1" }),
    );
  });

  // (b) C2 PROOF: thread=0 (Manual), company=2 (Drive), role=engineer.
  // Pre-fix the gate read company=2 → engineer active → it RAN and burned an LLM
  // call (then the completion gate refused everything). Post-fix: effective=
  // thread=0 → engineer inactive (0<1) → SKIPPED skipped_autonomy at the gate,
  // runAoaAgent NOT called (no wasted LLM call).
  it("(b) C2: thread=Manual(0) + company=Drive(2) + engineer → skipped_autonomy; runAoaAgent NOT called", async () => {
    const db = makeConcurrencyDb(
      [
        [], // 0 Phase-1 orphan
        [], // 1 Phase-2 pending
        // 2 Phase-3 wakeup
        [{ id: "w-c2", agentId: "a-c2", companyId: "co-c2", source: "thread_mention", runtimeConfig: { aoa: { role: "member" } }, payload: { threadId: "th-manual", role: "engineer" } }],
        // 3 resolveCompanyConfig: company=Drive(2)
        [{ crewAutonomyLevel: 2, crewPaused: false, model: "claude-sonnet-4-6", inboundRoutingLevel: "off" }],
        // 4 threadRow pause/controller/effective-autonomy lookup → thread dial = 0 (Manual)
        [{ crewPaused: false, useControllerPath: false, autonomyLevel: 0 }],
        // 5 Phase-4 failed-run reclaim-select (early-return at autonomy gate → no brake/agent/claim selects)
        [],
      ],
      [
        // No atomic claim — the skip is an early return; only the skipped_autonomy
        // write occurs (it does not use .returning()).
      ],
    );

    await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });

    const skipSet = (db._sets as any[]).find(skippedAutonomy);
    expect(skipSet).toBeDefined();
    expect(skipSet.finishedAt).toBeInstanceOf(Date);
    expect(runAoaMock).not.toHaveBeenCalled();
  });

  // (c) C1/C2 PROOF — forwarded value: the effectiveAutonomy forwarded into
  // runAoaAgent must equal the THREAD value (2), NOT the company value (0).
  // Same fixture as (a) but asserts the forwarded payload field.
  it("(c) forwarded effectiveAutonomy into runAoaAgent equals the THREAD value (2), not company (0)", async () => {
    const db = makeConcurrencyDb(
      [
        [],
        [],
        [{ id: "w-c3", agentId: "a-c3", companyId: "co-c3", source: "thread_mention", runtimeConfig: { aoa: { role: "member" } }, payload: { threadId: "th-drive2", role: "engineer" } }],
        [{ crewAutonomyLevel: 0, crewPaused: false, model: "claude-sonnet-4-6", inboundRoutingLevel: "off" }], // company Manual(0)
        [{ crewPaused: false, useControllerPath: false, autonomyLevel: 2 }], // threadRow/effectiveAutonomy → thread Drive(2)
        [],
        [],
        [{ runtimeConfig: { aoa: { role: "member" } }, adapterConfig: {} }],
        [],
      ],
      [
        [{ id: "w-c3" }],
        [],
      ],
    );

    await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });

    expect(runAoaMock).toHaveBeenCalledWith(
      db,
      "a-c3",
      expect.objectContaining({ effectiveAutonomy: 2 }),
    );
  });

  // (d) C3 PROOF: Commander (runtimeConfig.aoa.role==='lead') at company dial 0
  // is NOT skipped_autonomy. It has no trigger role (resolveCrewRole → null), so
  // pre-fix it was treated Drive-only and skipped at dial 0. The exemption makes
  // it run unconditionally. No threadId (founder-proxy) → no thread lookups.
  it("(d) C3: Commander (runtimeConfig.aoa.role==='lead') at company=Manual(0) → NOT skipped_autonomy; runAoaAgent IS called", async () => {
    mockResolveCrewRole.mockResolvedValue(null); // no crew trigger role
    const db = makeConcurrencyDb(
      [
        [], // 0 Phase-1 orphan
        [], // 1 Phase-2 pending
        // 2 Phase-3 wakeup: Commander agent (lead). No threadId → no thread lookups.
        [{ id: "w-cmd", agentId: "a-cmd", companyId: "co-cmd", source: "thread_mention", runtimeConfig: { aoa: { role: "lead" } }, payload: {} }],
        // 3 resolveCompanyConfig: company=Manual(0)
        [{ crewAutonomyLevel: 0, crewPaused: false, model: "claude-sonnet-4-6", inboundRoutingLevel: "off" }],
        // (no threadRow lookup: no threadId; no effectiveAutonomy lookup: no threadId)
        // 4 D3 SPEND-brake count
        [],
        // 5 A5/T1.9 run-COUNT brake count
        [],
        // 6 agent-row model select
        [{ runtimeConfig: { aoa: { role: "lead" } }, adapterConfig: {} }],
        // 7 Phase-4 reclaim-select
        [],
      ],
      [
        [{ id: "w-cmd" }], // atomic claim RETURNING
        [],                 // final status update
      ],
    );

    await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });

    // Commander is exempt from the autonomy gate even at dial 0.
    expect((db._sets as any[]).some(skippedAutonomy)).toBe(false);
    expect(runAoaMock).toHaveBeenCalledWith(
      db,
      "a-cmd",
      expect.objectContaining({ companyId: "co-cmd", wakeupId: "w-cmd" }),
    );
  });

  // (e) REGRESSION: a TASK wakeup (NO threadId) at company=0 still skips a min-1
  // role. effectiveAutonomy falls back to company (no threadId lookup) so the gate
  // behaves exactly as before for task wakeups. Proves the move did NOT change
  // task-wakeup behavior.
  it("(e) regression: TASK wakeup (no threadId) at company=Manual(0) + engineer → still skipped_autonomy (unchanged)", async () => {
    const db = makeConcurrencyDb(
      [
        [], // 0 Phase-1 orphan
        [], // 1 Phase-2 pending
        // 2 Phase-3 wakeup: a task wakeup, no threadId, payload.role=engineer (min 1)
        [{ id: "w-task", agentId: "a-task", companyId: "co-task", source: "wakeup", runtimeConfig: { aoa: { role: "member" } }, payload: { role: "engineer" } }],
        // 3 resolveCompanyConfig: company=Manual(0)
        [{ crewAutonomyLevel: 0, crewPaused: false, model: "claude-sonnet-4-6", inboundRoutingLevel: "off" }],
        // (no threadId → no threadRow lookup, no effectiveAutonomy lookup)
        // 4 Phase-4 reclaim-select (after the autonomy-gate early return)
        [],
      ],
      [],
    );

    await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });

    const skipSet = (db._sets as any[]).find(skippedAutonomy);
    expect(skipSet).toBeDefined();
    expect(skipSet.finishedAt).toBeInstanceOf(Date);
    expect(runAoaMock).not.toHaveBeenCalled();
  });

  // ── Founder decision (2026-07-04): explicit authorization overrides the dial ──
  // The company crew-autonomy dial gates agent-INITIATED work only. A task-
  // dispatch wakeup carries an explicit human/upstream authorization (crew_dispatch
  // approve, planning→standard flip, direct assignment, dependency-unblock) and
  // flows through enqueueIssueAssigneeWakeup / the PATCH-reassign path, which stamp
  // `payload.issueId` (string) + `source` ∈ {assignment, automation}. The dispatcher
  // exempts exactly that shape from the role-autonomy gate BEFORE it fires.
  // crewPaused (kill-switch) + thread-pause + budget/run-count brakes stay in force.
  //
  // Select-slot order for an EXEMPT dispatch (no threadId → no threadRow/effective
  // lookup; gate bypassed so resolveCrewRole/payload-role branch issues no select):
  //   0 orphan, 1 pending, 2 wakeup, 3 companyConfig,
  //   4 D3 spend-brake, 5 run-count brake, 6 agent-row, 7 Phase-4 reclaim.
  //   returning: [0]=atomic claim, [1]=final status update.

  // (a) crew_dispatch-approve shape: issueId + source "assignment" at company
  // Manual(0), role=engineer (min 1). Pre-fix: skipped_autonomy (company 0 < 1).
  // Post-fix: exempt → reaches dispatch, runAoaAgent IS called.
  it("(a) exempt: issueId + source=assignment at company=Manual(0) + engineer → NOT skipped; runAoaAgent IS called", async () => {
    const db = makeConcurrencyDb(
      [
        [], // 0 orphan
        [], // 1 pending
        // 2 Phase-3 wakeup: task-dispatch (assignment) — issueId present, NO threadId
        [{ id: "w-asn", agentId: "a-asn", companyId: "co-asn", source: "assignment", runtimeConfig: { aoa: { role: "member" } }, payload: { issueId: "iss-1", role: "engineer" } }],
        // 3 resolveCompanyConfig: company=Manual(0)
        [{ crewAutonomyLevel: 0, crewPaused: false, model: "claude-sonnet-4-6", inboundRoutingLevel: "off" }],
        // 4 D3 SPEND-brake count
        [],
        // 5 run-COUNT brake count
        [],
        // 6 agent-row model select
        [{ runtimeConfig: { aoa: { role: "member" } }, adapterConfig: {} }],
        // 7 Phase-4 reclaim-select
        [],
      ],
      [
        [{ id: "w-asn" }], // atomic claim RETURNING
        [],                 // final status update
      ],
    );

    await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });

    expect((db._sets as any[]).some(skippedAutonomy)).toBe(false);
    expect(runAoaMock).toHaveBeenCalledWith(
      db,
      "a-asn",
      expect.objectContaining({ companyId: "co-asn", source: "assignment", wakeupId: "w-asn" }),
    );
  });

  // (b) automation shape: issueId + source "automation" (crew_task_auto_approved,
  // dependency-unblock) at company Manual(0) + engineer → exempt → dispatches.
  it("(b) exempt: issueId + source=automation at company=Manual(0) + engineer → NOT skipped; runAoaAgent IS called", async () => {
    const db = makeConcurrencyDb(
      [
        [], // 0 orphan
        [], // 1 pending
        // 2 Phase-3 wakeup: task-dispatch (automation) — issueId present, NO threadId
        [{ id: "w-aut", agentId: "a-aut", companyId: "co-aut", source: "automation", runtimeConfig: { aoa: { role: "member" } }, payload: { issueId: "iss-2", role: "engineer" } }],
        // 3 resolveCompanyConfig: company=Manual(0)
        [{ crewAutonomyLevel: 0, crewPaused: false, model: "claude-sonnet-4-6", inboundRoutingLevel: "off" }],
        // 4 D3 SPEND-brake count
        [],
        // 5 run-COUNT brake count
        [],
        // 6 agent-row model select
        [{ runtimeConfig: { aoa: { role: "member" } }, adapterConfig: {} }],
        // 7 Phase-4 reclaim-select
        [],
      ],
      [
        [{ id: "w-aut" }], // atomic claim RETURNING
        [],                 // final status update
      ],
    );

    await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });

    expect((db._sets as any[]).some(skippedAutonomy)).toBe(false);
    expect(runAoaMock).toHaveBeenCalledWith(
      db,
      "a-aut",
      expect.objectContaining({ companyId: "co-aut", source: "automation", wakeupId: "w-aut" }),
    );
  });

  // (c) GATE INTACT: an agent-INITIATED mention wake (source=thread_mention) with a
  // min-1 role at company Manual(0) is NOT exempt (source not in {assignment,
  // automation}; no issueId) → still skipped_autonomy. Also cover the belt-and-
  // suspenders case where a mention payload happens to carry an issueId: the source
  // gate alone keeps it gated.
  it("(c) gate intact: thread_mention wake (min-1 role) at company=Manual(0) → still skipped_autonomy", async () => {
    const db = makeConcurrencyDb(
      [
        [], // 0 orphan
        [], // 1 pending
        // 2 Phase-3 wakeup: a mention wake carrying an issueId but source=thread_mention.
        // No threadId → gate reads company dial; source not exempt → stays gated.
        [{ id: "w-men", agentId: "a-men", companyId: "co-men", source: "thread_mention", runtimeConfig: { aoa: { role: "member" } }, payload: { issueId: "iss-3", role: "engineer" } }],
        // 3 resolveCompanyConfig: company=Manual(0)
        [{ crewAutonomyLevel: 0, crewPaused: false, model: "claude-sonnet-4-6", inboundRoutingLevel: "off" }],
        // 4 Phase-4 reclaim-select (early return at the autonomy gate)
        [],
      ],
      [],
    );

    await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });

    const skipSet = (db._sets as any[]).find(skippedAutonomy);
    expect(skipSet).toBeDefined();
    expect(skipSet.finishedAt).toBeInstanceOf(Date);
    expect(runAoaMock).not.toHaveBeenCalled();
  });

  // (d) KILL-SWITCH still wins: crewPaused blocks even an exempt task-dispatch
  // wakeup. The pause gate runs BEFORE the autonomy gate, so the exemption never
  // gets a chance to run it. Assert skipped_paused (not skipped_autonomy) and no
  // dispatch. Uses a per-test kill-switch mock so isCrewPaused returns true.
  it("(d) crewPaused blocks the exempt wakeup too → skipped_paused; runAoaAgent NOT called", async () => {
    const db = makeConcurrencyDb(
      [
        [], // 0 orphan
        [], // 1 pending
        // 2 Phase-3 wakeup: exempt-shaped (assignment + issueId) but company crewPaused
        [{ id: "w-kill", agentId: "a-kill", companyId: "co-kill", source: "assignment", runtimeConfig: { aoa: { role: "member" } }, payload: { issueId: "iss-4", role: "engineer" } }],
        // 3 resolveCompanyConfig: crewPaused=true
        [{ crewAutonomyLevel: 0, crewPaused: true, model: "claude-sonnet-4-6", inboundRoutingLevel: "off" }],
        // 4 Phase-4 reclaim-select (early return at the pause gate)
        [],
      ],
      [],
    );

    await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });

    const sets = db._sets as any[];
    // crewPaused → skipped_paused, NOT skipped_autonomy, NOT dispatch.
    expect(sets.some((s: any) => s.status === "skipped_paused")).toBe(true);
    expect(sets.some(skippedAutonomy)).toBe(false);
    expect(runAoaMock).not.toHaveBeenCalled();
  });
});
