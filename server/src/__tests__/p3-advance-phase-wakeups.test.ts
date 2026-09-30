/**
 * P3.4 (revised) — advancePhase does NOT emit legacy phase-advance wakeups
 *
 * The old pipeline (discuss→scope wakes Planner; scope→assign wakes Dispatcher)
 * was retired in Task 2.7 (Dispatcher) and Task 2.6 (work=task redesign).
 * advancePhase() now:
 *   - updates the thread's phase column
 *   - at "assign" + L2: auto-approves the pending scope_proposal via crew-task-service
 *   - does NOT insert agentWakeupRequests rows with source="phase-advance"
 *
 * This file is a regression guard: it proves the retired pipeline is absent.
 * The new auto-approve behavior is covered comprehensively by
 * thread-advance-autoapprove.test.ts (T1–T6). See Decision #15 and the
 * work=task redesign notes in CLAUDE.md.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (must precede imports that transitively import drizzle) ────────────

const { eqMock, andMock } = vi.hoisted(() => ({
  eqMock: vi.fn((a: unknown, b: unknown) => ({ op: "eq", a, b })),
  andMock: vi.fn((...args: unknown[]) => ({ op: "and", args })),
}));

vi.mock("drizzle-orm", () => ({
  eq: eqMock,
  and: andMock,
  sql: vi.fn(),
  asc: vi.fn((c: unknown) => c),
  desc: vi.fn((c: unknown) => c),
  gt: vi.fn((a: unknown, b: unknown) => ({ op: "gt", a, b })),
  ne: vi.fn((a: unknown, b: unknown) => ({ op: "ne", a, b })),
  inArray: vi.fn((a: unknown, b: unknown) => ({ op: "inArray", a, b })),
  notInArray: vi.fn((a: unknown, b: unknown) => ({ op: "notInArray", a, b })),
  isNull: vi.fn((a: unknown) => ({ op: "isNull", a })),
  or: vi.fn((...args: unknown[]) => ({ op: "or", args })),
  count: vi.fn(() => ({ count: true })),
}));

vi.mock("@armyofagents/db", () => {
  const t = (n: string) =>
    new Proxy(
      {},
      { get: (_x, p) => (typeof p === "string" ? `${n}.${p}` : undefined) },
    );
  return {
    discussions: t("discussions"),
    discussionEntries: t("de"),
    agents: t("agents"),
    aoaAgentTriggers: t("triggers"),
    agentWakeupRequests: t("wakeup"),
    activityLog: t("al"),
    userRoles: t("ur"),
    authUsers: t("authUsers"),
    companyMemberships: t("cm"),
    notifications: t("notifications"),
    threadParticipants: t("tp"),
    threadLinks: t("tl"),
    discussionExtractedItems: t("dei"),
    scopeItemDependencies: t("sid"),
    taskDependencies: t("td"),
    issues: t("issues"),
    internalAgentConfig: t("iac"),
  };
});

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));
vi.mock("../services/goals.js", () => ({
  goalService: vi.fn(() => ({})),
}));
vi.mock("../errors.js", () => ({
  notFound: (m: string) => Object.assign(new Error(m), { status: 404 }),
  badRequest: (m: string) => Object.assign(new Error(m), { status: 400 }),
  forbidden: (m: string) => Object.assign(new Error(m), { status: 403 }),
}));

// crew-task-service is dynamically imported inside advancePhase at "assign" target.
// Mock it so the L2 auto-approve path doesn't blow up in unit tests.
vi.mock("../services/crew-task-service.js", () => ({
  crewTaskService: vi.fn(() => ({
    approveAndDispatch: vi.fn().mockResolvedValue({ approved: true, createdIssueIds: [] }),
    proposeWork: vi.fn(),
  })),
  resolveCreationGate: vi.fn(() => "await_human"),
}));

// ── Now import the function under test ────────────────────────────────────────
import { threadService } from "../services/threads.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const COMPANY_ID = "co-1";
const THREAD_ID = "t-1";
// Using role: "founder" so assertCanView short-circuits and skips extra selects
const ACTOR = { userId: "user-1", isHuman: true, role: "founder" as const };

/**
 * Build a mock DB for advancePhase. Sequences select/update/insert calls.
 * The insert mock throws if called, so any spurious wakeup insert is caught.
 */
function buildMockDb(selectResults: Array<unknown[]>) {
  let selectCallIdx = 0;

  // Insert should NOT be called. If it is, record it so we can assert length=0.
  const insertValues: unknown[] = [];
  const insertValuesMock = vi.fn().mockImplementation((vals: unknown) => {
    insertValues.push(vals);
    return Promise.resolve([{ id: "w-1" }]);
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

  return {
    select: selectMock,
    update: updateMock,
    insert: insertMock,
    _insertValues: insertValues,
  };
}

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

// ── Tests ─────────────────────────────────────────────────────────────────────
//
// Decision: the legacy phase-advance wakeup pipeline (Planner on scope,
// Dispatcher on assign) is retired. advancePhase() must NOT insert
// agentWakeupRequests rows with source="phase-advance" for any phase transition.
// The crew-task-service approveAndDispatch path (at "assign" + L2) is a
// separate, crew-task-service-owned path — not a wakeup emission.

describe("P3.4 (regression) — advancePhase does NOT emit legacy phase-advance wakeups", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("advancing discuss → scope does NOT insert any agentWakeupRequests row", async () => {
    const db = buildMockDb([
      [THREAD_ROW],  // fetch thread row
      // No further selects expected; the old pipeline would have queried
      // aoaAgentTriggers here, but that code was removed.
    ]);

    await threadService(db as never).advancePhase(
      COMPANY_ID,
      THREAD_ID,
      "scope",
      ACTOR,
    );

    // The retired pipeline used db.insert(agentWakeupRequests). It must not fire.
    expect(db.insert).not.toHaveBeenCalled();
    expect(db._insertValues).toHaveLength(0);
  });

  it("advancing scope → assign (L0, await_human) does NOT insert any phase-advance wakeup", async () => {
    const SCOPE_THREAD = { ...THREAD_ROW, phase: "scope", autonomyLevel: 0 };
    const db = buildMockDb([
      [SCOPE_THREAD],         // fetch thread row
      [{ autonomyLevel: 0 }], // company config fetch (thread L0 wins; gate → await_human)
    ]);

    await threadService(db as never).advancePhase(
      COMPANY_ID,
      THREAD_ID,
      "assign",
      ACTOR,
    );

    // db.insert may be called by crew-task-service.approveAndDispatch internally,
    // but the legacy wakeup insert (agentWakeupRequests with source="phase-advance")
    // must be absent. Since crewTaskService is fully mocked, insert not called at all.
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("advancing scope → assign (L1, await_human) does NOT insert any phase-advance wakeup", async () => {
    const SCOPE_THREAD = { ...THREAD_ROW, phase: "scope", autonomyLevel: 1 };
    const db = buildMockDb([
      [SCOPE_THREAD],         // fetch thread row
      [{ autonomyLevel: 0 }], // company config fetch (thread L1 wins; gate → await_human)
    ]);

    await threadService(db as never).advancePhase(
      COMPANY_ID,
      THREAD_ID,
      "assign",
      ACTOR,
    );

    expect(db.insert).not.toHaveBeenCalled();
  });

  it("phase result object contains the new phase (basic advance contract)", async () => {
    const db = buildMockDb([[THREAD_ROW]]);

    const result = await threadService(db as never).advancePhase(
      COMPANY_ID,
      THREAD_ID,
      "scope",
      ACTOR,
    );

    expect(result).toMatchObject({ id: THREAD_ID, phase: "scope" });
  });
});
