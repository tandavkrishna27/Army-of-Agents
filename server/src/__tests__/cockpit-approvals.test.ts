/**
 * cockpit-approvals unit tests — Phase 3c + approval families extension + A4 per-role scoping.
 *
 * Security gate:
 *   - founder → all source queries run; items mapped with correct source discriminator.
 *   - team_lead → memory/memory_version (dept-scoped, active_context ONLY; R5: domain is founder-only) + runtime (own). No other sources.
 *   - team_member → runtime (own) only. memory NOT called.
 *
 * Constraint verification (plan Hard Constraints):
 *   - HC1 (A4): approval/discussion_item/join_request/memory_archive → founder-only.
 *   - HC2: memory uses .items (object, not array); .versions/.archives for new sources.
 *   - HC3: discussion join uses discussionEntryId → discussion_entries → discussions.
 *   - HC4: runtime query filters by userId (owner-scoped; confirm route is per-user).
 *   - HC7: per-source approve dispatches correct API.
 *
 * DB select call order for FOUNDER (12 selects):
 *   [0]  reminders (internalAgentReminders)
 *   [1]  dueTasks (issues)
 *   [2]  listPendingApprovals (approvals table)
 *   [3]  listPendingExtractedItems (discussionExtractedItems + joins)
 *   [4]  joinRequests (NEW — approval families)
 *   [5]  internalAgentRuntimeApprovals (NEW — approval families)
 *   [6]  cockpitPinned pins list (userEntityPins → [] → exits early)
 *   [7]  cockpitGoalsAtRisk (goals)
 *   [8]  cockpitBudgetPulse: companies (limitCents=0 → returns null, no further selects)
 *   [9]  cockpitDoneToday (issues)
 *   [10] cockpitProactiveFindings (notifications)
 *   [11] cockpitTeammatesActivity (activityLog) — founder=company-wide, 1 select
 *
 * DB select call order for TEAM_MEMBER (7 selects — A4: runtime added at [2]):
 *   [0] reminders
 *   [1] dueTasks
 *   [2] internalAgentRuntimeApprovals (NEW — was no-op before A4)
 *   [3] cockpitPinned pins list
 *   [4] cockpitGoalsAtRisk
 *   (cockpitBudgetPulse short-circuits for non-founder, no select)
 *   [5] cockpitDoneToday
 *   [6] cockpitProactiveFindings (notifications)
 *   (cockpitTeammatesActivity: member → [] immediately, no select)
 *
 * DB select call order for TEAM_LEAD (8 selects — member + 1 teammates-dept):
 *   [0] reminders
 *   [1] dueTasks
 *   [2] internalAgentRuntimeApprovals (owner-scoped)
 *   [3] cockpitPinned pins list
 *   [4] cockpitGoalsAtRisk
 *   (cockpitBudgetPulse short-circuits for non-founder, no select)
 *   [5] cockpitDoneToday
 *   [6] cockpitProactiveFindings (notifications)
 *   [7] cockpitTeammatesActivity dept-scoped (activityLog) — 1 select for lead
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

// Sequence-based mock db. Select call order documented in the file-level comment.
// FOUNDER = 12 selects; TEAM_MEMBER = 7 selects (A4: runtime at [2]); TEAM_LEAD = 8 selects.

function buildSelectStub(rows: unknown[] = []) {
  const stub: Record<string, unknown> = {};
  stub.from = () => stub;
  // where() may chain to orderBy() (cockpitPinned, opt-in resolvers) or be terminal.
  stub.where = () => stub;
  stub.innerJoin = () => stub;
  stub.select = () => stub;
  // orderBy() now chains — returns the stub so .limit() can follow.
  stub.orderBy = () => stub;
  // limit() is terminal — resolves to rows.
  stub.limit = () => Promise.resolve(rows);
  // Make the stub itself awaitable for where()-terminal and orderBy()-terminal paths.
  (stub as any).then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
    Promise.resolve(rows).then(resolve, reject);
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

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockLiveRunsForCompany.mockResolvedValue([]);
  mockIssueServiceList.mockResolvedValue([]);
  mockThreadServiceList.mockResolvedValue([]);
  mockReviewFilterFor.mockReturnValue({});
  // Default memory returns empty list (object shape, not array — HC2)
  mockMemoryServiceListPending.mockResolvedValue({
    items: [],
    versions: [],
    archives: [],
    totalCount: 0,
  });
  mockUserNotesList.mockResolvedValue([]);
  mockHubItemsQuery.mockResolvedValue({ items: [], nextCursor: null });
});

// ── Tests: founder scope ──────────────────────────────────────────────────────

describe("cockpitApprovals — founder scope", () => {
  beforeEach(() => {
    mockResolveCockpitScope.mockResolvedValue(founderScope);
  });

  it("HC1: founder gets approvals array (not [])", async () => {
    // Provide one pending approval row from db.select.
    // DB select call order (Promise.all runs in parallel but JS serializes them):
    //   slot 0: reminders (internalAgentReminders)
    //   slot 1: dueTasks (issues)
    //   slot 2: listPendingApprovals (approvals table)
    //   slot 3: listPendingExtractedItems (discussionExtractedItems + joins)
    //   slot 4: joinRequests (NEW — empty for this test)
    //   slot 5: internalAgentRuntimeApprovals (NEW — empty for this test)
    //   (entryRows for discussions only fires if visibleIds.length > 0; threadService returns [] so skipped)
    const approvalRow = {
      id: "appr-1",
      type: "hire_agent",
      requestedByAgentId: null,
      status: "pending",
      payload: { name: "Scout" },
    };
    // Sequence: reminders=[], dueTasks=[], approvals=[approvalRow], discItems=[],
    //   joinReqs=[], runtime=[],
    //   pinned=[], goalsAtRisk=[], companies=[{limitCents:0}] (budget exits early), doneToday=[],
    //   proactiveFindings=[], teammatesActivity (founder=company-wide)=[]
    const db = buildSequenceDb([[], [], [approvalRow], [], [], [], [], [], [{ limitCents: 0 }], [], [], []]);
    mockMemoryServiceListPending.mockResolvedValue({
      items: [],
      versions: [],
      archives: [],
      totalCount: 0,
    });

    const result = await cockpitService(db).get(COMPANY, FOUNDER_ACTOR);

    expect(result).toHaveProperty("approvals");
    expect(Array.isArray(result.approvals)).toBe(true);
    // Approval row should be mapped with source="approval"
    expect(result.approvals).toHaveLength(1);
    expect(result.approvals[0]).toMatchObject({
      source: "approval",
      id: "appr-1",
      title: "Hire Scout",
    });
  });

  it("memory listPending is called with companyId and .items is used (HC2)", async () => {
    const memItem = {
      id: "mem-1",
      title: "Use TypeScript",
      layer: "domain",
      category: "coding",
      status: "pending",
    };
    mockMemoryServiceListPending.mockResolvedValue({
      items: [memItem],
      versions: [],
      archives: [],
      totalCount: 1,
    });

    // Sequence: reminders=[], dueTasks=[], approvals=[], discItems=[],
    //   joinReqs=[], runtime=[],
    //   pinned=[], goalsAtRisk=[], companies=[{limitCents:0}], doneToday=[],
    //   proactiveFindings=[], teammatesActivity (founder)=[]
    const db = buildSequenceDb([[], [], [], [], [], [], [], [], [{ limitCents: 0 }], [], [], []]);
    const result = await cockpitService(db).get(COMPANY, FOUNDER_ACTOR);

    expect(mockMemoryServiceListPending).toHaveBeenCalledWith(COMPANY);
    expect(result.approvals).toHaveLength(1);
    expect(result.approvals[0]).toMatchObject({
      source: "memory",
      id: "mem-1",
      title: "Use TypeScript",
    });
  });

  it("discussion items are mapped with source=discussion_item and discussionId (HC3)", async () => {
    const discItem = {
      id: "item-1",
      discussionId: "disc-1",
      title: "New task: set up CI",
      type: "task",
    };
    // Sequence: reminders=[], dueTasks=[], approvals=[], discItems=[discItem],
    //   joinReqs=[], runtime=[],
    //   pinned=[], goalsAtRisk=[], companies=[{limitCents:0}], doneToday=[],
    //   proactiveFindings=[], teammatesActivity (founder)=[]
    const db = buildSequenceDb([[], [], [], [discItem], [], [], [], [], [{ limitCents: 0 }], [], [], []]);

    const result = await cockpitService(db).get(COMPANY, FOUNDER_ACTOR);

    expect(result.approvals).toHaveLength(1);
    expect(result.approvals[0]).toMatchObject({
      source: "discussion_item",
      id: "item-1",
      discussionId: "disc-1",
      title: "New task: set up CI",
      subtitle: "task",
    });
  });

  it("all 3 original sources combined in order", async () => {
    const approvalRow = { id: "appr-1", type: "hire_agent", status: "pending", payload: {} };
    const memItem = { id: "mem-1", title: "Domain rule", layer: "domain", category: null, status: "pending" };
    const discItem = { id: "item-1", discussionId: "disc-1", title: "Insight", type: "insight" };

    mockMemoryServiceListPending.mockResolvedValue({
      items: [memItem],
      versions: [],
      archives: [],
      totalCount: 1,
    });

    // Sequence: reminders=[], dueTasks=[], approvals=[approvalRow], discItems=[discItem],
    //   joinReqs=[], runtime=[],
    //   pinned=[], goalsAtRisk=[], companies=[{limitCents:0}], doneToday=[],
    //   proactiveFindings=[], teammatesActivity (founder)=[]
    const db = buildSequenceDb([[], [], [approvalRow], [discItem], [], [], [], [], [{ limitCents: 0 }], [], [], []]);
    const result = await cockpitService(db).get(COMPANY, FOUNDER_ACTOR);

    expect(result.approvals).toHaveLength(3);
    const sources = result.approvals.map((a) => a.source);
    expect(sources).toContain("approval");
    expect(sources).toContain("memory");
    expect(sources).toContain("discussion_item");
  });

  // ── Approval Families: new 4 sources ─────────────────────────────────────────

  it("join_request: agent type maps title from agentName and subtitle 'Agent join'", async () => {
    const joinRow = {
      id: "jr-1",
      requestType: "agent",
      requestingUserId: null,
      agentName: "Scout",
    };
    // Sequence: reminders=[], dueTasks=[], approvals=[], discItems=[],
    //   joinReqs=[joinRow], runtime=[],
    //   pinned=[], goalsAtRisk=[], companies=[{limitCents:0}], doneToday=[],
    //   proactiveFindings=[], teammatesActivity=[]
    const db = buildSequenceDb([[], [], [], [], [joinRow], [], [], [], [{ limitCents: 0 }], [], [], []]);
    const result = await cockpitService(db).get(COMPANY, FOUNDER_ACTOR);

    const item = result.approvals.find((a) => a.source === "join_request");
    expect(item).toBeDefined();
    expect(item).toMatchObject({
      source: "join_request",
      id: "jr-1",
      title: "Scout",
      subtitle: "Agent join",
    });
  });

  it("join_request: human type maps title from requestingUserId and subtitle 'User join'", async () => {
    const joinRow = {
      id: "jr-2",
      requestType: "human",
      requestingUserId: "user-abc",
      agentName: null,
    };
    const db = buildSequenceDb([[], [], [], [], [joinRow], [], [], [], [{ limitCents: 0 }], [], [], []]);
    const result = await cockpitService(db).get(COMPANY, FOUNDER_ACTOR);

    const item = result.approvals.find((a) => a.source === "join_request");
    expect(item).toMatchObject({
      source: "join_request",
      id: "jr-2",
      title: "user-abc",
      subtitle: "User join",
    });
  });

  it("join_request: agent with no agentName falls back to 'Agent join request'", async () => {
    const joinRow = {
      id: "jr-3",
      requestType: "agent",
      requestingUserId: null,
      agentName: null,
    };
    const db = buildSequenceDb([[], [], [], [], [joinRow], [], [], [], [{ limitCents: 0 }], [], [], []]);
    const result = await cockpitService(db).get(COMPANY, FOUNDER_ACTOR);

    const item = result.approvals.find((a) => a.source === "join_request");
    expect(item?.title).toBe("Agent join request");
  });

  it("memory_version: maps id=itemId, relatedEntityId=version.id, title=itemTitle, subtitle=layer·category+(edit)", async () => {
    mockMemoryServiceListPending.mockResolvedValue({
      items: [],
      versions: [
        {
          itemId: "mem-item-1",
          itemTitle: "Use TypeScript everywhere",
          itemLayer: "domain",
          itemCategory: "coding",
          itemSource: "agent",
          currentContent: "old content",
          currentVersionId: "ver-0",
          version: {
            id: "ver-1",
            memoryItemId: "mem-item-1",
            versionNumber: 2,
            content: "new content",
            status: "pending",
            createdBy: "agent-x",
            createdAt: new Date("2026-01-01"),
          },
        },
      ],
      archives: [],
      totalCount: 1,
    });

    const db = buildSequenceDb([[], [], [], [], [], [], [], [], [{ limitCents: 0 }], [], [], []]);
    const result = await cockpitService(db).get(COMPANY, FOUNDER_ACTOR);

    const item = result.approvals.find((a) => a.source === "memory_version");
    expect(item).toBeDefined();
    expect(item).toMatchObject({
      source: "memory_version",
      id: "mem-item-1",
      relatedEntityId: "ver-1",
      title: "Use TypeScript everywhere",
      subtitle: "domain · coding (edit)",
    });
  });

  it("memory_version: subtitle handles null category gracefully", async () => {
    mockMemoryServiceListPending.mockResolvedValue({
      items: [],
      versions: [
        {
          itemId: "mem-item-2",
          itemTitle: "Some rule",
          itemLayer: "domain",
          itemCategory: null,
          itemSource: "agent",
          currentContent: "c",
          currentVersionId: "v0",
          version: { id: "ver-2", memoryItemId: "mem-item-2", versionNumber: 1, content: "c2", status: "pending", createdBy: "a", createdAt: new Date() },
        },
      ],
      archives: [],
      totalCount: 1,
    });

    const db = buildSequenceDb([[], [], [], [], [], [], [], [], [{ limitCents: 0 }], [], [], []]);
    const result = await cockpitService(db).get(COMPANY, FOUNDER_ACTOR);

    const item = result.approvals.find((a) => a.source === "memory_version");
    expect(item?.subtitle).toBe("domain (edit)");
  });

  it("memory_archive: maps id=item.id, relatedEntityId=suggestion.id, subtitle='Suggested for archival'", async () => {
    mockMemoryServiceListPending.mockResolvedValue({
      items: [],
      versions: [],
      archives: [
        {
          item: {
            id: "mem-arch-1",
            companyId: COMPANY,
            title: "Stale rule",
            content: "old",
            category: "coding",
            source: "agent",
            status: "approved",
            tags: [],
            departmentId: null,
            projectId: null,
            createdBy: "founder",
            layer: "domain",
            priority: "medium",
            visibility: "company",
            expiresAt: null,
            goalId: null,
            taskId: null,
            sourceArtifactId: null,
            sourceContext: null,
            accessedAt: null,
            currentVersionId: null,
            createdAt: new Date("2026-01-01"),
            updatedAt: new Date("2026-01-01"),
          },
          suggestion: {
            id: "sug-1",
            companyId: COMPANY,
            category: "agent_proposal",
            actionType: "archive_memory",
            actionPayload: {},
            title: "Archive stale rule",
            evidence: null,
            status: "pending",
            expiresAt: null,
            relatedMemoryItemId: "mem-arch-1",
            createdAt: new Date("2026-01-01"),
            updatedAt: new Date("2026-01-01"),
          },
        },
      ],
      totalCount: 1,
    });

    const db = buildSequenceDb([[], [], [], [], [], [], [], [], [{ limitCents: 0 }], [], [], []]);
    const result = await cockpitService(db).get(COMPANY, FOUNDER_ACTOR);

    const item = result.approvals.find((a) => a.source === "memory_archive");
    expect(item).toBeDefined();
    expect(item).toMatchObject({
      source: "memory_archive",
      id: "mem-arch-1",
      relatedEntityId: "sug-1",
      title: "Stale rule",
      subtitle: "Suggested for archival",
    });
  });

  it("runtime_tool_trust: maps with decisionType='ternary'", async () => {
    const runtimeRow = {
      id: "rt-1",
      toolName: "bash",
      params: { cmd: "ls" },
      expiresAt: new Date(Date.now() + 60_000),
    };
    // Sequence: joinReqs=[] at slot [4], runtime=[runtimeRow] at slot [5]
    const db = buildSequenceDb([[], [], [], [], [], [runtimeRow], [], [], [{ limitCents: 0 }], [], [], []]);
    const result = await cockpitService(db).get(COMPANY, FOUNDER_ACTOR);

    const item = result.approvals.find((a) => a.source === "runtime_tool_trust");
    expect(item).toBeDefined();
    expect(item).toMatchObject({
      source: "runtime_tool_trust",
      id: "rt-1",
      title: "bash",
      subtitle: "Tool execution approval",
      decisionType: "ternary",
    });
  });

  it("runtime_tool_trust: expired rows excluded (gt filter verified by mock returning none)", async () => {
    // The db.select for runtime returns [] (simulating gt(expiresAt, now) filtering out expired row).
    // Slot [5] = runtime → empty.
    const db = buildSequenceDb([[], [], [], [], [], [], [], [], [{ limitCents: 0 }], [], [], []]);
    const result = await cockpitService(db).get(COMPANY, FOUNDER_ACTOR);

    const runtimeItems = result.approvals.filter((a) => a.source === "runtime_tool_trust");
    expect(runtimeItems).toHaveLength(0);
  });

  it("all 7 sources combined (approval + memory + discussion_item + join_request + memory_version + memory_archive + runtime_tool_trust)", async () => {
    const approvalRow = { id: "appr-1", type: "hire_agent", status: "pending", payload: { name: "Scout" } };
    const discItem = { id: "item-1", discussionId: "disc-1", title: "Insight", type: "insight" };
    const joinRow = { id: "jr-1", requestType: "agent", requestingUserId: null, agentName: "Bot" };
    const runtimeRow = { id: "rt-1", toolName: "write_file", params: {}, expiresAt: new Date(Date.now() + 60_000) };

    mockMemoryServiceListPending.mockResolvedValue({
      items: [{ id: "mem-1", title: "Rule", layer: "domain", category: "coding", status: "pending" }],
      versions: [
        {
          itemId: "mem-item-1",
          itemTitle: "Version rule",
          itemLayer: "domain",
          itemCategory: "coding",
          itemSource: "agent",
          currentContent: "c",
          currentVersionId: "v0",
          version: { id: "ver-1", memoryItemId: "mem-item-1", versionNumber: 2, content: "c2", status: "pending", createdBy: "a", createdAt: new Date() },
        },
      ],
      archives: [
        {
          item: { id: "arch-item-1", companyId: COMPANY, title: "Old rule", content: "c", category: null, source: "agent", status: "approved", tags: [], departmentId: null, projectId: null, createdBy: "founder", layer: "domain", priority: "medium", visibility: "company", expiresAt: null, goalId: null, taskId: null, sourceArtifactId: null, sourceContext: null, accessedAt: null, currentVersionId: null, createdAt: new Date(), updatedAt: new Date() },
          suggestion: { id: "sug-1", companyId: COMPANY, category: "agent_proposal", actionType: "archive_memory", actionPayload: {}, title: "Archive", evidence: null, status: "pending", expiresAt: null, relatedMemoryItemId: "arch-item-1", createdAt: new Date(), updatedAt: new Date() },
        },
      ],
      totalCount: 3,
    });

    const db = buildSequenceDb([[], [], [approvalRow], [discItem], [joinRow], [runtimeRow], [], [], [{ limitCents: 0 }], [], [], []]);
    const result = await cockpitService(db).get(COMPANY, FOUNDER_ACTOR);

    expect(result.approvals).toHaveLength(7);
    const sources = result.approvals.map((a) => a.source);
    expect(sources).toContain("approval");
    expect(sources).toContain("memory");
    expect(sources).toContain("discussion_item");
    expect(sources).toContain("join_request");
    expect(sources).toContain("memory_version");
    expect(sources).toContain("memory_archive");
    expect(sources).toContain("runtime_tool_trust");

    // runtime has decisionType ternary, others do not
    const runtimeItem = result.approvals.find((a) => a.source === "runtime_tool_trust");
    expect(runtimeItem?.decisionType).toBe("ternary");
    const approvalItem = result.approvals.find((a) => a.source === "approval");
    expect(approvalItem?.decisionType).toBeUndefined();
  });
});

// ── Tests: team_member scope (A4 — runtime-only, memory NOT called) ──────────

describe("cockpitApprovals — team_member scope (A4)", () => {
  beforeEach(() => {
    mockResolveCockpitScope.mockResolvedValue(memberScope);
    mockReviewFilterFor.mockReturnValue({ assigneeUserId: "u-member" });
  });

  it("member sees own runtime_tool_trust approval (runtime at slot [2])", async () => {
    const runtimeRow = { id: "rt-m", toolName: "bash", expiresAt: new Date(Date.now() + 60_000) };
    // MEMBER sequence (7 selects): reminders=[], dueTasks=[], runtime=[runtimeRow],
    //   pinned=[], goalsAtRisk=[], doneToday=[], proactive=[]
    const db = buildSequenceDb([[], [], [runtimeRow], [], [], [], []]);
    const result = await cockpitService(db).get(COMPANY, MEMBER_ACTOR);

    expect(result.approvals).toHaveLength(1);
    expect(result.approvals[0]).toMatchObject({
      source: "runtime_tool_trust",
      id: "rt-m",
      title: "bash",
      subtitle: "Tool execution approval",
      decisionType: "ternary",
    });
    // A4: members never see memory
    expect(mockMemoryServiceListPending).not.toHaveBeenCalled();
    // A4: no approval/memory/discussion_item/join_request/memory_version/memory_archive
    const forbidden = ["approval", "memory", "discussion_item", "join_request", "memory_version", "memory_archive"];
    for (const src of forbidden) {
      expect(result.approvals.find((a) => a.source === src)).toBeUndefined();
    }
  });

  it("member with no runtime rows gets empty approvals (runtime at slot [2] = [])", async () => {
    // MEMBER sequence (7 selects): runtime=[] at [2]
    const db = buildSequenceDb([[], [], [], [], [], [], []]);
    const result = await cockpitService(db).get(COMPANY, MEMBER_ACTOR);

    expect(result.approvals).toEqual([]);
    expect(result).toHaveProperty("approvals");
    expect(mockMemoryServiceListPending).not.toHaveBeenCalled();
  });
});

// ── Tests: team_lead scope (A4 — dept-scoped memory + own runtime) ───────────

describe("cockpitApprovals — team_lead scope (A4)", () => {
  const leadScope = {
    userId: "u-lead",
    role: "team_lead" as const,
    isFounder: false,
    leadDepartmentIds: ["dep-a"],
  };
  const LEAD_ACTOR = { actorId: "u-lead", source: "session" as const };
  const runtimeRow = { id: "rt-lead", toolName: "read_file", expiresAt: new Date(Date.now() + 60_000) };

  const archiveFixture = {
    item: {
      id: "arch-item-lead",
      companyId: COMPANY,
      title: "Stale lead rule",
      content: "old",
      category: null,
      source: "agent",
      status: "approved",
      tags: [],
      departmentId: "dep-a",
      projectId: null,
      createdBy: "founder",
      layer: "domain",
      priority: "medium",
      visibility: "company",
      expiresAt: null,
      goalId: null,
      taskId: null,
      sourceArtifactId: null,
      sourceContext: null,
      accessedAt: null,
      currentVersionId: null,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },
    suggestion: {
      id: "sug-lead",
      companyId: COMPANY,
      category: "agent_proposal",
      actionType: "archive_memory",
      actionPayload: {},
      title: "Archive stale lead rule",
      evidence: null,
      status: "pending",
      expiresAt: null,
      relatedMemoryItemId: "arch-item-lead",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    },
  };

  beforeEach(() => {
    mockResolveCockpitScope.mockResolvedValue(leadScope);
    mockReviewFilterFor.mockReturnValue({ projectIds: ["dep-a"] });
    mockMemoryServiceListPending.mockResolvedValue({
      items: [
        // identity layer → excluded even for dep-a lead
        { id: "m-ident", title: "I", layer: "identity", departmentId: "dep-a", category: null, status: "pending" },
        // R5: domain, dep-a → now EXCLUDED (founder-only since PR #201)
        { id: "m-domain", title: "D", layer: "domain", departmentId: "dep-a", category: "coding", status: "pending" },
        // active_context, dep-a → INCLUDED (the one layer a lead may approve)
        { id: "m-ok", title: "OK", layer: "active_context", departmentId: "dep-a", category: "coding", status: "pending" },
        // active_context, dep-b → excluded (not lead's dept)
        { id: "m-other", title: "O", layer: "active_context", departmentId: "dep-b", category: null, status: "pending" },
        // active_context, no dept → excluded (departmentId null)
        { id: "m-nodept", title: "N", layer: "active_context", departmentId: null, category: null, status: "pending" },
      ],
      versions: [
        // active_context, dep-a → INCLUDED
        {
          itemId: "v-ok",
          itemTitle: "V",
          itemLayer: "active_context",
          itemDepartmentId: "dep-a",
          itemCategory: "coding",
          itemSource: "agent",
          currentContent: "c",
          currentVersionId: "c0",
          version: { id: "ver-1", memoryItemId: "v-ok", versionNumber: 2, content: "c2", status: "pending", createdBy: "a", createdAt: new Date() },
        },
        // R5: domain, dep-a version → now EXCLUDED
        {
          itemId: "v-domain",
          itemTitle: "VD",
          itemLayer: "domain",
          itemDepartmentId: "dep-a",
          itemCategory: null,
          itemSource: "agent",
          currentContent: "c",
          currentVersionId: "c0",
          version: { id: "ver-2", memoryItemId: "v-domain", versionNumber: 2, content: "c2", status: "pending", createdBy: "a", createdAt: new Date() },
        },
      ],
      archives: [archiveFixture],
      totalCount: 7,
    });
  });

  it("lead sees dep-a active_context memory only; excludes domain/identity/other-dept/no-dept/archive (R5)", async () => {
    // LEAD sequence (8 selects): reminders=[], dueTasks=[], runtime=[runtimeRow],
    //   pinned=[], goalsAtRisk=[], doneToday=[], proactive=[], teammates-dept=[]
    const db = buildSequenceDb([[], [], [runtimeRow], [], [], [], [], []]);
    const result = await cockpitService(db).get(COMPANY, LEAD_ACTOR);

    // INCLUDED: m-ok (active_context memory), ver-1 (active_context version), rt-lead (runtime)
    const ids = result.approvals.map((a) => a.id);
    expect(ids).toContain("m-ok");
    expect(result.approvals.find((a) => a.source === "memory_version")?.relatedEntityId).toBe("ver-1");
    expect(ids).toContain("rt-lead");

    // EXCLUDED: domain (R5 founder-only), identity, other dept, no dept
    expect(ids).not.toContain("m-domain");
    expect(ids).not.toContain("m-ident");
    expect(ids).not.toContain("m-other");
    expect(ids).not.toContain("m-nodept");
    // EXCLUDED: domain version (R5)
    expect(result.approvals.find((a) => a.source === "memory_version" && a.relatedEntityId === "ver-2")).toBeUndefined();
    // EXCLUDED: archive (founder-only)
    expect(result.approvals.find((a) => a.source === "memory_archive")).toBeUndefined();
    // EXCLUDED: approval/discussion_item/join_request
    expect(result.approvals.find((a) => a.source === "approval")).toBeUndefined();
    expect(result.approvals.find((a) => a.source === "discussion_item")).toBeUndefined();
    expect(result.approvals.find((a) => a.source === "join_request")).toBeUndefined();

    // memory service WAS called (leads can still see active_context memory)
    expect(mockMemoryServiceListPending).toHaveBeenCalledWith(COMPANY);

    // Exactly 3 items total
    expect(result.approvals).toHaveLength(3);
  });

  it("lead with empty leadDepartmentIds sees only own runtime", async () => {
    mockResolveCockpitScope.mockResolvedValue({
      userId: "u-lead",
      role: "team_lead" as const,
      isFounder: false,
      leadDepartmentIds: [],
    });
    // LEAD sequence (8 selects)
    const db = buildSequenceDb([[], [], [runtimeRow], [], [], [], [], []]);
    const result = await cockpitService(db).get(COMPANY, LEAD_ACTOR);

    // All memory excluded (no dept match), only runtime
    expect(result.approvals).toHaveLength(1);
    expect(result.approvals[0]).toMatchObject({ source: "runtime_tool_trust", id: "rt-lead" });
    expect(result.approvals.find((a) => a.source === "memory")).toBeUndefined();
    expect(result.approvals.find((a) => a.source === "memory_version")).toBeUndefined();
  });
});
