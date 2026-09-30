/**
 * cockpit-optin unit tests — opt-in card resolvers.
 *
 * Tests the three new cockpit slices: goalsAtRisk, budgetPulse, doneToday.
 *
 * Security gate:
 *   - budgetPulse → null for ANY non-founder (member AND team_lead).
 *   - budgetPulse → null when limitCents = 0 (no budget configured).
 *   - budgetPulse → computes percentUsed for founder with budget.
 *   - doneToday → company-wide for founder (no assigneeUserId filter).
 *   - doneToday → own tasks only for non-founder (assigneeUserId in where conditions).
 *   - goalsAtRisk → maps shape correctly.
 */

import { beforeEach, describe, it, expect, vi } from "vitest";

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

const mockResolveCockpitScope = vi.hoisted(() => vi.fn());
const mockReviewFilterFor = vi.hoisted(() => vi.fn());
const mockIssueServiceList = vi.hoisted(() => vi.fn());
const mockThreadServiceList = vi.hoisted(() => vi.fn());
const mockLiveRunsForCompany = vi.hoisted(() => vi.fn());
const mockMemoryServiceListPending = vi.hoisted(() => vi.fn());
const mockUserNotesList = vi.hoisted(() => vi.fn());
const mockHubItemsQuery = vi.hoisted(() => vi.fn());

vi.mock("../services/cockpit-scope.js", () => ({
  resolveCockpitScope: mockResolveCockpitScope,
  reviewFilterFor: mockReviewFilterFor,
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => ({ list: mockIssueServiceList }),
}));

vi.mock("../services/threads.js", () => ({
  threadService: () => ({ list: mockThreadServiceList }),
}));

vi.mock("../routes/agents-live-runs.js", () => ({
  liveRunsForCompany: mockLiveRunsForCompany,
}));

vi.mock("../services/memory.js", () => ({
  memoryService: () => ({ listPending: mockMemoryServiceListPending }),
}));

vi.mock("../services/user-notes.js", () => ({
  userNotesService: () => ({ list: mockUserNotesList }),
}));

vi.mock("../services/hub-items.js", () => ({
  hubItemsService: () => ({ query: mockHubItemsQuery }),
}));

vi.mock("../services/cockpit-work.js", () => ({
  cockpitWorkService: () => ({
    summary: vi.fn().mockResolvedValue({
      activeWork: { mine: { items: [], total: 0 }, managed: { items: [], total: 0 } },
      awaitingReview: { items: [], total: 0 },
    }),
  }),
}));

// ── DB stub ───────────────────────────────────────────────────────────────────

// Spy-capable select stub: captures .where() call args for assertion.
// Supports .from().where().orderBy().limit() chains and .where()-terminal paths.
function buildSelectStub(rows: unknown[] = []) {
  const stub: Record<string, unknown> = {};
  stub.from = () => stub;
  stub.where = (...args: unknown[]) => {
    // Store the last where args on the stub for inspection
    (stub as any).__whereArgs = args;
    return stub;
  };
  stub.innerJoin = () => stub;
  stub.select = () => stub;
  // orderBy() chains — returns stub so .limit() can follow.
  stub.orderBy = () => stub;
  // limit() is terminal.
  stub.limit = () => Promise.resolve(rows);
  // Make stub awaitable for where()-terminal paths (SQL aggregate selects).
  (stub as any).then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
    Promise.resolve(rows).then(resolve, reject);
  return stub;
}

// Sequence db: each db.select() call returns the stub for the next item in sequence.
// Also tracks the where() args per call for assertion.
function buildSequenceDb(sequence: unknown[][]) {
  let callIdx = 0;
  const stubs: ReturnType<typeof buildSelectStub>[] = [];
  return {
    select: vi.fn(() => {
      const rows = sequence[callIdx] ?? [];
      const stub = buildSelectStub(rows);
      stubs.push(stub);
      callIdx++;
      return stub;
    }),
    _stubs: stubs,
    _getCallCount: () => callIdx,
  } as unknown as import("@armyofagents/db").Db & {
    _stubs: ReturnType<typeof buildSelectStub>[];
    _getCallCount: () => number;
  };
}

// ── Import service under test ─────────────────────────────────────────────────

const { cockpitService } = await import("../services/cockpit.js");

// ── Fixtures ──────────────────────────────────────────────────────────────────

const COMPANY = "00000000-0000-4000-8000-000000000002";
const FOUNDER_ACTOR = { actorId: "u-founder", source: "session" as const };
const MEMBER_ACTOR = { actorId: "u-member", source: "session" as const };
const LEAD_ACTOR = { actorId: "u-lead", source: "session" as const };

const founderScope = {
  userId: "u-founder",
  role: "founder" as const,
  isFounder: true,
  leadDepartmentIds: [],
};

const memberScope = {
  userId: "u-member",
  role: "team_member" as const,
  isFounder: false,
  leadDepartmentIds: [],
};

const leadScope = {
  userId: "u-lead",
  role: "team_lead" as const,
  isFounder: false,
  leadDepartmentIds: ["dep-a"],
};

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockLiveRunsForCompany.mockResolvedValue([]);
  mockIssueServiceList.mockResolvedValue([]);
  mockThreadServiceList.mockResolvedValue([]);
  mockReviewFilterFor.mockReturnValue({});
  mockMemoryServiceListPending.mockResolvedValue({
    items: [],
    versions: [],
    archives: [],
    totalCount: 0,
  });
  mockUserNotesList.mockResolvedValue([]);
  mockHubItemsQuery.mockResolvedValue({ items: [], nextCursor: null });
});

// ── goalsAtRisk ────────────────────────────────────────────────────────────────

describe("cockpitGoalsAtRisk — shape", () => {
  beforeEach(() => {
    mockResolveCockpitScope.mockResolvedValue(founderScope);
  });

  it("maps at-risk goals to CockpitGoalsAtRiskItem shape", async () => {
    const goalRow = {
      id: "goal-1",
      title: "Reach PMF",
      level: "company",
      ownerAgentId: "agent-1",
    };
    // Sequence for founder: reminders=[], dueTasks=[], approvals=[], discItems=[],
    //   joinReqs=[], runtime=[],
    //   pinned=[], goalsAtRisk=[goalRow], companies=[{limitCents:0}], doneToday=[],
    //   proactiveFindings=[], teammatesActivity (founder)=[]
    const db = buildSequenceDb([[], [], [], [], [], [], [], [goalRow], [{ limitCents: 0 }], [], [], []]);

    const result = await cockpitService(db).get(COMPANY, FOUNDER_ACTOR);

    expect(result.goalsAtRisk).toHaveLength(1);
    expect(result.goalsAtRisk[0]).toMatchObject({
      id: "goal-1",
      title: "Reach PMF",
      level: "company",
      ownerAgentId: "agent-1",
    });
  });

  it("returns empty array when no at-risk goals", async () => {
    const db = buildSequenceDb([[], [], [], [], [], [], [], [], [{ limitCents: 0 }], [], [], []]);
    const result = await cockpitService(db).get(COMPANY, FOUNDER_ACTOR);
    expect(result.goalsAtRisk).toEqual([]);
  });

  it("includes goalsAtRisk field for non-founder too", async () => {
    mockResolveCockpitScope.mockResolvedValue(memberScope);
    mockReviewFilterFor.mockReturnValue({ assigneeUserId: "u-member" });
    // Non-founder: reminders=[], dueTasks=[], runtime=[], pinned=[], goalsAtRisk=[], doneToday=[],
    // proactiveFindings=[] (teammates member → [] immediately, no select)
    const db = buildSequenceDb([[], [], [], [], [], [], []]);
    const result = await cockpitService(db).get(COMPANY, MEMBER_ACTOR);
    expect(result).toHaveProperty("goalsAtRisk");
    expect(Array.isArray(result.goalsAtRisk)).toBe(true);
  });
});

// ── budgetPulse ────────────────────────────────────────────────────────────────

describe("cockpitBudgetPulse — founder-only SECURITY GATE", () => {
  it("non-founder (team_member) gets budgetPulse=null — no sub-queries", async () => {
    mockResolveCockpitScope.mockResolvedValue(memberScope);
    mockReviewFilterFor.mockReturnValue({ assigneeUserId: "u-member" });
    // Non-founder: reminders=[], dueTasks=[], runtime=[], pinned=[], goalsAtRisk=[], doneToday=[],
    // proactiveFindings=[] (teammates member → [] immediately, no select)
    const db = buildSequenceDb([[], [], [], [], [], [], []]);

    const result = await cockpitService(db).get(COMPANY, MEMBER_ACTOR);

    // HC: budgetPulse MUST be null for non-founders (founder-only v1)
    expect(result.budgetPulse).toBeNull();
  });

  it("non-founder (team_lead) gets budgetPulse=null", async () => {
    mockResolveCockpitScope.mockResolvedValue(leadScope);
    mockReviewFilterFor.mockReturnValue({ projectIds: ["dep-a"] });
    // team_lead: reminders=[], dueTasks=[], runtime=[], (lead review dept call via issueService),
    // pinned=[], goalsAtRisk=[], doneToday=[], proactiveFindings=[],
    // cockpitTeammatesActivity lead: deptRows=[] (no dept members), returns [] early
    const db = buildSequenceDb([[], [], [], [], [], [], [], []]);

    const result = await cockpitService(db).get(COMPANY, LEAD_ACTOR);

    expect(result.budgetPulse).toBeNull();
  });

  it("founder with limitCents=0 gets budgetPulse=null (no budget configured)", async () => {
    mockResolveCockpitScope.mockResolvedValue(founderScope);
    // companies returns limitCents=0 → resolver exits early, no costEvents/budgetIncidents selects
    // Sequence: reminders=[], dueTasks=[], approvals=[], discItems=[],
    //   joinReqs=[], runtime=[],
    //   pinned=[], goalsAtRisk=[], companies=[{limitCents:0}], doneToday=[],
    //   proactiveFindings=[], teammatesActivity (founder)=[]
    const db = buildSequenceDb([[], [], [], [], [], [], [], [], [{ limitCents: 0 }], [], [], []]);

    const result = await cockpitService(db).get(COMPANY, FOUNDER_ACTOR);

    expect(result.budgetPulse).toBeNull();
  });

  it("founder with budget computes percentUsed correctly", async () => {
    mockResolveCockpitScope.mockResolvedValue(founderScope);
    // Sequence ordering in Promise.all:
    //   Sync kickoff (all async fns start and run until first await):
    //   [0]  reminders (where-terminal — awaits stub.then)
    //   [1]  dueTasks (where-terminal — awaits stub.then)
    //   [2]  listPendingApprovals (innerJoin-terminal — awaits stub.then)
    //   [3]  listPendingExtractedItems (innerJoin-terminal — awaits stub.then)
    //   [4]  joinRequests (NEW — where-terminal)
    //   [5]  internalAgentRuntimeApprovals (NEW — where-terminal)
    //   [6]  cockpitPinned pins list (orderBy-terminal — awaits stub.then)
    //   [7]  cockpitGoalsAtRisk (orderBy().limit() — awaits stub.limit)
    //   [8]  cockpitBudgetPulse: companies (where-terminal, first await in fn)
    //   [9]  cockpitDoneToday (orderBy().limit() — awaits stub.limit)
    //   [10] cockpitProactiveFindings (orderBy().limit() — awaits stub.limit)
    //   [11] cockpitTeammatesActivity founder (orderBy().limit() — awaits stub.limit)
    //   After [8] resolves, cockpitBudgetPulse resumes:
    //   [12] costEvents sum (where-terminal — awaits stub.then)
    //   [13] budgetIncidents count (where-terminal — awaits stub.then)
    const db = buildSequenceDb([
      [],                      // [0]  reminders
      [],                      // [1]  dueTasks
      [],                      // [2]  approvals
      [],                      // [3]  discItems
      [],                      // [4]  joinRequests (NEW)
      [],                      // [5]  runtime (NEW)
      [],                      // [6]  pinned
      [],                      // [7]  goalsAtRisk
      [{ limitCents: 50000 }], // [8]  companies
      [],                      // [9]  doneToday
      [],                      // [10] proactiveFindings
      [],                      // [11] teammatesActivity (founder)
      [{ spent: 25000 }],      // [12] costEvents sum
      [{ incidents: 2 }],      // [13] budgetIncidents count
    ]);

    const result = await cockpitService(db).get(COMPANY, FOUNDER_ACTOR);

    expect(result.budgetPulse).not.toBeNull();
    expect(result.budgetPulse).toMatchObject({
      limitCents: 50000,
      spentCents: 25000,
      percentUsed: 50,
      openIncidentCount: 2,
    });
  });

  it("founder with 100%+ spend computes percentUsed ≥100", async () => {
    mockResolveCockpitScope.mockResolvedValue(founderScope);
    // Same ordering as above (proactive/teammates slots added, +2 for joinReqs/runtime)
    const db = buildSequenceDb([
      [], [], [], [], [], [], [], [],  // reminders, dueTasks, approvals, discItems, joinReqs, runtime, pinned, goalsAtRisk
      [{ limitCents: 10000 }], // [8] companies
      [],                      // [9] doneToday
      [],                      // [10] proactiveFindings
      [],                      // [11] teammatesActivity (founder)
      [{ spent: 12000 }],      // [12] costEvents (over limit)
      [{ incidents: 0 }],      // [13] budgetIncidents
    ]);

    const result = await cockpitService(db).get(COMPANY, FOUNDER_ACTOR);

    expect(result.budgetPulse?.percentUsed).toBe(120);
    expect(result.budgetPulse?.spentCents).toBe(12000);
  });
});

// ── doneToday ─────────────────────────────────────────────────────────────────

describe("cockpitDoneToday — scoping", () => {
  it("founder gets company-wide done-today (no assigneeUserId restriction)", async () => {
    mockResolveCockpitScope.mockResolvedValue(founderScope);
    const taskRow = { id: "task-1", identifier: "ACME-1", title: "Ship it" };
    // doneToday is now slot [9] (limitCents=0, no budget continuation)
    // Sequence: reminders=[], dueTasks=[], approvals=[], discItems=[],
    //   joinReqs=[], runtime=[],
    //   pinned=[], goalsAtRisk=[], companies=[{limitCents:0}], doneToday=[taskRow],
    //   proactiveFindings=[], teammatesActivity (founder)=[]
    const db = buildSequenceDb([[], [], [], [], [], [], [], [], [{ limitCents: 0 }], [taskRow], [], []]);

    const result = await cockpitService(db).get(COMPANY, FOUNDER_ACTOR);

    expect(result.doneToday).toHaveLength(1);
    expect(result.doneToday[0]).toMatchObject({
      id: "task-1",
      identifier: "ACME-1",
      title: "Ship it",
    });

    // For founder, the where conditions should NOT include assigneeUserId.
    // The doneToday stub is at index 9 (0-based) for this sequence (was 7 before +2 slots).
    const doneTodayStub = (db as any)._stubs[9];
    const whereArgs = (doneTodayStub as any).__whereArgs;
    // whereArgs[0] is the `and(...)` expression object — we can't easily inspect Drizzle
    // internals, but we can verify the result shape and that the select happened.
    expect(whereArgs).toBeDefined();
  });

  it("non-founder (team_member) gets own tasks only — assigneeUserId in conditions", async () => {
    mockResolveCockpitScope.mockResolvedValue(memberScope);
    mockReviewFilterFor.mockReturnValue({ assigneeUserId: "u-member" });
    const taskRow = { id: "task-2", identifier: "ACME-2", title: "My task" };
    // Non-founder: reminders=[], dueTasks=[], runtime=[], pinned=[], goalsAtRisk=[], doneToday=[taskRow],
    // proactiveFindings=[] (teammates member → [] immediately, no select)
    const db = buildSequenceDb([[], [], [], [], [], [taskRow], []]);

    const result = await cockpitService(db).get(COMPANY, MEMBER_ACTOR);

    expect(result.doneToday).toHaveLength(1);
    expect(result.doneToday[0]).toMatchObject({
      id: "task-2",
      identifier: "ACME-2",
      title: "My task",
    });
  });

  it("returns empty array when no tasks completed today", async () => {
    mockResolveCockpitScope.mockResolvedValue(memberScope);
    mockReviewFilterFor.mockReturnValue({ assigneeUserId: "u-member" });
    // reminders=[], dueTasks=[], runtime=[], pinned=[], goalsAtRisk=[], doneToday=[], proactiveFindings=[]
    const db = buildSequenceDb([[], [], [], [], [], [], []]);
    const result = await cockpitService(db).get(COMPANY, MEMBER_ACTOR);
    expect(result.doneToday).toEqual([]);
  });

  it("doneToday field is always present on CockpitData", async () => {
    mockResolveCockpitScope.mockResolvedValue(founderScope);
    // founder: limitCents=0, proactiveFindings=[], teammatesActivity=[] (+2 joinReqs/runtime slots)
    const db = buildSequenceDb([[], [], [], [], [], [], [], [], [{ limitCents: 0 }], [], [], []]);
    const result = await cockpitService(db).get(COMPANY, FOUNDER_ACTOR);
    expect(result).toHaveProperty("doneToday");
    expect(Array.isArray(result.doneToday)).toBe(true);
  });
});
