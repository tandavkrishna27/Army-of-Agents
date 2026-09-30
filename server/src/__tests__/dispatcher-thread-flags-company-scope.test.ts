// Cross-tenant confidentiality guard — Layer 2 (defence-in-depth).
//
// The dispatcher reads a thread's crew-control flags (crewPaused,
// useControllerPath, autonomyLevel) BY ID from the wakeup payload. That
// threadId can be caller-supplied (agent.dispatch), so the read is now scoped
// to the wakeup's OWN company:
//   WHERE discussions.id = threadId AND discussions.companyId = w.companyId
// A foreign thread id therefore resolves to NO row, and the code falls back to
// safe defaults (not paused, not controller-path, effectiveAutonomy = company)
// instead of steering company-A dispatch on company-B's flags.
//
// This suite proves:
//   (1) the discussions flag-read WHERE clause carries the companyId conjunct;
//   (2) a null threadRow (foreign id → no row) falls back safely and does NOT
//       spuriously pause / controller-skip the dispatch.
//
// Harness mirrors dispatcher-autonomy-effective.test.ts (positional select
// queue), extended to capture each select's projection + WHERE argument so the
// discussions flag-read can be identified and inspected.
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
  desc: vi.fn((c: unknown) => ({ desc: c })),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...vals: unknown[]) => ({ sql: strings.join("?"), vals }),
    {},
  ),
}));
vi.mock("@armyofagents/db", () => {
  const t = (n: string) =>
    new Proxy({} as Record<string, unknown>, {
      get: (_x, p) => (typeof p === "string" ? `${n}.${p}` : undefined),
    });
  return {
    discussionEntries: t("discussion_entries"),
    discussions: t("discussions"),
    internalAgentRuns: t("internal_agent_runs"),
    agentWakeupRequests: t("agent_wakeup_requests"),
    agents: t("agents"),
    internalAgentConfig: t("internal_agent_config"),
    issues: t("issues"),
    workQuestions: t("work_questions"),
  };
});
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
vi.mock("../services/internal-agent/aoa-agents/resolve-crew-role.js", () => ({
  resolveCrewRole: mockResolveCrewRole,
}));
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
  publishIssueStatusChanged: vi.fn(),
}));
vi.mock("../middleware/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { runAoaDispatch } from "../services/internal-agent/aoa-agents/dispatcher.js";

interface CapturedSelect {
  projection: unknown;
  where: unknown;
}

// Positional select queue + capture of each select's projection & WHERE arg.
function makeCapturingDb(selectQueue: unknown[][], returningQueue: unknown[][]) {
  let si = 0;
  let ui = 0;
  const captured: CapturedSelect[] = [];
  const sets: any[] = [];
  const db: any = {
    _sets: sets,
    _captured: captured,
    select: (projection?: unknown) => {
      const n = si++;
      const rec: CapturedSelect = { projection, where: undefined };
      captured.push(rec);
      const c: any = {};
      c.from = () => c;
      c.innerJoin = () => c;
      c.leftJoin = () => c;
      c.where = (w: unknown) => {
        rec.where = w;
        return c;
      };
      c.limit = () => c;
      c.orderBy = () => c;
      c.for = () => c;
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
            then: (resolve: (x: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
          }),
        };
      },
    }),
  };
  return db;
}

// A thread-bearing @mention wakeup that reaches the discussions flag-read.
function threadWakeup(overrides: Record<string, unknown> = {}) {
  return {
    id: "w-1",
    agentId: "a-1",
    companyId: "co-A",
    source: "thread_mention",
    runtimeConfig: { aoa: { role: "member" } },
    payload: { threadId: "th-foreign", role: "engineer" },
    ...overrides,
  };
}

// Locate the discussions flag-read: its projection has a `crewPaused` key.
function findFlagRead(captured: CapturedSelect[]): CapturedSelect | undefined {
  return captured.find(
    (c) =>
      c.projection != null &&
      typeof c.projection === "object" &&
      "crewPaused" in (c.projection as Record<string, unknown>) &&
      "useControllerPath" in (c.projection as Record<string, unknown>),
  );
}

describe("dispatcher thread-flags read — company-scoped (cross-tenant Layer 2)", () => {
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

  it("(1) scopes the thread flag-read WHERE to discussions.id AND discussions.companyId = wakeup.companyId", async () => {
    const db = makeCapturingDb(
      [
        [], // 0 orphan
        [], // 1 pending
        [threadWakeup()], // 2 wakeup (companyId co-A, threadId th-foreign)
        // 3 companyConfig: company Manual(0) → engineer (min 1) skips after the flag-read
        [{ crewAutonomyLevel: 0, crewPaused: false, model: "claude-sonnet-4-6", inboundRoutingLevel: "off" }],
        // 4 discussions flag-read → present (same company for this assertion)
        [{ crewPaused: false, useControllerPath: false, autonomyLevel: 0 }],
        // 5 Phase-4 reclaim (autonomy gate early-returns before brakes)
        [],
      ],
      [],
    );

    await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });

    const flagRead = findFlagRead(db._captured as CapturedSelect[]);
    expect(flagRead).toBeDefined();
    // WHERE is and(eq(discussions.id, threadId), eq(discussions.companyId, w.companyId)).
    const where = flagRead!.where as { and?: unknown[] };
    expect(where).toHaveProperty("and");
    const conjuncts = (where.and ?? []) as Array<{ eq: [unknown, unknown] }>;
    // id conjunct
    expect(conjuncts).toContainEqual({ eq: ["discussions.id", "th-foreign"] });
    // companyId conjunct pinned to the WAKEUP's company (not caller-influenceable)
    expect(conjuncts).toContainEqual({ eq: ["discussions.companyId", "co-A"] });
  });

  it("(2) a foreign threadId → no row → falls back to company dial safely (no false pause/controller skip; dispatches)", async () => {
    const db = makeCapturingDb(
      [
        [], // 0 orphan
        [], // 1 pending
        [threadWakeup({ id: "w-fb", agentId: "a-fb", companyId: "co-fb" })], // 2 wakeup
        // 3 companyConfig: company Drive(2) → engineer active on the company fallback
        [{ crewAutonomyLevel: 2, crewPaused: false, model: "claude-sonnet-4-6", inboundRoutingLevel: "off" }],
        // 4 discussions flag-read → EMPTY (foreign id excluded by the companyId conjunct)
        [],
        // 5 D3 spend-brake count
        [],
        // 6 run-count brake count
        [],
        // 7 agent-row model select
        [{ runtimeConfig: { aoa: { role: "member" } }, adapterConfig: {} }],
        // 8 Phase-4 reclaim
        [],
      ],
      [
        [{ id: "w-fb" }], // atomic claim RETURNING
        [], // final status update
      ],
    );

    await runAoaDispatch(db, { limiterMax: 2, staleMs: 600_000 });

    const sets = db._sets as any[];
    // Null threadRow → not paused, not controller-path: no spurious skip.
    expect(sets.some((s) => s.status === "skipped_paused")).toBe(false);
    expect(sets.some((s) => s.status === "skipped_controller_path")).toBe(false);
    // Falls back to the company dial (Drive) → dispatches, no crash.
    expect(runAoaMock).toHaveBeenCalledWith(
      db,
      "a-fb",
      expect.objectContaining({ companyId: "co-fb", wakeupId: "w-fb" }),
    );
  });
});
