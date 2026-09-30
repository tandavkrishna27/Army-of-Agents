import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { HomeBoardLayoutItem } from "@armyofagents/shared";
import { renderWithProviders, mockBreadcrumbContext, mockCompanyContext, mockDialogContext, makeCompany } from "./test-utils";
import { Dashboard } from "../pages/Dashboard";

const mockNavigate = vi.fn();
const {
  pushToast,
  mockHomeSummary,
  suggestionFixtures,
  suggestionsApiMock,
  memoryApiMock,
} = vi.hoisted(() => ({
  pushToast: vi.fn(),
  mockHomeSummary: {
    companyId: "comp-1",
    discussionsPendingReview: 0,
    tasksInReview: 0,
    blockedTasks: 0,
    myTasksDueToday: [],
    pendingMemoryItems: 0,
    nudges: [],
    recentActivity: [],
    setupStatus: {
      hasVisionMission: true,
      hasDepartment: true,
      hasAgent: true,
      hasGoal: true,
    },
    firstRunCompleted: true,
    goalProgress: [],
  },
  suggestionFixtures: [
    {
      id: "s-create-task",
      companyId: "comp-1",
      category: "goal_gap",
      actionType: "create_task",
      actionPayload: {
        title: "Create launch checklist",
        description: "Break launch prep into a task.",
        projectId: "proj-1",
        priority: "high",
      },
      title: "Turn launch prep into a task",
      evidence: "The launch goal has no active execution task.",
      status: "pending",
      expiresAt: null,
      relatedMemoryItemId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: "s-risk",
      companyId: "comp-1",
      category: "risk_flag",
      actionType: "flag_risk",
      actionPayload: {},
      title: "Flag launch risk",
      evidence: "A blocker has been open for 3 days.",
      status: "pending",
      expiresAt: null,
      relatedMemoryItemId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: "s-memory",
      companyId: "comp-1",
      category: "pattern_detected",
      actionType: "suggest_memory",
      actionPayload: {
        title: "Always include rollout checklist",
        content: "Every production launch needs a rollout checklist.",
        layer: "domain",
        category: "reference",
      },
      title: "Capture rollout checklist guidance",
      evidence: "Founder added the same rollout note in 3 reviews.",
      status: "pending",
      expiresAt: null,
      relatedMemoryItemId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    {
      id: "s-agent",
      companyId: "comp-1",
      category: "agent_proposal",
      actionType: "create_task",
      actionPayload: {
        title: "Review competitor pricing",
        agentName: "Scout",
        agentAvatarUrl: "https://example.com/scout.png",
      },
      title: "Scout proposed competitor pricing research",
      evidence: "Scout found 4 pricing changes this week.",
      status: "pending",
      expiresAt: null,
      relatedMemoryItemId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ],
  suggestionsApiMock: {
    pending: vi.fn(),
    detect: vi.fn(),
    accept: vi.fn(),
    dismiss: vi.fn(),
  },
  memoryApiMock: {
    create: vi.fn(),
  },
}));

// jsdom has no real layout: react-grid-layout's useContainerWidth() (used by
// the HomeBoard this page renders) measures containerRef.current.offsetWidth
// in a mount effect (jsdom always reports 0) and the globally-stubbed
// ResizeObserver (see __tests__/setup.ts) never fires again after that, so
// width would be pinned at 0 and RGL would render no tiles at all. Fix: mock
// just this hook to a fixed, non-zero width so the real Responsive/
// verticalCompactor still run and lay out real tiles. See HomeBoard.test.tsx
// for the same mock applied directly.
vi.mock("react-grid-layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-grid-layout")>();
  return {
    ...actual,
    useContainerWidth: () => ({
      width: 1024,
      mounted: true,
      containerRef: { current: null },
      measureWidth: vi.fn(),
    }),
  };
});

vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    Link: actual.Link,
    NavLink: actual.NavLink,
  };
});

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => mockCompanyContext,
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => mockDialogContext,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => mockBreadcrumbContext,
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast }),
}));

vi.mock("../hooks/useLiveAgentCount", () => ({
  useLiveAgentCount: () => 2,
}));

// Plan 7 Task 5: the founder/member DEFAULT board no longer includes the
// "suggestions" widget (curated down to a smaller default set — it's
// tray-only now), but several tests below exercise the Suggestions widget's
// own behavior (accept/dismiss, founder-gating, agent-badge rendering) as it
// runs inside Dashboard. Rather than rely on incidental default-board
// membership (which the curated default no longer provides), those tests
// pin a small explicit saved layout that puts "suggestions" back on the
// board — exactly like HomeBoard.test.tsx's `homeBoardLayoutMock` pattern.
// Tests that only used a suggestion card's text as a "wait for the board to
// settle" signal (not actually testing suggestions) were switched to wait on
// a widget that IS in the real curated default instead (see below).
const homeBoardLayoutMock = vi.hoisted(() => ({
  layout: null as HomeBoardLayoutItem[] | null,
}));
vi.mock("../hooks/useHomeBoardLayout", () => ({
  useHomeBoardLayout: () => ({
    layout: homeBoardLayoutMock.layout,
    schemaVersion: null,
    isLoading: false,
    isFetching: false,
    refetch: vi.fn(),
    save: vi.fn(),
    saveAsync: vi.fn().mockResolvedValue({ layout: [], schemaVersion: 1 }),
    isSaving: false,
    saveError: null,
    reset: vi.fn(),
    resetAsync: vi.fn(),
    isResetting: false,
    resetError: null,
  }),
}));

// N2: the suggestions-detect trigger is founder-gated client-side. Default to
// founder so the pre-existing tests (which assert detect fires) keep passing.
const teamAccessMock = vi.hoisted(() => ({ role: "founder" as string | null }));
vi.mock("../hooks/useTeamAccess", () => ({
  useTeamAccess: () => ({ role: teamAccessMock.role }),
}));

vi.mock("../api/dashboard", () => ({
  homeApi: { summary: vi.fn().mockResolvedValue(mockHomeSummary) },
  dashboardApi: {
    summary: vi.fn().mockResolvedValue({
      costs: { monthSpendCents: 0, monthBudgetCents: 0, monthUtilizationPercent: 0 },
      pendingApprovals: 0,
    }),
  },
}));

vi.mock("../api/work-questions", () => ({
  workQuestionsApi: { list: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../api/auth", () => ({
  authApi: { getSession: vi.fn().mockResolvedValue({ user: { name: "John Doe" } }) },
}));

vi.mock("../api/suggestions", () => ({
  suggestionsApi: suggestionsApiMock,
}));

vi.mock("../api/memory", () => ({
  memoryApi: memoryApiMock,
}));

vi.mock("../api/goals", () => ({
  goalsApi: { list: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../api/issues", () => ({
  issuesApi: { list: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../lib/timeAgo", () => ({
  timeAgo: () => "2m ago",
}));

// Plan 7 Task 5: a minimal saved layout that puts the Suggestions widget back
// on the board for tests that specifically exercise it (see the
// homeBoardLayoutMock comment above). "agents-now" rides along because one
// of those tests also asserts "Agents working now" is present.
const SUGGESTIONS_TEST_LAYOUT: HomeBoardLayoutItem[] = [
  { i: "suggestions", x: 0, y: 0, w: 2, h: 2 },
  { i: "agents-now", x: 2, y: 0, w: 1, h: 1 },
];

describe("Dashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompanyContext.selectedCompanyId = "comp-1";
    mockCompanyContext.companies = [makeCompany()];
    teamAccessMock.role = "founder";
    homeBoardLayoutMock.layout = null;
    suggestionsApiMock.pending.mockResolvedValue(suggestionFixtures);
    suggestionsApiMock.detect.mockResolvedValue({ ok: true });
    suggestionsApiMock.accept.mockResolvedValue({});
    suggestionsApiMock.dismiss.mockResolvedValue({});
    memoryApiMock.create.mockResolvedValue({});
  });

  it("renders the New menu trigger and suggestion cards from the API", async () => {
    homeBoardLayoutMock.layout = SUGGESTIONS_TEST_LAYOUT;
    renderWithProviders(<Dashboard />);

    expect(await screen.findByText("Turn launch prep into a task")).toBeInTheDocument();
    expect(screen.getByText("Flag launch risk")).toBeInTheDocument();
    // Plan 6 Task 1: the three always-visible "+ New Task"/"+ Discussion"/
    // "+ New Goal" cards are gone — the creators now live behind the "New"
    // trigger (aria-label "Create"; see NewMenu.test.tsx for its own menu
    // contract).
    expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument();
    await waitFor(() => expect(suggestionsApiMock.detect).toHaveBeenCalledWith("comp-1"));

    // Plan 2: the founder board also renders the new data widgets — the
    // live-agent-count widget is mocked to 2, so it always renders.
    expect(await screen.findByText("Agents working now")).toBeInTheDocument();
  });

  it("does not fire suggestions detect for non-founders (server founder-gates it)", async () => {
    teamAccessMock.role = "team_member";
    homeBoardLayoutMock.layout = SUGGESTIONS_TEST_LAYOUT;
    renderWithProviders(<Dashboard />);

    // Wait for the page to settle (suggestions listed) before asserting absence.
    expect(await screen.findByText("Turn launch prep into a task")).toBeInTheDocument();
    expect(suggestionsApiMock.detect).not.toHaveBeenCalled();
  });

  it("hides suggestion accept/dismiss actions for non-founders (server founder-gates them)", async () => {
    teamAccessMock.role = "team_member";
    homeBoardLayoutMock.layout = SUGGESTIONS_TEST_LAYOUT;
    renderWithProviders(<Dashboard />);

    // Cards still render (suggestions are visible to everyone)...
    expect(await screen.findByText("Turn launch prep into a task")).toBeInTheDocument();
    // ...but the founder-only actions are gone (clicking them would 403).
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("create_task accept opens the task dialog with suggestion defaults", async () => {
    homeBoardLayoutMock.layout = SUGGESTIONS_TEST_LAYOUT;
    const user = userEvent.setup();
    renderWithProviders(<Dashboard />);

    const buttons = await screen.findAllByRole("button", { name: "Accept" });
    await user.click(buttons[0]!);

    expect(mockDialogContext.openNewIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Create launch checklist",
        description: "Break launch prep into a task.",
        projectId: "proj-1",
        priority: "high",
      }),
    );
  });

  it("flag_risk accept calls the accept API and shows a toast", async () => {
    homeBoardLayoutMock.layout = SUGGESTIONS_TEST_LAYOUT;
    const user = userEvent.setup();
    renderWithProviders(<Dashboard />);

    const cards = await screen.findAllByRole("button", { name: "Accept" });
    await user.click(cards[1]!);

    await waitFor(() => expect(suggestionsApiMock.accept).toHaveBeenCalledWith("comp-1", "s-risk"));
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Suggestion accepted",
      body: "Risk flagged",
      tone: "success",
    }));
  });

  it("dismiss removes a suggestion card", async () => {
    homeBoardLayoutMock.layout = SUGGESTIONS_TEST_LAYOUT;
    const user = userEvent.setup();
    renderWithProviders(<Dashboard />);

    const dismissButtons = await screen.findAllByRole("button", { name: "Dismiss" });
    await user.click(dismissButtons[1]!);

    await waitFor(() => expect(suggestionsApiMock.dismiss).toHaveBeenCalledWith("comp-1", "s-risk"));
    await waitFor(() => expect(screen.queryByText("Flag launch risk")).not.toBeInTheDocument());
  });

  it("shows the empty state when there are no suggestions", async () => {
    homeBoardLayoutMock.layout = SUGGESTIONS_TEST_LAYOUT;
    suggestionsApiMock.pending.mockResolvedValue([]);
    renderWithProviders(<Dashboard />);

    expect(await screen.findByText("All caught up")).toBeInTheDocument();
  });

  it("shows agent proposals with the agent badge", async () => {
    homeBoardLayoutMock.layout = SUGGESTIONS_TEST_LAYOUT;
    renderWithProviders(<Dashboard />);

    expect(await screen.findByText("Scout")).toBeInTheDocument();
    expect(screen.getByText("Scout proposed competitor pricing research")).toBeInTheDocument();
  });

  it("suggest_memory accept opens the suggested memory dialog", async () => {
    homeBoardLayoutMock.layout = SUGGESTIONS_TEST_LAYOUT;
    const user = userEvent.setup();
    renderWithProviders(<Dashboard />);

    const buttons = await screen.findAllByRole("button", { name: "Accept" });
    await user.click(buttons[2]!);

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Always include rollout checklist")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Every production launch needs a rollout checklist.")).toBeInTheDocument();
  });

  describe("Plan 6 Task 1: + New menu + single-line header", () => {
    it("the header is a single line: greeting renders with no attention subline, and the New trigger is present", async () => {
      renderWithProviders(<Dashboard />);

      // Wait for the board to settle on a widget from the real curated
      // default (Plan 7 Task 5 dropped "suggestions" from the default set).
      expect(await screen.findByText("Agents working now")).toBeInTheDocument();

      // The old "N items need attention"/"All clear" subline is gone.
      expect(screen.queryByText(/items? need attention/)).not.toBeInTheDocument();
      expect(screen.queryByText(/All clear/)).not.toBeInTheDocument();
      // The three always-visible creator cards are gone too.
      expect(screen.queryByText("+ New Task")).not.toBeInTheDocument();
      expect(screen.queryByText("+ Discussion")).not.toBeInTheDocument();
      expect(screen.queryByText("+ New Goal")).not.toBeInTheDocument();

      expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument();
    });

    it("opening the New menu reveals the three creators, still reachable behind one trigger", async () => {
      const user = userEvent.setup();
      renderWithProviders(<Dashboard />);
      expect(await screen.findByText("Agents working now")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Create" }));

      expect(await screen.findByRole("menuitem", { name: "Task" })).toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: "Discussion" })).toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: "Goal" })).toBeInTheDocument();
    });

    it("Task / Discussion / Goal each call their respective useDialog opener", async () => {
      const user = userEvent.setup();
      renderWithProviders(<Dashboard />);
      expect(await screen.findByText("Agents working now")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Create" }));
      await user.click(await screen.findByRole("menuitem", { name: "Task" }));
      expect(mockDialogContext.openNewIssue).toHaveBeenCalledWith();

      await user.click(screen.getByRole("button", { name: "Create" }));
      await user.click(await screen.findByRole("menuitem", { name: "Discussion" }));
      expect(mockDialogContext.openDiscussionCapture).toHaveBeenCalledWith();

      await user.click(screen.getByRole("button", { name: "Create" }));
      await user.click(await screen.findByRole("menuitem", { name: "Goal" }));
      expect(mockDialogContext.openNewGoal).toHaveBeenCalledWith();
    });
  });

  describe("Plan 7 Task 2: date subline", () => {
    it("renders a muted weekday + date line under the greeting", async () => {
      renderWithProviders(<Dashboard />);

      expect(await screen.findByText("Agents working now")).toBeInTheDocument();

      // Weekday + localized date, computed from the real clock via
      // toLocaleDateString(undefined) — so the DAY/MONTH ORDER is locale-
      // dependent (en-GB "Wednesday, 30 July 2026" vs en-US "Wednesday, July
      // 30, 2026"). Assert only the stable parts — a leading weekday name and a
      // trailing 4-digit year — so this passes on any CI/dev locale (a strict
      // "D Month YYYY" regex went red on Linux/en-US) and isn't tied to "today".
      expect(
        screen.getByText(/^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday),.*\d{4}$/),
      ).toBeInTheDocument();
    });
  });

  describe("Task D3: pinned header controls + attention line", () => {
    it("the pinned header (greeting + Customize board control) renders before the grid/summary data has loaded, not blocked by isLoading", async () => {
      renderWithProviders(<Dashboard />);

      // Synchronously right after the initial render — before the mocked
      // home-summary promise has had a chance to resolve — Dashboard's own
      // isLoading is still true (the grid area below shows a skeleton
      // instead of quick actions/HomeBoard), but the pinned header itself
      // (greeting + the board's Customize board control) is never gated on it.
      expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Customize board" })).toBeInTheDocument();

      // Let the pending queries settle before the test ends (avoids an
      // act() warning from state updates landing after this test returns).
      expect(await screen.findByText("Agents working now")).toBeInTheDocument();
    });

    it("the header's Customize board control and the board below it share one edit session (not two independent ones)", async () => {
      const user = userEvent.setup();
      renderWithProviders(<Dashboard />);

      expect(await screen.findByText("Agents working now")).toBeInTheDocument();

      // Not editing yet: no per-tile remove buttons.
      expect(screen.queryAllByLabelText(/^Remove /)).toHaveLength(0);

      // Plan 7 Task 3 (P1-1): "Customize board" opens a dropdown now —
      // select "Rearrange tiles" to actually enter edit mode.
      await user.click(screen.getByRole("button", { name: "Customize board" }));
      await user.click(await screen.findByRole("menuitem", { name: "Rearrange tiles" }));

      // Remove buttons appear on the widget tiles rendered by HomeBoard below
      // — proof the header (HomeBoardControls) and the grid (HomeBoard)
      // consume the SAME useBoardEdit instance from Dashboard, not two
      // separately-created ones that would drift out of sync.
      expect(screen.getAllByLabelText(/^Remove /).length).toBeGreaterThan(0);
      // Done now lives in the floating ArrangeToolbar (mounted by HomeBoard),
      // not the header — the header's own customize icon stays put (no
      // header morph/shift) but goes inert/disabled while arranging.
      expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Customize board" })).toBeDisabled();
    });
  });
});
