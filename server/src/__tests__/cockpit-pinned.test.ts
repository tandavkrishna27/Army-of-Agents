/**
 * cockpit-pinned unit tests — Phase 3d.
 *
 * Tests for the cockpitPinned() function (exercised via cockpitService.get).
 *
 * DB select call order inside cockpitService.get with a team_member scope
 * (non-founder → cockpitApprovals skips most sub-queries but NOW runs the runtime
 * tool-trust select (owner-scoped); entryRows skipped because threadService mock
 * returns []; budgetPulse returns null — no select; teammates member → [] immediately,
 * no select):
 *   call 0: internalAgentReminders (reminders)
 *   call 1: issues (dueTasks)
 *   call 2: internalAgentRuntimeApprovals (runtime tool-trust — NEW, always runs for non-founder)
 *   call 3: userEntityPins (pins list)
 *   call 4: cockpitGoalsAtRisk (goals) — fires in same sync kickoff as pins
 *   call 5: cockpitDoneToday (issues) — fires in same sync kickoff as pins
 *   call 6: cockpitProactiveFindings (notifications) — fires in same sync kickoff
 *   call 7+: per-entity-type id-set lookups (only if pins non-empty, after pins resolves)
 *            issues batch (if taskIds.length > 0)
 *            artifacts batch (if artifactIds.length > 0)
 *            goals batch (if goalIds.length > 0)
 *
 * NOTE: goalsAtRisk (call 4), doneToday (call 5), and proactiveFindings (call 6) fire
 * BEFORE entity batches (7+) because they start in the outer Promise.all sync kickoff,
 * whereas entity batches are kicked off inside the cockpitPinned continuation (after
 * pins await resolves). All tests here use member scope to keep sequences simple
 * (no approvals sub-queries beyond the runtime select).
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

function buildSelectStub(rows: unknown[] = []) {
  const stub: Record<string, unknown> = {};
  stub.from = () => stub;
  // where() may be terminal (for entity-batch selects) OR followed by orderBy().
  // Return the stub so orderBy() can chain; the stub is then awaited.
  stub.where = () => stub;
  stub.innerJoin = () => stub;
  stub.select = () => stub;
  // orderBy() now chains — returns stub so .limit() can follow (for opt-in resolvers).
  stub.orderBy = () => stub;
  // limit() is terminal — resolves to rows.
  stub.limit = () => Promise.resolve(rows);
  // Make the stub itself awaitable (for where()-terminal and orderBy()-terminal paths).
  (stub as any).then = (resolve: (v: unknown) => void, _reject: (e: unknown) => void) =>
    Promise.resolve(rows).then(resolve, _reject);
  return stub;
}

// A sequence db that returns different rows per select call.
function buildSequenceDb(sequence: unknown[][]) {
  let callIdx = 0;
  return {
    select: vi.fn(() => {
      const rows = sequence[callIdx] ?? [];
      callIdx++;
      return buildSelectStub(rows);
    }),
  } as unknown as import("@armyofagents/db").Db;
}

// ── Import service under test ─────────────────────────────────────────────────

const { cockpitService } = await import("../services/cockpit.js");

// ── Fixtures ──────────────────────────────────────────────────────────────────

const COMPANY = "00000000-0000-4000-8000-000000000001";
const MEMBER_ACTOR = { actorId: "u-member", source: "session" as const };

const memberScope = {
  userId: "u-member",
  role: "team_member" as const,
  isFounder: false,
  leadDepartmentIds: [],
};

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockLiveRunsForCompany.mockResolvedValue([]);
  mockIssueServiceList.mockResolvedValue([]);
  mockThreadServiceList.mockResolvedValue([]);
  mockReviewFilterFor.mockReturnValue({ assigneeUserId: "u-member" });
  mockMemoryServiceListPending.mockResolvedValue({
    items: [],
    versions: [],
    archives: [],
    totalCount: 0,
  });
  mockResolveCockpitScope.mockResolvedValue(memberScope);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("cockpitPinned — empty pins", () => {
  it("returns pinned:[] when the user has no pins", async () => {
    // call 0: reminders, call 1: dueTasks, call 2: runtime=[], call 3: pins=[], call 4: goalsAtRisk
    // call 5: doneToday, call 6: proactiveFindings (pins=[] → cockpitPinned exits early, no entity batches)
    const db = buildSequenceDb([[], [], [], [], [], [], []]);
    const result = await cockpitService(db).get(COMPANY, MEMBER_ACTOR);
    expect(result).toHaveProperty("pinned");
    expect(result.pinned).toEqual([]);
  });
  mockUserNotesList.mockResolvedValue([]);
  mockHubItemsQuery.mockResolvedValue({ items: [], nextCursor: null });
});

describe("cockpitPinned — task pin", () => {
  it("resolves a task pin with identifier + status", async () => {
    const PIN_TASK_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const pinRow = {
      entityType: "task",
      entityId: PIN_TASK_ID,
      pinnedAt: new Date("2026-06-15T10:00:00Z"),
    };
    const taskRow = {
      id: PIN_TASK_ID,
      identifier: "ACME-7",
      title: "Build the auth flow",
      status: "in_progress",
    };

    // call 0: reminders [], call 1: dueTasks [], call 2: runtime []
    // call 3: pins [pinRow], call 4: goalsAtRisk [], call 5: doneToday [], call 6: proactiveFindings []
    // call 7: issues batch [taskRow]  (artifactIds and goalIds empty)
    const db = buildSequenceDb([[], [], [], [pinRow], [], [], [], [taskRow]]);
    const result = await cockpitService(db).get(COMPANY, MEMBER_ACTOR);

    expect(result.pinned).toHaveLength(1);
    expect(result.pinned[0]).toMatchObject({
      entityType: "task",
      entityId: PIN_TASK_ID,
      title: "Build the auth flow",
      status: "in_progress",
      identifier: "ACME-7",
    });
  });
});

describe("cockpitPinned — artifact pin", () => {
  it("resolves an artifact pin without identifier field", async () => {
    const PIN_ART_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const pinRow = {
      entityType: "artifact",
      entityId: PIN_ART_ID,
      pinnedAt: new Date("2026-06-15T09:00:00Z"),
    };
    const artRow = {
      id: PIN_ART_ID,
      title: "Design System v2",
      status: "active",
    };

    // call 0: reminders [], call 1: dueTasks [], call 2: runtime []
    // call 3: pins [pinRow], call 4: goalsAtRisk [], call 5: doneToday [], call 6: proactiveFindings []
    // taskIds empty → no issues batch
    // call 7: artifacts batch [artRow]  (goalIds empty)
    const db = buildSequenceDb([[], [], [], [pinRow], [], [], [], [artRow]]);
    const result = await cockpitService(db).get(COMPANY, MEMBER_ACTOR);

    expect(result.pinned).toHaveLength(1);
    expect(result.pinned[0]).toMatchObject({
      entityType: "artifact",
      entityId: PIN_ART_ID,
      title: "Design System v2",
      status: "active",
    });
    expect(result.pinned[0]).not.toHaveProperty("identifier");
  });
});

describe("cockpitPinned — goal pin", () => {
  it("resolves a goal pin", async () => {
    const PIN_GOAL_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const pinRow = {
      entityType: "goal",
      entityId: PIN_GOAL_ID,
      pinnedAt: new Date("2026-06-15T08:00:00Z"),
    };
    const goalRow = {
      id: PIN_GOAL_ID,
      title: "Launch v1",
      status: "active",
    };

    // call 0: reminders [], call 1: dueTasks [], call 2: runtime []
    // call 3: pins [pinRow], call 4: goalsAtRisk [], call 5: doneToday [], call 6: proactiveFindings []
    // taskIds + artifactIds empty → no batches for those
    // call 7: goals batch [goalRow]
    const db = buildSequenceDb([[], [], [], [pinRow], [], [], [], [goalRow]]);
    const result = await cockpitService(db).get(COMPANY, MEMBER_ACTOR);

    expect(result.pinned).toHaveLength(1);
    expect(result.pinned[0]).toMatchObject({
      entityType: "goal",
      entityId: PIN_GOAL_ID,
      title: "Launch v1",
      status: "active",
    });
  });
});

describe("cockpitPinned — company filter drops out-of-company entities", () => {
  it("drops a pin whose entity is not in the company (not in lookup result)", async () => {
    const FOREIGN_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const pinRow = {
      entityType: "task",
      entityId: FOREIGN_ID,
      pinnedAt: new Date("2026-06-15T10:00:00Z"),
    };

    // call 0: reminders [], call 1: dueTasks [], call 2: runtime []
    // call 3: pins [pinRow], call 4: goalsAtRisk [], call 5: doneToday [], call 6: proactiveFindings []
    // call 7: issues batch returns [] (company filter excludes the row)
    const db = buildSequenceDb([[], [], [], [pinRow], [], [], [], []]);
    const result = await cockpitService(db).get(COMPANY, MEMBER_ACTOR);

    expect(result.pinned).toEqual([]);
  });
});

describe("cockpitPinned — deleted entity is dropped", () => {
  it("drops a pin for an entity that no longer exists", async () => {
    const DELETED_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const pinRow = {
      entityType: "goal",
      entityId: DELETED_ID,
      pinnedAt: new Date("2026-06-15T07:00:00Z"),
    };

    // call 0: reminders [], call 1: dueTasks [], call 2: runtime []
    // call 3: pins [pinRow], call 4: goalsAtRisk [], call 5: doneToday [], call 6: proactiveFindings []
    // call 7: goals batch returns [] (entity deleted)
    const db = buildSequenceDb([[], [], [], [pinRow], [], [], [], []]);
    const result = await cockpitService(db).get(COMPANY, MEMBER_ACTOR);

    expect(result.pinned).toEqual([]);
  });
});

describe("cockpitPinned — polymorphic key prevents cross-type mis-resolution", () => {
  it("does not mis-resolve an artifact and a task that share the same uuid", async () => {
    // Simulate a (contrived) scenario where a task and artifact share the same id.
    const SHARED_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    const taskPin = {
      entityType: "task",
      entityId: SHARED_ID,
      pinnedAt: new Date("2026-06-15T12:00:00Z"),
    };
    const artPin = {
      entityType: "artifact",
      entityId: SHARED_ID,
      pinnedAt: new Date("2026-06-15T11:00:00Z"),
    };
    const taskRow = { id: SHARED_ID, identifier: "X-1", title: "Task title", status: "todo" };
    const artRow = { id: SHARED_ID, title: "Artifact title", status: "draft" };

    // call 0: reminders [], call 1: dueTasks [], call 2: runtime []
    // call 3: pins [taskPin, artPin], call 4: goalsAtRisk [], call 5: doneToday [], call 6: proactiveFindings []
    // call 7: issues batch [taskRow] (taskIds = [SHARED_ID])
    // call 8: artifacts batch [artRow] (artifactIds = [SHARED_ID])
    // (goalIds empty)
    const db = buildSequenceDb([[], [], [], [taskPin, artPin], [], [], [], [taskRow], [artRow]]);
    const result = await cockpitService(db).get(COMPANY, MEMBER_ACTOR);

    expect(result.pinned).toHaveLength(2);
    const task = result.pinned.find((p) => p.entityType === "task");
    const art = result.pinned.find((p) => p.entityType === "artifact");
    expect(task?.title).toBe("Task title");
    expect(art?.title).toBe("Artifact title");
  });
});

describe("cockpitPinned — order preserved (pinnedAt desc)", () => {
  it("returns pins in pinnedAt desc order matching the pin list", async () => {
    const ID_A = "11111111-1111-1111-1111-111111111111";
    const ID_B = "22222222-2222-2222-2222-222222222222";
    // pinnedAt desc: A (newer) then B (older)
    const pins = [
      { entityType: "goal", entityId: ID_A, pinnedAt: new Date("2026-06-15T10:00:00Z") },
      { entityType: "goal", entityId: ID_B, pinnedAt: new Date("2026-06-15T09:00:00Z") },
    ];
    const goalRows = [
      { id: ID_A, title: "Goal A", status: "active" },
      { id: ID_B, title: "Goal B", status: "planned" },
    ];

    // call 0: reminders [], call 1: dueTasks [], call 2: runtime []
    // call 3: pins [pins], call 4: goalsAtRisk [], call 5: doneToday [], call 6: proactiveFindings []
    // call 7: goals batch [goalRows]
    const db = buildSequenceDb([[], [], [], pins, [], [], [], goalRows]);
    const result = await cockpitService(db).get(COMPANY, MEMBER_ACTOR);

    expect(result.pinned).toHaveLength(2);
    expect(result.pinned[0].entityId).toBe(ID_A);
    expect(result.pinned[1].entityId).toBe(ID_B);
  });
});

describe("cockpitPinned — mixed entity types", () => {
  it("resolves task + artifact + goal pins in one call", async () => {
    const TASK_ID = "11111111-1111-1111-1111-111111111111";
    const ART_ID = "22222222-2222-2222-2222-222222222222";
    const GOAL_ID = "33333333-3333-3333-3333-333333333333";

    const pins = [
      { entityType: "task", entityId: TASK_ID, pinnedAt: new Date("2026-06-15T12:00:00Z") },
      { entityType: "artifact", entityId: ART_ID, pinnedAt: new Date("2026-06-15T11:00:00Z") },
      { entityType: "goal", entityId: GOAL_ID, pinnedAt: new Date("2026-06-15T10:00:00Z") },
    ];

    // call 0: reminders, call 1: dueTasks, call 2: runtime []
    // call 3: pins, call 4: goalsAtRisk [], call 5: doneToday [], call 6: proactiveFindings []
    // call 7: issues batch (TASK_ID)
    // call 8: artifacts batch (ART_ID)
    // call 9: goals batch (GOAL_ID)
    const db = buildSequenceDb([
      [],
      [],
      [], // runtime
      pins,
      [], // goalsAtRisk
      [], // doneToday
      [], // proactiveFindings
      [{ id: TASK_ID, identifier: "T-1", title: "My task", status: "todo" }],
      [{ id: ART_ID, title: "My artifact", status: "draft" }],
      [{ id: GOAL_ID, title: "My goal", status: "planned" }],
    ]);

    const result = await cockpitService(db).get(COMPANY, MEMBER_ACTOR);

    expect(result.pinned).toHaveLength(3);
    expect(result.pinned[0].entityType).toBe("task");
    expect(result.pinned[1].entityType).toBe("artifact");
    expect(result.pinned[2].entityType).toBe("goal");
  });
});
