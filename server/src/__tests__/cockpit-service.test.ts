import { beforeEach, describe, expect, it, vi } from "vitest";

const mockResolveCockpitScope = vi.hoisted(() => vi.fn());
const mockCockpitWorkSummary = vi.hoisted(() => vi.fn());
const mockThreadServiceList = vi.hoisted(() => vi.fn());
const mockLiveRunsForCompany = vi.hoisted(() => vi.fn());
const mockMemoryServiceListPending = vi.hoisted(() => vi.fn());
const mockUserNotesList = vi.hoisted(() => vi.fn());
const mockHubItemsQuery = vi.hoisted(() => vi.fn());

vi.mock("../services/cockpit-scope.js", () => ({
  resolveCockpitScope: mockResolveCockpitScope,
}));

vi.mock("../services/cockpit-work.js", () => ({
  cockpitWorkService: () => ({ summary: mockCockpitWorkSummary }),
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

function buildSelectStub(rows: unknown[] = []) {
  const stub: Record<string, unknown> = {};
  stub.from = () => stub;
  stub.where = () => stub;
  stub.innerJoin = () => stub;
  stub.leftJoin = () => stub;
  stub.select = () => stub;
  stub.orderBy = () => stub;
  stub.limit = () => Promise.resolve(rows);
  (stub as any).then = (resolve: (value: unknown) => void, reject: (error: unknown) => void) =>
    Promise.resolve(rows).then(resolve, reject);
  return stub;
}

const mockDb = {
  select: vi.fn(() => buildSelectStub()),
} as unknown as import("@armyofagents/db").Db;

const { cockpitService } = await import("../services/cockpit.js");

const COMPANY = "00000000-0000-4000-8000-000000000001";
const FOUNDER_ACTOR = { actorId: "u-founder", source: "session" as const };
const MEMBER_ACTOR = { actorId: "u-member", source: "session" as const };

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

const workItem = {
  id: "task-1",
  identifier: "T-1",
  title: "Review Commander",
  status: "in_progress",
  priority: "high",
  assigneeUserId: "u-founder",
  assigneeAgentId: null,
  responsibleUserId: "u-founder",
  reviewerUserId: null,
  dueDate: null,
  responsibility: {
    reason: "assigned_to_you" as const,
    entityType: "user" as const,
    entityId: "u-founder",
    label: "Founder",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockLiveRunsForCompany.mockResolvedValue([]);
  mockCockpitWorkSummary.mockResolvedValue({
    activeWork: { mine: { items: [], total: 0 }, managed: { items: [], total: 0 } },
    awaitingReview: { items: [], total: 0 },
  });
  mockThreadServiceList.mockResolvedValue([]);
  mockMemoryServiceListPending.mockResolvedValue({
    items: [], versions: [], archives: [], totalCount: 0,
  });
  mockUserNotesList.mockResolvedValue([]);
  mockHubItemsQuery.mockResolvedValue({ items: [], nextCursor: null });
  (mockDb as unknown as { select: ReturnType<typeof vi.fn> }).select = vi.fn(() => buildSelectStub());
});

describe("cockpitService.get accountable work", () => {
  it("resolves the board scope and loads work for the scoped user", async () => {
    mockResolveCockpitScope.mockResolvedValue(founderScope);

    await cockpitService(mockDb).get(COMPANY, FOUNDER_ACTOR);

    expect(mockResolveCockpitScope).toHaveBeenCalledWith(mockDb, COMPANY, FOUNDER_ACTOR);
    expect(mockCockpitWorkSummary).toHaveBeenCalledWith(COMPANY, founderScope.userId);
  });

  it("publishes v2 work groups and compatibility aliases from one result", async () => {
    mockResolveCockpitScope.mockResolvedValue(founderScope);
    mockCockpitWorkSummary.mockResolvedValue({
      activeWork: { mine: { items: [workItem], total: 1 }, managed: { items: [], total: 0 } },
      awaitingReview: { items: [{ ...workItem, status: "in_review" }], total: 1 },
    });

    const result = await cockpitService(mockDb).get(COMPANY, FOUNDER_ACTOR);

    expect(result.activeWork.mine.items).toEqual([workItem]);
    expect(result.awaitingReview.total).toBe(1);
    expect(result.myTasks).toBe(result.activeWork.mine.items);
    expect(result.review).toBe(result.awaitingReview.items);
    expect(result.meta).toMatchObject({
      partial: false,
      slices: {
        work: { status: "ok" },
        inbox: { status: "ok" },
        discussions: { status: "ok" },
      },
    });
  });

  it("uses the same hierarchy-aware service for a team member", async () => {
    mockResolveCockpitScope.mockResolvedValue(memberScope);

    await cockpitService(mockDb).get(COMPANY, MEMBER_ACTOR);

    expect(mockCockpitWorkSummary).toHaveBeenCalledWith(COMPANY, memberScope.userId);
  });
});

describe("cockpitService.get surrounding slices", () => {
  beforeEach(() => mockResolveCockpitScope.mockResolvedValue(founderScope));

  it("uses canonical thread visibility", async () => {
    mockThreadServiceList.mockResolvedValue([{
      id: "disc-1",
      title: "Thread 1",
      pendingItemCount: 3,
      companyId: COMPANY,
    }]);

    const result = await cockpitService(mockDb).get(COMPANY, FOUNDER_ACTOR);

    expect(mockThreadServiceList).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({ userId: founderScope.userId, role: "founder" }),
    );
    expect(result.discussions[0]).toMatchObject({ id: "disc-1", reason: "pending_items" });
  });

  it("maps note DTO timestamps without treating them as Date objects", async () => {
    mockUserNotesList.mockResolvedValue([{
      id: "note-1",
      companyId: COMPANY,
      userId: founderScope.userId,
      title: "Today",
      body: "Review Commander",
      color: "yellow",
      createdAt: "2026-07-10T09:00:00.000Z",
      updatedAt: "2026-07-10T10:00:00.000Z",
    }]);

    const result = await cockpitService(mockDb).get(COMPANY, FOUNDER_ACTOR);

    expect(result.stickyNotes).toEqual([
      expect.objectContaining({ id: "note-1", updatedAt: "2026-07-10T10:00:00.000Z" }),
    ]);
  });

  it("returns the complete additive Cockpit shape", async () => {
    const result = await cockpitService(mockDb).get(COMPANY, FOUNDER_ACTOR);

    expect(result).toMatchObject({
      activeWork: { mine: { items: [], total: 0 }, managed: { items: [], total: 0 } },
      awaitingReview: { items: [], total: 0 },
      running: [],
      review: [],
      myTasks: [],
      today: { reminders: [], dueTasks: [] },
      approvals: [],
    });
  });

  it("keeps successful slices when one independent source fails", async () => {
    mockUserNotesList.mockRejectedValueOnce(new Error("notes unavailable"));
    mockHubItemsQuery.mockResolvedValueOnce({
      items: [{
        id: "inbox-1",
        lane: "waiting_on_you",
        priority: "high",
        title: "Approve launch",
        summary: null,
        sourceType: "approval",
        sourceId: "approval-1",
        relatedEntityType: "approval",
        relatedEntityId: "approval-1",
        readAt: null,
        createdAt: new Date("2026-07-10T10:00:00.000Z"),
      }],
      nextCursor: null,
    });

    const result = await cockpitService(mockDb).get(COMPANY, FOUNDER_ACTOR);

    expect(result.stickyNotes).toEqual([]);
    expect(result.inbox).toHaveLength(1);
    expect(result.meta).toMatchObject({
      partial: true,
      slices: {
        stickyNotes: { status: "error", errorCode: "unavailable" },
        inbox: { status: "ok" },
      },
    });
  });
});
