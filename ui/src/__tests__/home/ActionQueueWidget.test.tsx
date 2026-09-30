import { screen } from "@testing-library/react";
import { renderWithProviders, mockCompanyContext } from "../test-utils";
import { ActionQueueWidget } from "../../components/home/widgets/ActionQueueWidget";

// A vi.fn() (not a fixed object) so individual tests below can override the
// hook's return value per-case (loading/empty/error), matching the pattern
// used by AgentsNowWidget.test.tsx's useLiveAgentCountMock.
const { useHomeSummaryMock } = vi.hoisted(() => ({ useHomeSummaryMock: vi.fn() }));
vi.mock("../../context/CompanyContext", () => ({ useCompany: () => mockCompanyContext }));
vi.mock("../../hooks/useHomeSummary", () => ({ useHomeSummary: useHomeSummaryMock }));

describe("ActionQueueWidget", () => {
  beforeEach(() => {
    useHomeSummaryMock.mockReturnValue({
      data: {
        tasksInReview: 2, blockedTasks: 1, discussionsPendingReview: 0,
        myTasksDueToday: [{ id: "t1", title: "Ship it", status: "in_progress", priority: "high", dueDate: null, assigneeAgentId: null, assigneeUserId: "u1" }],
      },
      isLoading: false,
      isError: false,
      error: null,
    });
  });

  it("renders the Needs Review, Blocked, and Due Today groups (collapsible)", () => {
    // h=2 -> rowsForSize = 6, comfortably fitting this fixture's 3 groups x 1
    // item each (3 total) with no truncation — see the "size-responsive
    // truncation" describe block below for the h=1 (budget=2) behavior.
    renderWithProviders(<ActionQueueWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);
    expect(screen.getByText("Needs Review")).toBeInTheDocument();
    expect(screen.getByText("Blocked")).toBeInTheDocument();
    expect(screen.getByText("Due Today")).toBeInTheDocument();
    expect(screen.getByText("Ship it")).toBeInTheDocument();
  });

  it("shows the shell + loading placeholder while the summary query is in flight", () => {
    useHomeSummaryMock.mockReturnValue({ data: undefined, isLoading: true, isError: false, error: null });
    renderWithProviders(<ActionQueueWidget companyId="co-1" role="founder" size={{ w: 2, h: 1 }} />);

    expect(screen.getByText("Action queue")).toBeInTheDocument();
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
  });

  it("shows the empty state (no CTA) when the summary has zero actionable items", () => {
    useHomeSummaryMock.mockReturnValue({
      data: { tasksInReview: 0, blockedTasks: 0, discussionsPendingReview: 0, myTasksDueToday: [] },
      isLoading: false,
      isError: false,
      error: null,
    });
    renderWithProviders(<ActionQueueWidget companyId="co-1" role="founder" size={{ w: 2, h: 1 }} />);

    expect(screen.getByText("Nothing needs review — all clear")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows an error empty state (no throw) when the summary query errors", () => {
    useHomeSummaryMock.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: new Error("network error") });
    renderWithProviders(<ActionQueueWidget companyId="co-1" role="founder" size={{ w: 2, h: 1 }} />);

    expect(screen.getByText("Couldn't load")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders each action-queue row as a deep link to its target when not editing", () => {
    renderWithProviders(<ActionQueueWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);
    const link = screen.getByRole("link", { name: /Ship it/i });
    expect(link).toHaveAttribute("href", "/issues/t1");
  });

  it("does not render action-queue rows as links while editing", () => {
    renderWithProviders(<ActionQueueWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} editing />);
    expect(screen.getByText("Ship it")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Ship it/i })).not.toBeInTheDocument();
  });

  describe("size-responsive truncation", () => {
    it("truncates whole groups once the row budget (2, at h=1) runs out, folding the rest into a '+N more' tail", () => {
      // Same fixture as the outer beforeEach: Needs Review (1 item: "2 tasks
      // in review") + Blocked (1 item) + Due Today (1 item) = 3 total, but
      // h=1 -> rowsForSize = 2. Needs Review then Blocked exactly fill the
      // budget in order, so Due Today is dropped entirely (not rendered as
      // an empty section) and its 1 item folds into the overflow tail.
      renderWithProviders(<ActionQueueWidget companyId="co-1" role="founder" size={{ w: 2, h: 1 }} />);
      expect(screen.getByText("Needs Review")).toBeInTheDocument();
      expect(screen.getByText("Blocked")).toBeInTheDocument();
      expect(screen.queryByText("Due Today")).not.toBeInTheDocument();
      expect(screen.queryByText("Ship it")).not.toBeInTheDocument();
      expect(screen.getByText("+1 more")).toBeInTheDocument();
    });

    it("keeps a group's header count badge accurate (the TRUE total) even when its rows are partially truncated", () => {
      useHomeSummaryMock.mockReturnValue({
        data: {
          tasksInReview: 0,
          blockedTasks: 0,
          discussionsPendingReview: 0,
          myTasksDueToday: Array.from({ length: 5 }, (_, i) => ({
            id: `t${i}`,
            title: `Task ${i}`,
            status: "todo",
            priority: "medium",
            dueDate: null,
            assigneeAgentId: null,
            assigneeUserId: "u1",
          })),
        },
        isLoading: false,
        isError: false,
        error: null,
      });
      // h=1 -> budget 2, but the group has 5 items — the header badge must
      // still say 5 (the true count), not 2 (the truncated visible count).
      renderWithProviders(<ActionQueueWidget companyId="co-1" role="founder" size={{ w: 2, h: 1 }} />);
      expect(screen.getByText("Task 0")).toBeInTheDocument();
      expect(screen.getByText("Task 1")).toBeInTheDocument();
      expect(screen.queryByText("Task 2")).not.toBeInTheDocument();
      expect(screen.getByText("5")).toBeInTheDocument(); // the Due Today group's count badge
      expect(screen.getByText("+3 more")).toBeInTheDocument();
    });

    it("shows no '+N more' tail when every group's items fit inside the current row budget", () => {
      // h=2 -> budget 6, comfortably fitting all 3 groups (3 items total).
      renderWithProviders(<ActionQueueWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);
      expect(screen.getByText("Ship it")).toBeInTheDocument();
      expect(screen.queryByText(/more$/)).not.toBeInTheDocument();
    });
  });
});
