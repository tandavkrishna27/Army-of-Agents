import { beforeEach, describe, it, expect, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import type { UserRole } from "@armyofagents/shared";
import { renderWithProviders, mockCompanyContext } from "../test-utils";
import { HomeBoard } from "../../components/home/HomeBoard";
import { HomeBoardControls } from "../../components/home/HomeBoardControls";
import { useBoardEdit } from "../../components/home/useBoardEdit";

// Same jsdom-width workaround as HomeBoard.test.tsx (see its comment for why).
const containerWidthMock = vi.hoisted(() => ({ width: 1024 }));
vi.mock("react-grid-layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-grid-layout")>();
  return {
    ...actual,
    useContainerWidth: () => ({
      width: containerWidthMock.width,
      mounted: true,
      containerRef: { current: null },
      measureWidth: vi.fn(),
    }),
  };
});

// Deliberately mocks the API modules (not the hooks) so the REAL
// useHomeSummary/useLiveAgentCount/useHomeBoardLayout hooks + react-query run
// end to end — this is the only way to prove the board doesn't over-fetch,
// since a hook-layer mock (as in HomeBoard.test.tsx) always returns static
// data regardless of how many widgets/observers subscribe to it.
const apiSpies = vi.hoisted(() => ({
  homeSummary: vi.fn(),
  dashboardSummary: vi.fn(),
  approvalsList: vi.fn(),
  workQuestionsList: vi.fn(),
  issuesList: vi.fn(),
  suggestionsPending: vi.fn(),
  suggestionsDetect: vi.fn(),
  liveRunsForCompany: vi.fn(),
  layoutGet: vi.fn(),
  layoutSave: vi.fn(),
  layoutReset: vi.fn(),
  discussionsList: vi.fn(),
  memoryListPending: vi.fn(),
}));

vi.mock("../../context/CompanyContext", () => ({ useCompany: () => mockCompanyContext }));
vi.mock("../../context/DialogContext", () => ({ useDialog: () => ({ openDiscussionCapture: vi.fn() }) }));
vi.mock("../../context/ToastContext", () => ({ useToast: () => ({ pushToast: vi.fn() }) }));
vi.mock("../../lib/timeAgo", () => ({ timeAgo: () => "2m ago" }));

vi.mock("../../api/dashboard", () => ({
  homeApi: { summary: apiSpies.homeSummary },
  dashboardApi: { summary: apiSpies.dashboardSummary },
}));
vi.mock("../../api/approvals", () => ({
  approvalsApi: { list: apiSpies.approvalsList },
}));
vi.mock("../../api/work-questions", () => ({
  workQuestionsApi: { list: apiSpies.workQuestionsList },
}));
vi.mock("../../api/issues", () => ({
  issuesApi: { list: apiSpies.issuesList },
}));
vi.mock("../../api/suggestions", () => ({
  suggestionsApi: {
    pending: apiSpies.suggestionsPending,
    detect: apiSpies.suggestionsDetect,
    accept: vi.fn(),
    dismiss: vi.fn(),
  },
}));
vi.mock("../../api/heartbeats", () => ({
  heartbeatsApi: { liveRunsForCompany: apiSpies.liveRunsForCompany },
}));
vi.mock("../../api/home-board-layout", () => ({
  homeBoardLayoutApi: {
    get: apiSpies.layoutGet,
    save: apiSpies.layoutSave,
    reset: apiSpies.layoutReset,
  },
}));
vi.mock("../../api/discussions", () => ({
  discussionsApi: { list: apiSpies.discussionsList },
}));
vi.mock("../../api/memory", () => ({
  memoryApi: { listPending: apiSpies.memoryListPending },
}));

/** Mirrors HomeBoard.test.tsx's harness (Task D3): Dashboard owns ONE
 * useBoardEdit, shared by the pinned header (HomeBoardControls) and the grid
 * (HomeBoard). */
function HomeBoardHarness({ companyId, role }: { companyId: string; role: UserRole | null }) {
  const boardEdit = useBoardEdit(companyId, role);
  return (
    <>
      <HomeBoardControls boardEdit={boardEdit} />
      <HomeBoard companyId={companyId} role={role} boardEdit={boardEdit} />
    </>
  );
}

describe("HomeBoard query-count (no over-fetch)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    containerWidthMock.width = 1024;
    mockCompanyContext.selectedCompanyId = "co-1";

    apiSpies.homeSummary.mockResolvedValue({
      companyId: "co-1",
      setupStatus: { hasVisionMission: true, hasDepartment: true, hasAgent: true, hasGoal: true },
      firstRunCompleted: true,
      discussionsPendingReview: 0,
      // Non-zero/non-empty so Action queue/Objectives/Today's activity (all
      // three consumers of this one shared query) render actual content
      // rather than self-hiding — proves the board composed real data, not
      // just that a shared empty fetch happened once.
      tasksInReview: 1,
      myTasksDueToday: [],
      blockedTasks: 0,
      pendingMemoryItems: 0,
      recentActivity: [
        { id: "a1", action: "issue.completed", entityType: "issue", entityId: "i1", details: { title: "Spec" }, createdAt: new Date().toISOString(), actorType: "agent", actorId: "z" },
      ],
      goalProgress: [
        { id: "g1", title: "Launch", status: "active", totalTasks: 2, doneTasks: 1, inProgressTasks: 1, blockedTasks: 0, progressPercent: 50 },
      ],
      nudges: [],
    });
    apiSpies.dashboardSummary.mockResolvedValue({
      costs: { monthSpendCents: 41200, monthBudgetCents: 200000, monthUtilizationPercent: 21 },
      pendingApprovals: 1,
    });
    apiSpies.approvalsList.mockResolvedValue([
      { id: "appr-1", companyId: "co-1", type: "hire_agent", status: "pending", payload: {}, createdAt: new Date().toISOString() },
    ]);
    apiSpies.workQuestionsList.mockResolvedValue([
      { id: "q1", title: "Need input", question: "", issueId: "iss-1", issueIdentifierSnapshot: null },
    ]);
    apiSpies.issuesList.mockResolvedValue([{ id: "t1", title: "Ship it", status: "in_progress", priority: "high" }]);
    apiSpies.suggestionsPending.mockResolvedValue([]);
    apiSpies.suggestionsDetect.mockResolvedValue({ ok: true });
    apiSpies.liveRunsForCompany.mockResolvedValue([{ id: "run-1" }]);
    apiSpies.layoutGet.mockResolvedValue(null); // no saved layout -> founder role default (8 widgets, Plan 7 Task 5)
    apiSpies.layoutSave.mockResolvedValue({ layout: [], schemaVersion: 1 });
    apiSpies.layoutReset.mockResolvedValue({ ok: true });
    apiSpies.discussionsList.mockResolvedValue({ discussions: [], total: 0, limit: 0, offset: 0 });
    apiSpies.memoryListPending.mockResolvedValue({ items: [], versions: [], archives: [], totalCount: 0 });
  });

  it("fetches every widget api exactly once for the founder (curated 8-widget) board — no N+1, dashboard dedup confirmed", async () => {
    renderWithProviders(<HomeBoardHarness companyId="co-1" role="founder" />);

    // Settle: wait for the slowest widget (My tasks) plus the full curated
    // 8-widget composition (Plan 7 Task 5) before reading final call counts.
    expect(await screen.findByText("Ship it")).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(8));
    // Also wait for the Waiting-on-you widget's merged list content to
    // settle, since it depends on BOTH approvalsApi.list AND
    // workQuestionsApi.list resolving (Plan 6 Task 4: no longer a single
    // dashboard-summary-derived count).
    expect(await screen.findByText("Need input")).toBeInTheDocument();

    // homeApi.summary: shared by Action queue, Objectives, and Today's
    // activity via the SAME queryKeys.home(companyId) cache entry — expected
    // count is 1, not 3, proving react-query's dedup (not each widget
    // independently fetching).
    expect(apiSpies.homeSummary).toHaveBeenCalledTimes(1);
    // dashboardApi.summary: only Budget calls this now (Waiting-on-you moved
    // to approvalsApi.list in Plan 6 Task 4). Expected count is 1.
    expect(apiSpies.dashboardSummary).toHaveBeenCalledTimes(1);
    // approvalsApi.list: only Waiting-on-you calls this. Expected count is 1.
    expect(apiSpies.approvalsList).toHaveBeenCalledTimes(1);
    // workQuestionsApi.list: only Waiting-on-you calls this. Expected count is 1.
    expect(apiSpies.workQuestionsList).toHaveBeenCalledTimes(1);
    // issuesApi.list: only My tasks calls this (with assigneeUserId: "me").
    // Expected count is 1.
    expect(apiSpies.issuesList).toHaveBeenCalledTimes(1);
    // Plan 7 Task 5: "suggestions" and "memory-review" were curated OFF the
    // founder default board (tray-only now, not dropped from the registry) —
    // neither widget mounts here, so neither's api fires at all. (Previously
    // suggestionsApi.pending did 1 initial fetch + 1 founder-only
    // "detect"-triggered refetch = 2 calls, back when SuggestionsWidget was
    // part of the founder default — see HomeBoard.strictmode.test.tsx for the
    // same history if suggestions/memory-review ever return to the default.)
    expect(apiSpies.suggestionsPending).not.toHaveBeenCalled();
    expect(apiSpies.suggestionsDetect).not.toHaveBeenCalled();
    // heartbeatsApi.liveRunsForCompany: only Agents working now (via
    // useLiveAgentCount) calls this. Expected count is 1.
    expect(apiSpies.liveRunsForCompany).toHaveBeenCalledTimes(1);
    // homeBoardLayoutApi.get: the board's own persisted-layout query
    // (useHomeBoardLayout, underneath useBoardEdit) — exactly one caller.
    // Expected count is 1.
    expect(apiSpies.layoutGet).toHaveBeenCalledTimes(1);
    // discussionsApi.list: only Discussions calls this. Expected count is 1.
    expect(apiSpies.discussionsList).toHaveBeenCalledTimes(1);
    // memoryApi.listPending: Memory review is curated off the founder
    // default too (see the suggestions/memory-review comment above) — never
    // fires.
    expect(apiSpies.memoryListPending).not.toHaveBeenCalled();
    // Never triggered by a plain mount/read.
    expect(apiSpies.layoutSave).not.toHaveBeenCalled();
    expect(apiSpies.layoutReset).not.toHaveBeenCalled();
  });

  it("fetches every widget api exactly once for the member (execution-subset) board too", async () => {
    renderWithProviders(<HomeBoardHarness companyId="co-1" role="team_member" />);

    expect(await screen.findByText("Ship it")).toBeInTheDocument();
    // Plan 7 Task 5: member default is still a 7-widget subset led by My
    // tasks, but approvals ("Waiting on you") flipped ONTO it (previously
    // excluded) — see defaultLayout.ts's MEMBER array.
    await waitFor(() => expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(7));

    expect(apiSpies.homeSummary).toHaveBeenCalledTimes(1);
    expect(apiSpies.issuesList).toHaveBeenCalledTimes(1);
    expect(apiSpies.liveRunsForCompany).toHaveBeenCalledTimes(1);
    // Discussions IS on the member board (Task 5 [Plan 6] added it to both roles).
    expect(apiSpies.discussionsList).toHaveBeenCalledTimes(1);
    // Plan 7 Task 5: approvals ("Waiting on you") is now on the member board
    // too, so BOTH of its apis fire once each — this is the flip from the
    // pre-Task-5 board, where approvals was founder-only.
    expect(apiSpies.approvalsList).toHaveBeenCalledTimes(1);
    expect(apiSpies.workQuestionsList).toHaveBeenCalledTimes(1);
    // Budget/Memory review/Suggestions aren't (and never were) on the member
    // board — their apis never fire.
    expect(apiSpies.dashboardSummary).not.toHaveBeenCalled();
    expect(apiSpies.memoryListPending).not.toHaveBeenCalled();
    // Plan 7 Task 5: "suggestions" was ALSO curated off the member default
    // (tray-only for both roles now), so — unlike the pre-Task-5 board, where
    // it was a plain single fetch here — its api never fires at all.
    expect(apiSpies.suggestionsDetect).not.toHaveBeenCalled();
    expect(apiSpies.suggestionsPending).not.toHaveBeenCalled();
    expect(apiSpies.layoutGet).toHaveBeenCalledTimes(1);
  });
});
