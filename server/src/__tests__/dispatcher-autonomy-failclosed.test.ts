// A2 — Fail-closed autonomy gate (crew-dispatch-hardening Task 3).
//
// The Phase-3 crew-wakeup autonomy gate must FAIL CLOSED: a wakeup whose role
// cannot be resolved (no payload.role AND no aoaAgentTriggers row) must NOT be
// a free pass through the autonomy dial. The pre-fix gate only fired
// `if (payloadRole && !isRoleActiveAtAutonomy(...))`, so a wakeup with NO
// payload.role SKIPPED the gate entirely and ran regardless of the dial — the
// live bug. The corrected gate resolves the role (payload.role first, then the
// leaf `resolveCrewRole`) and, when the role is still unresolved, treats it as
// Drive-only (autonomyLevel ≥ 2).
//
// Harness: reuses the makeConcurrencyDb positional-sequence mock from
// aoa-dispatcher.test.ts (it supports `.returning()` on update(), needed for
// the atomic claim path). The leaf `resolveCrewRole` is MODULE-MOCKED so it
// adds NO real db.select — the positional select-slot order is therefore the
// same as the existing dispatcher tests (slot 0 Phase-1, 1 Phase-2, 2 Phase-3
// wakeup, 3 resolveCompanyConfig, …). Autonomy is the ONLY gate exercised:
// kill-switch + rate-brake are mocked to always pass, and isRoleActiveAtAutonomy
// is REAL here (not mocked) so the dial math is genuinely tested.
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
// Kill-switch + cost-caps mocked to always pass: autonomy is the gate under
// test. NOTE: autonomy.js is deliberately NOT mocked here — isRoleActiveAtAutonomy
// and ROLE_MIN_AUTONOMY are the REAL implementations so the dial math is tested.
vi.mock("../services/internal-agent/aoa-agents/kill-switch.js", () => ({
  isCrewPaused: () => false,
}));
vi.mock("../services/internal-agent/cost-caps.js", () => ({
  runRateExceeded: () => false,
  resolveRoleModel: ({ companyDefault }: { roleModel: string | null; companyDefault: string }) => companyDefault,
  DEFAULT_CREW_RATE_LIMIT: { maxRunsPerWindow: 10, windowMinutes: 10 },
  // A5: run-COUNT brake constant. runRateExceeded mocked → false so it never
  // fires; its select still runs (one extra slot AFTER the D3 spend-brake count)
  // on the dispatch path (test 3). Tests 1/2 skip at the autonomy gate first.
  DEFAULT_CREW_RUN_COUNT_LIMIT: { windowMinutes: 5, maxRunsPerWindow: 40 },
}));
// THE KEY MOCK: the leaf role resolver. Module-mocked so it issues NO real
// db.select (keeps the positional select-slot order identical to the existing
// dispatcher tests). Each test sets its return value explicitly.
vi.mock("../services/internal-agent/aoa-agents/resolve-crew-role.js", () => ({
  resolveCrewRole: mockResolveCrewRole,
}));
// A3: pre-spend budget hard-stop. The dispatch path (test 3) now runs a budget
// pre-flight before the atomic claim. Module-mock budgetService → getInvocationBlock
// returns null (budget clear) so it issues NO real db.select on budgetPolicies and
// the positional select-slot order in makeConcurrencyDb stays identical to the
// other dispatcher suites (a real call would consume slots 4-5 and shift them).
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

// makeConcurrencyDb — adapted verbatim from aoa-dispatcher.test.ts. Supports
// `.returning()` on update() (atomic-claim path) and records `_sets` (every
// update().set(v)) + `_selectOrder` (positional select slot order).
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

describe("runAoaDispatch — fail-closed autonomy gate (A2)", () => {
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

  // (1) THE LIVE BUG: company autonomy 0, wakeup has NO payload.role, and the
  // leaf resolver returns null (no aoaAgentTriggers row). Pre-fix this ran
  // anyway (the gate's `if (payloadRole && …)` short-circuited on the absent
  // role). Post-fix: unresolved role → Drive-only → autonomy 0 < 2 → SKIPPED.
  it("(1) autonomy 0, no payload.role, resolveCrewRole→null → skipped_autonomy AND runAoaAgent NOT called", async () => {
    mockResolveCrewRole.mockResolvedValue(null);
    const db = makeConcurrencyDb(
      [
        [], // slot 0 — Phase-1 orphan-select
        [], // slot 1 — Phase-2 pending-drain
        // slot 2 — Phase-3 wakeup-select: a queued aoa wakeup with NO role in payload.
        [{ id: "w-norole", agentId: "a1", companyId: "co-1", source: "thread_mention", payload: {} }],
        // slot 3 — resolveCompanyConfig: autonomyLevel 0 (Manual)
        [{ crewAutonomyLevel: 0, crewPaused: false, model: "claude-sonnet-4-6", inboundRoutingLevel: "off" }],
        // Phase-4 reclaim-select (after Promise.all). No threadId in payload, no
        // rate-brake/agent-row selects (early-return fires first), so this is slot 4.
        [],
      ],
      [
        // No atomic claim happens (skip is an early return), so the only update
        // is the skipped_autonomy write — which does not use .returning().
      ],
    );

    await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });

    const skipSet = (db._sets as any[]).find(skippedAutonomy);
    expect(skipSet).toBeDefined();
    expect(skipSet.finishedAt).toBeInstanceOf(Date);
    expect(runAoaMock).not.toHaveBeenCalled();
    // The leaf resolver was consulted because payload.role was absent.
    expect(mockResolveCrewRole).toHaveBeenCalledWith(db, "a1");
  });

  // (2) autonomy 0, resolver returns 'engineer' (ROLE_MIN_AUTONOMY.engineer = 1).
  // 0 < 1 → not active → skipped_autonomy. (Role resolved via the leaf, not the
  // payload — confirms the leaf-resolved path is also gated correctly.)
  it("(2) autonomy 0, resolveCrewRole→'engineer' (min 1) → skipped_autonomy", async () => {
    mockResolveCrewRole.mockResolvedValue("engineer");
    const db = makeConcurrencyDb(
      [
        [],
        [],
        [{ id: "w-eng", agentId: "a2", companyId: "co-2", source: "thread_mention", payload: {} }],
        [{ crewAutonomyLevel: 0, crewPaused: false, model: "claude-sonnet-4-6", inboundRoutingLevel: "off" }],
        [],
      ],
      [],
    );

    await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });

    const skipSet = (db._sets as any[]).find(skippedAutonomy);
    expect(skipSet).toBeDefined();
    expect(skipSet.finishedAt).toBeInstanceOf(Date);
    expect(runAoaMock).not.toHaveBeenCalled();
    expect(mockResolveCrewRole).toHaveBeenCalledWith(db, "a2");
  });

  // (3) autonomy 2 (Drive), no role, resolver→null. Unresolved role at Drive →
  // companyCfg.autonomyLevel >= 2 → active → NOT skipped. The wakeup is claimed
  // and runAoaAgent IS invoked.
  it("(3) autonomy 2, no role, resolveCrewRole→null → NOT skipped_autonomy; runAoaAgent IS called", async () => {
    mockResolveCrewRole.mockResolvedValue(null);
    const db = makeConcurrencyDb(
      [
        [], // slot 0 — Phase-1 orphan
        [], // slot 1 — Phase-2 pending
        // slot 2 — Phase-3 wakeup: no role, autonomy will be 2 (Drive)
        [{ id: "w-drive", agentId: "a3", companyId: "co-3", source: "thread_mention", payload: {} }],
        // slot 3 — resolveCompanyConfig: autonomyLevel 2 (Drive)
        [{ crewAutonomyLevel: 2, crewPaused: false, model: "claude-sonnet-4-6", inboundRoutingLevel: "off" }],
        // slot 4 — D3 SPEND-brake window count (proceeds past the gate now)
        [],
        // slot 5 — A5/T1.9 run-COUNT brake window count (proceeds; mocked → false)
        [],
        // slot 6 — agent-row select for per-role model resolution
        [{ runtimeConfig: {}, adapterConfig: {} }],
        // slot 7 — Phase-4 reclaim-select (after Promise.all; no threadId → no
        // effectiveAutonomy lookup slot).
        [],
      ],
      [
        // update[0] = atomic claim queued→processing RETURNING the claimed row
        [{ id: "w-drive" }],
        // update[1] = final status update (does not use .returning())
        [],
      ],
    );

    await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });

    // NOT gated out.
    expect((db._sets as any[]).some(skippedAutonomy)).toBe(false);
    // The wakeup proceeded to dispatch.
    expect(runAoaMock).toHaveBeenCalledWith(
      db,
      "a3",
      expect.objectContaining({ companyId: "co-3", source: "thread_mention", wakeupId: "w-drive" }),
    );
    expect(mockResolveCrewRole).toHaveBeenCalledWith(db, "a3");
  });
});
