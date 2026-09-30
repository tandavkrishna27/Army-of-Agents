import { beforeEach, describe, expect, it, vi } from "vitest";
const { failContinuationMock, runAoaMock } = vi.hoisted(() => ({
  failContinuationMock: vi.fn().mockResolvedValue(null),
  runAoaMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/internal-agent/aoa-agents/runner.js", () => ({ runAoaAgent: runAoaMock }));
vi.mock("../services/work-question-continuation-terminal.js", () => ({
  failUnstartedInternalAgentWorkQuestionContinuation: failContinuationMock,
  finalizeInternalAgentWorkQuestionContinuation: vi.fn().mockResolvedValue(null),
}));
vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ and: a }),
  or: (...a: unknown[]) => ({ or: a }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  lt: (a: unknown, b: unknown) => ({ lt: [a, b] }),
  lte: (a: unknown, b: unknown) => ({ lte: [a, b] }),
  gt: (a: unknown, b: unknown) => ({ gt: [a, b] }),
  desc: (a: unknown) => ({ desc: a }),
  isNull: (a: unknown) => ({ isNull: a }),
  inArray: (a: unknown, b: unknown) => ({ inArray: [a, b] }),
  notInArray: (a: unknown, b: unknown) => ({ notInArray: [a, b] }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings.join("?"), values }),
}));
vi.mock("@armyofagents/db", () => {
  const t = (n: string) => new Proxy({}, { get: (_x, p) => typeof p === "string" ? Symbol(`${n}.${p}`) : undefined });
  return {
    agentWakeupRequests: t("awr"),
    agents: t("a"),
    discussionEntries: t("de"),
    discussions: t("d"),
    issues: t("i"),
    internalAgentConfig: t("iac"),
    internalAgentRuns: t("iar"),
    workQuestions: t("wq"),
  };
});
vi.mock("../services/internal-agent/aoa-agents/triggers.js", () => ({
  listEnabledOutboxAgents: vi.fn().mockResolvedValue([]),
}));
// A2 (fail-closed autonomy): the dispatcher now resolves an absent/unknown
// payload.role via the leaf resolveCrewRole. Module-mock it (→ null) so it adds
// NO real db.select — the positional select sequence in makePhase3Db stays
// intact. Fixtures that must DISPATCH carry a known payload.role (adjutant,
// min-autonomy 0) so they legitimately pass the gate at autonomyLevel 0; pre-A2
// these dispatched with no role, which was the bug the gate fixes.
vi.mock("../services/internal-agent/aoa-agents/resolve-crew-role.js", () => ({
  resolveCrewRole: vi.fn().mockResolvedValue(null),
}));
// A3: pre-spend budget hard-stop. Module-mock budgetService → getInvocationBlock
// returns null (budget clear) so it adds NO real db.select on budgetPolicies and
// the positional select sequence in makePhase3Db stays intact.
vi.mock("../services/budgets.js", () => ({
  budgetService: () => ({ getInvocationBlock: vi.fn().mockResolvedValue(null) }),
}));
vi.mock("../middleware/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
import { runAoaDispatch } from "../services/internal-agent/aoa-agents/dispatcher.js";

/**
 * Build a chainable select mock that resolves to `val` when awaited.
 * The `.then(fn)` method correctly calls `fn(val)` so that `await chain`
 * and `.then(resolve)` both work.
 */
function makeSelectChain(val: unknown): any {
  const chain: any = {
    from: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    for: () => chain,
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(val).then(resolve, reject),
  };
  return chain;
}

/**
 * Build a sequence-based mock db for Phase-3 tests.
 *
 * selectResults: array of values returned in order for each db.select() call.
 * Each update().set(v) → calls onSet(v, idx) and returns a where() object that:
 *   - .returning() → resolves to returningResults[idx] (or [])
 *   - is itself awaitable (plain update path) resolving to undefined
 */
function makePhase3Db(
  selectResults: unknown[],
  returningResults: unknown[][],
  onSet?: (v: unknown, idx: number) => void,
  onWhere?: (condition: unknown, idx: number) => void,
) {
  let selectIdx = 0;
  let updateIdx = 0;

  const db: any = {
    transaction: (callback: (tx: unknown) => unknown) => callback(db),
    select: () => {
      const val = selectResults[selectIdx++] ?? [];
      return makeSelectChain(val);
    },
    update: () => ({
      set: (v: unknown) => {
        const idx = updateIdx++;
        onSet?.(v, idx);
        const ret = returningResults[idx] ?? [];
        return {
          where: (condition: unknown) => {
            onWhere?.(condition, idx);
            return {
            // Support .returning() for the claim update
            returning: () => Promise.resolve(ret),
            // Support plain await (done/failed update)
            then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
              Promise.resolve(undefined).then(resolve, reject),
            };
          },
        };
      },
    }),
  };
  return db;
}

describe("aoa-wakeup-dispatch", () => {
  beforeEach(() => {
    failContinuationMock.mockClear();
    runAoaMock.mockClear();
    runAoaMock.mockResolvedValue({ status: "succeeded", runId: "run-1", errorMessage: null });
  });

  it("claims a queued wakeup for a kind='aoa' agent and runs it", async () => {
    // db call sequence:
    // select[0]: Phase 1 orphan select → []
    // select[1]: Phase 2 outbox select → []
    // select[2]: Phase 3 wakeup select → [{ id:'w1', agentId:'a1', companyId:'co-1', payload:{note:'x'} }]
    // update[0].set({status:'processing',...}).where().returning() → [{ id:'w1' }]  (claim)
    // update[1].set({status:'done',...}).where() → undefined  (done)
    const db = makePhase3Db(
      [
        [], // Phase 1 orphan
        [], // Phase 2 outbox
        // T1.2 (codex F6): the dispatcher now selects `source` from
        // agentWakeupRequests and passes it through to runAoaAgent unchanged
        // (previously hardcoded "wakeup", losing the real trigger context).
        // Test fixtures must include source so the pass-through is observable.
        // A2: payload carries a known role (adjutant, min-autonomy 0) so the
        // fail-closed gate dispatches it at autonomyLevel 0. note:"x" is still
        // asserted to flow through; role is not asserted (objectContaining).
        [{ id: "w1", agentId: "a1", companyId: "co-1", source: "thread_mention", payload: { role: "adjutant", note: "x" } }], // Phase 3 wakeup rows
        [{ crewAutonomyLevel: 0, crewPaused: false, model: "claude-sonnet-4-20250514" }], // resolveCompanyConfig
        [], // D3 SPEND-brake window count (paid runs only: internalAgentRuns gt costCents 0)
        [], // A5/T1.9 run-COUNT brake window count (ALL runs; real runRateExceeded → 0 < 40 passes)
        [{ runtimeConfig: {}, adapterConfig: {} }], // agent row select
        [], // Phase 4 failedRunRows
      ],
      [
        [{ id: "w1" }], // claim RETURNING
        [],             // done update (not used via returning)
      ],
    );

    await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });

    expect(runAoaMock).toHaveBeenCalledWith(db, "a1", expect.objectContaining({
      companyId: "co-1",
      // T1.2 (codex F6): the ORIGINAL wakeup source flows through, not the
      // pre-T1.2 hardcoded "wakeup". Asserting against the actual fixture
      // ("thread_mention") is what pins this fix against future regressions.
      source: "thread_mention",
      wakeupId: "w1",
      note: "x",
    }));
  });

  it("skips a wakeup that is already claimed by another concurrent tick", async () => {
    // claim RETURNING is [] → already claimed by someone else
    const db = makePhase3Db(
      [
        [],
        [],
        // A2: known role so this wakeup PASSES the autonomy gate and reaches
        // the atomic claim — the claim then returns [] (already taken by a
        // concurrent tick), which is the race path this test actually pins.
        // Without a role the fail-closed gate would skip it at autonomy 0 and
        // the claim-race assertion below would pass for the wrong reason.
        [{ id: "w2", agentId: "a2", companyId: "co-2", source: "sweep.adjutant", payload: { role: "adjutant" } }], // Phase 3 wakeup rows
        [{ crewAutonomyLevel: 0, crewPaused: false, model: "claude-sonnet-4-20250514" }], // resolveCompanyConfig
        [], // D3 SPEND-brake window count (paid runs only)
        [], // A5/T1.9 run-COUNT brake window count (ALL runs → 0 < 40 passes)
        [{ runtimeConfig: {}, adapterConfig: {} }], // agent row select
        [], // Phase 4 failedRunRows
      ],
      [
        [], // claim returns empty → already claimed
      ],
    );

    await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });

    expect(runAoaMock).not.toHaveBeenCalled();
  });

  it("does not fail a continuation when a policy skip loses the queued-row race", async () => {
    const db = makePhase3Db(
      [
        [],
        [],
        [{
          id: "w-policy-race",
          agentId: "a-policy-race",
          companyId: "co-policy-race",
          source: "work_question_continuation",
          idempotencyKey: "work-question:q-policy:answer:1",
          payload: { issueId: "issue-policy-race", questionId: "q-policy" },
        }],
        [{ crewAutonomyLevel: 0, crewPaused: true, model: "claude-sonnet-4-20250514" }],
        [],
      ],
      [
        [], // queued -> skipped_paused lost to a concurrent processing claim
      ],
    );

    await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });

    expect(failContinuationMock).not.toHaveBeenCalled();
    expect(runAoaMock).not.toHaveBeenCalled();
  });

  it("fails a continuation only after winning the queued policy-skip transition", async () => {
    const db = makePhase3Db(
      [
        [],
        [],
        [{
          id: "w-policy-winner",
          agentId: "a-policy-winner",
          companyId: "co-policy-winner",
          source: "work_question_continuation",
          idempotencyKey: "work-question:q-policy-winner:answer:1",
          payload: { issueId: "issue-policy-winner", questionId: "q-policy-winner" },
        }],
        [{ crewAutonomyLevel: 0, crewPaused: true, model: "claude-sonnet-4-20250514" }],
        [],
      ],
      [
        [{ id: "w-policy-winner" }],
      ],
    );

    await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });

    expect(failContinuationMock).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        companyId: "co-policy-winner",
        idempotencyKey: "work-question:q-policy-winner:answer:1",
        error: "Crew continuation blocked by the crew pause policy",
      }),
    );
    expect(runAoaMock).not.toHaveBeenCalled();
  });

  it("marks a wakeup as failed when runAoaAgent throws", async () => {
    runAoaMock.mockRejectedValueOnce(new Error("agent exploded"));

    const capturedSets: unknown[] = [];

    const db = makePhase3Db(
      [
        [],
        [],
        // A2: known role (adjutant, min-autonomy 0) so the fail-closed gate
        // dispatches it at autonomyLevel 0 and runAoaAgent is invoked (then
        // throws, exercising the failure path).
        [{ id: "w3", agentId: "a3", companyId: "co-3", source: "phase-advance", payload: { role: "adjutant" } }], // Phase 3 wakeup rows
        [{ crewAutonomyLevel: 0, crewPaused: false, model: "claude-sonnet-4-20250514" }], // resolveCompanyConfig
        [], // D3 SPEND-brake window count (paid runs only)
        [], // A5/T1.9 run-COUNT brake window count (ALL runs → 0 < 40 passes)
        [{ runtimeConfig: {}, adapterConfig: {} }], // agent row select
        [], // Phase 4 failedRunRows
      ],
      [
        [{ id: "w3" }], // claim RETURNING
        [],             // failed update (not used via returning)
      ],
      (v, _idx) => capturedSets.push(v),
    );

    await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });

    expect(runAoaMock).toHaveBeenCalledWith(db, "a3", expect.objectContaining({
      companyId: "co-3",
      // T1.2 (codex F6): original source flows through (was hardcoded "wakeup").
      source: "phase-advance",
      wakeupId: "w3",
    }));

    const failedUpdate = capturedSets.find((s: any) => s.status === "failed");
    expect(failedUpdate).toBeDefined();
    expect((failedUpdate as any).error).toBe("agent exploded");
  });

  it("recovers an expired processing wakeup and fences the terminal write with the new claim token", async () => {
    const capturedSets: any[] = [];
    const capturedWhere: any[] = [];
    const db = makePhase3Db(
      [
        [],
        [],
        [{
          id: "w-stale",
          agentId: "a-stale",
          companyId: "co-stale",
          source: "work_question_continuation",
          status: "processing",
          attempts: 1,
          idempotencyKey: "continuation-1",
          payload: { role: "adjutant" },
        }],
        [{
          runId: null,
          source: "work_question_continuation",
          idempotencyKey: "continuation-1",
          attempts: 1,
          leaseExpiresAt: new Date(0),
        }],
        [],
        [{ crewAutonomyLevel: 0, crewPaused: false, model: "claude-sonnet-4-20250514" }],
        [],
        [],
        [{ runtimeConfig: {}, adapterConfig: {} }],
        [],
      ],
      [
        [],
        [{ id: "w-stale", attempts: 2 }],
        [],
      ],
      (value) => capturedSets.push(value),
      (condition) => capturedWhere.push(condition),
    );

    await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });

    const recoverySet = capturedSets.find((value) => value.status === "queued");
    const claimSet = capturedSets.find((value) => value.status === "processing");
    const terminalSet = capturedSets.find((value) => value.status === "succeeded");
    expect(recoverySet).toMatchObject({ claimToken: null, leaseExpiresAt: null });
    expect(claimSet.claimToken).toEqual(expect.any(String));
    expect(claimSet.leaseExpiresAt).toBeInstanceOf(Date);
    expect(terminalSet).toMatchObject({ claimToken: null, leaseExpiresAt: null });
    expect(capturedWhere.at(-1)).toEqual(expect.objectContaining({
      and: expect.arrayContaining([
        expect.objectContaining({ eq: [expect.anything(), claimSet.claimToken] }),
      ]),
    }));
  });
});
