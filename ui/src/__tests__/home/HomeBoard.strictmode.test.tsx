import React from "react";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

// Deliberately DIFFERENT from HomeBoard.test.tsx's mocking strategy: that file
// mocks useHomeSummary/useLiveAgentCount/useHomeBoardLayout at the HOOK layer
// (bypassing react-query entirely), which can't prove anything about
// StrictMode's double-invoke of effects/queries. This file mocks only the
// underlying API modules and lets the REAL hooks + react-query run, so the
// spy call-counts below actually exercise react-query's own fetch dedup
// under a StrictMode double-mount (React 18 dev-mode: mount -> cleanup ->
// mount once, synchronously, before any async work settles).
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

/** Mirrors HomeBoard.test.tsx's harness: Dashboard owns ONE useBoardEdit and
 * shares it with both the pinned header (HomeBoardControls) and the grid
 * (HomeBoard) — see useBoardEdit.ts's doc comment (Task D3). */
function HomeBoardHarness({ companyId, role }: { companyId: string; role: UserRole | null }) {
  const boardEdit = useBoardEdit(companyId, role);
  return (
    <>
      <HomeBoardControls boardEdit={boardEdit} role={role} />
      <HomeBoard companyId={companyId} role={role} boardEdit={boardEdit} />
    </>
  );
}

describe("HomeBoard under React.StrictMode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    containerWidthMock.width = 1024;
    mockCompanyContext.selectedCompanyId = "co-1";

    apiSpies.homeSummary.mockResolvedValue({
      companyId: "co-1",
      setupStatus: { hasVisionMission: true, hasDepartment: true, hasAgent: true, hasGoal: true },
      firstRunCompleted: true,
      discussionsPendingReview: 0,
      // Non-zero so Action queue doesn't self-hide (matches HomeBoard.test.tsx's founder fixture).
      tasksInReview: 1,
      myTasksDueToday: [],
      blockedTasks: 0,
      pendingMemoryItems: 0,
      // Non-empty so Today's activity doesn't self-hide.
      recentActivity: [
        { id: "a1", action: "issue.completed", entityType: "issue", entityId: "i1", details: { title: "Spec" }, createdAt: new Date().toISOString(), actorType: "agent", actorId: "z" },
      ],
      // Non-empty so Objectives doesn't self-hide.
      goalProgress: [
        { id: "g1", title: "Launch", status: "active", totalTasks: 2, doneTasks: 1, inProgressTasks: 1, blockedTasks: 0, progressPercent: 50 },
      ],
      nudges: [],
    });
    apiSpies.dashboardSummary.mockResolvedValue({
      costs: { monthSpendCents: 0, monthBudgetCents: 0, monthUtilizationPercent: 0 },
      pendingApprovals: 0,
    });
    apiSpies.approvalsList.mockResolvedValue([]);
    apiSpies.workQuestionsList.mockResolvedValue([]);
    apiSpies.issuesList.mockResolvedValue([{ id: "t1", title: "Ship it", status: "in_progress", priority: "high" }]);
    apiSpies.suggestionsPending.mockResolvedValue([]);
    apiSpies.suggestionsDetect.mockResolvedValue({ ok: true });
    apiSpies.liveRunsForCompany.mockResolvedValue([]);
    apiSpies.layoutGet.mockResolvedValue(null); // no saved layout -> founder role default (8 widgets, Plan 7 Task 5)
    apiSpies.layoutSave.mockResolvedValue({ layout: [], schemaVersion: 1 });
    apiSpies.layoutReset.mockResolvedValue({ ok: true });
    apiSpies.discussionsList.mockResolvedValue({ discussions: [], total: 0, limit: 0, offset: 0 });
    apiSpies.memoryListPending.mockResolvedValue({ items: [], versions: [], archives: [], totalCount: 0 });
  });

  it("mounts cleanly with no spurious save, and a no-op edit round-trip never saves", async () => {
    renderWithProviders(
      <React.StrictMode>
        <HomeBoardHarness companyId="co-1" role="founder" />
      </React.StrictMode>,
    );

    // The board renders once settled: all 8 curated founder widgets, each in
    // its own heading (proves real content composed, not just StrictMode not
    // crashing).
    expect(await screen.findByText("Ship it")).toBeInTheDocument();
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toHaveLength(8);

    // Not editing: save is NEVER called on mount, despite StrictMode's
    // mount->cleanup->mount of useBoardEdit/useHomeBoardLayout.
    expect(apiSpies.layoutSave).not.toHaveBeenCalled();

    // Entering edit then immediately exiting with no change: a clean draft
    // means exitEdit's attemptSave is a no-op (Task C1 rule 7) — save stays
    // at zero calls.
    const user = userEvent.setup();
    // Plan 7 Task 3 (P1-1): "Customize board" opens a dropdown now — select
    // "Rearrange tiles" to actually enter edit mode.
    await user.click(screen.getByRole("button", { name: "Customize board" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rearrange tiles" }));
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Customize board" })).toBeInTheDocument());
    expect(apiSpies.layoutSave).not.toHaveBeenCalled();
  });

  it("fetches each widget's data at most once despite StrictMode's double-render (query dedup)", async () => {
    renderWithProviders(
      <React.StrictMode>
        <HomeBoardHarness companyId="co-1" role="founder" />
      </React.StrictMode>,
    );

    expect(await screen.findByText("Ship it")).toBeInTheDocument();
    // Let the board settle fully (every widget's own query resolved) before
    // reading final call counts.
    await waitFor(() => expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(8));

    // homeApi.summary is shared by 3 widgets (Action queue, Objectives,
    // Today's activity) via the SAME queryKeys.home(companyId) cache entry;
    // dashboardApi.summary is called by Budget alone (Waiting-on-you moved to
    // approvalsApi.list in Plan 6 Task 4). Each still dedups to one call under
    // StrictMode's synthetic double-mount, because react-query's in-flight-
    // promise dedup is keyed on the query hash, not on how many times an
    // observer (re)subscribes.
    expect(apiSpies.homeSummary.mock.calls.length).toBeLessThanOrEqual(1);
    expect(apiSpies.dashboardSummary.mock.calls.length).toBeLessThanOrEqual(1);
    expect(apiSpies.approvalsList.mock.calls.length).toBeLessThanOrEqual(1);
    expect(apiSpies.workQuestionsList.mock.calls.length).toBeLessThanOrEqual(1);
    expect(apiSpies.issuesList.mock.calls.length).toBeLessThanOrEqual(1);
    // Plan 7 Task 5: "suggestions" and "memory-review" were curated OFF the
    // founder default board (tray-only now) — neither widget mounts here, so
    // neither's query/mutation fires at all. (Previously suggestionsApi.pending
    // was a documented exception at exactly 2 calls — 1 initial fetch + 1
    // founder-only "detect"-triggered refetch — back when SuggestionsWidget
    // was part of the founder default; see git history for that reasoning if
    // suggestions/memory-review ever return to the default set.)
    expect(apiSpies.suggestionsPending).not.toHaveBeenCalled();
    expect(apiSpies.suggestionsDetect).not.toHaveBeenCalled();
    expect(apiSpies.memoryListPending).not.toHaveBeenCalled();
    expect(apiSpies.liveRunsForCompany.mock.calls.length).toBeLessThanOrEqual(1);
    // The board's own persisted-layout query (useHomeBoardLayout, underneath
    // useBoardEdit) — the literal "query dedup" the plan calls out.
    expect(apiSpies.layoutGet.mock.calls.length).toBeLessThanOrEqual(1);
    // Plan 6: "discussions" — the one Plan 6 widget that stayed in the
    // curated founder default (Task 5/6's other addition, memory-review, did
    // not — see above).
    expect(apiSpies.discussionsList.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
