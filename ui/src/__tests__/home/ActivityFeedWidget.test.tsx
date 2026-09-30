import { screen } from "@testing-library/react";
import { renderWithProviders, mockCompanyContext } from "../test-utils";
import { ActivityFeedWidget } from "../../components/home/widgets/ActivityFeedWidget";

const { useHomeSummaryMock } = vi.hoisted(() => ({ useHomeSummaryMock: vi.fn() }));
vi.mock("../../context/CompanyContext", () => ({ useCompany: () => mockCompanyContext }));
vi.mock("../../lib/timeAgo", () => ({ timeAgo: () => "2m ago" }));
vi.mock("../../hooks/useHomeSummary", () => ({ useHomeSummary: useHomeSummaryMock }));

describe("ActivityFeedWidget", () => {
  beforeEach(() => {
    useHomeSummaryMock.mockReturnValue({
      data: {
        recentActivity: [
          { id: "a1", action: "issue.completed", entityType: "issue", entityId: "i1", details: { title: "Draft spec" }, createdAt: "x", actorType: "agent", actorId: "z" },
        ],
      },
      isLoading: false,
      isError: false,
      error: null,
    });
  });

  it("renders activity rows with the issue→task word substitution", () => {
    renderWithProviders(<ActivityFeedWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);
    expect(screen.getByText(/task completed/i)).toBeInTheDocument();
    expect(screen.getByText("Draft spec")).toBeInTheDocument();
  });

  it("shows the shell + loading placeholder while the summary query is in flight", () => {
    useHomeSummaryMock.mockReturnValue({ data: undefined, isLoading: true, isError: false, error: null });
    renderWithProviders(<ActivityFeedWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);

    expect(screen.getByText("Today's activity")).toBeInTheDocument();
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
  });

  it("shows the empty state (no CTA) when there is no recent activity", () => {
    useHomeSummaryMock.mockReturnValue({ data: { recentActivity: [] }, isLoading: false, isError: false, error: null });
    renderWithProviders(<ActivityFeedWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);

    expect(screen.getByText("Agent activity will show up here as your crew starts working.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows an error empty state (no throw) when the summary query errors", () => {
    useHomeSummaryMock.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: new Error("network error") });
    renderWithProviders(<ActivityFeedWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);

    expect(screen.getByText("Couldn't load activity")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders the activity row as a deep link to its entity when not editing", () => {
    renderWithProviders(<ActivityFeedWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);
    const link = screen.getByRole("link", { name: /Draft spec/i });
    expect(link).toHaveAttribute("href", "/issues/i1");
  });

  it("does not render the activity row as a link while editing", () => {
    renderWithProviders(<ActivityFeedWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} editing />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("Draft spec")).toBeInTheDocument();
  });

  it("renders a plain (non-navigating) row when the activity's entity type has no deep link", () => {
    useHomeSummaryMock.mockReturnValue({
      data: {
        recentActivity: [
          { id: "a2", action: "cost.recorded", entityType: "cost", entityId: "c1", details: null, createdAt: "x", actorType: "agent", actorId: "z" },
        ],
      },
      isLoading: false,
      isError: false,
      error: null,
    });
    renderWithProviders(<ActivityFeedWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);
    // The widget's own header link ("Open Today's activity" -> /activity) still
    // renders — only the row itself must stay a non-navigating element.
    expect(screen.queryByRole("link", { name: /cost recorded/i })).not.toBeInTheDocument();
    expect(screen.getByText(/cost recorded/i)).toBeInTheDocument();
  });

  // Plan 7 Task 4: de-noise — consecutive duplicate events collapse into one
  // row with a "×N" suffix instead of flooding the feed with repeats.
  describe("de-noise (collapseActivity)", () => {
    beforeEach(() => {
      useHomeSummaryMock.mockReturnValue({
        data: {
          recentActivity: [
            { id: "a1", action: "issue.completed", entityType: "issue", entityId: "i1", details: { title: "Draft spec" }, createdAt: "2026-07-30T03:00:00.000Z", actorType: "agent", actorId: "z" },
            { id: "a2", action: "issue.completed", entityType: "issue", entityId: "i1", details: { title: "Draft spec" }, createdAt: "2026-07-30T02:00:00.000Z", actorType: "agent", actorId: "z" },
            { id: "a3", action: "issue.completed", entityType: "issue", entityId: "i1", details: { title: "Draft spec" }, createdAt: "2026-07-30T01:00:00.000Z", actorType: "agent", actorId: "z" },
          ],
        },
        isLoading: false,
        isError: false,
        error: null,
      });
    });

    it("renders 3 consecutive identical events as a single collapsed row with a ×3 suffix", () => {
      renderWithProviders(<ActivityFeedWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);

      expect(screen.getByText("Draft spec")).toBeInTheDocument();
      expect(screen.getByText(/×3/)).toBeInTheDocument();
      // Only one row rendered for the whole run, not three.
      expect(screen.getAllByText("Draft spec")).toHaveLength(1);
    });

    it("still deep-links the collapsed row to its entity when not editing", () => {
      renderWithProviders(<ActivityFeedWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);
      const link = screen.getByRole("link", { name: /Draft spec/i });
      expect(link).toHaveAttribute("href", "/issues/i1");
      expect(link).toHaveTextContent("×3");
    });

    it("does not render the collapsed row as a link while editing (editing-gate intact)", () => {
      renderWithProviders(<ActivityFeedWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} editing />);
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
      expect(screen.getByText("Draft spec")).toBeInTheDocument();
      expect(screen.getByText(/×3/)).toBeInTheDocument();
    });

    it("does not show a ×N suffix for a non-repeated (count 1) event", () => {
      useHomeSummaryMock.mockReturnValue({
        data: {
          recentActivity: [
            { id: "a1", action: "issue.completed", entityType: "issue", entityId: "i1", details: { title: "Draft spec" }, createdAt: "x", actorType: "agent", actorId: "z" },
          ],
        },
        isLoading: false,
        isError: false,
        error: null,
      });
      renderWithProviders(<ActivityFeedWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);
      expect(screen.getByText("Draft spec")).toBeInTheDocument();
      expect(screen.queryByText(/×/)).not.toBeInTheDocument();
    });

    it("keeps non-adjacent duplicates as separate rows, each without a ×N suffix", () => {
      useHomeSummaryMock.mockReturnValue({
        data: {
          recentActivity: [
            { id: "a1", action: "issue.completed", entityType: "issue", entityId: "i1", details: { title: "Draft spec" }, createdAt: "x", actorType: "agent", actorId: "z" },
            { id: "a2", action: "issue.created", entityType: "issue", entityId: "i2", details: { title: "Other task" }, createdAt: "x", actorType: "agent", actorId: "z" },
            { id: "a3", action: "issue.completed", entityType: "issue", entityId: "i1", details: { title: "Draft spec" }, createdAt: "x", actorType: "agent", actorId: "z" },
          ],
        },
        isLoading: false,
        isError: false,
        error: null,
      });
      renderWithProviders(<ActivityFeedWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);
      expect(screen.getAllByText("Draft spec")).toHaveLength(2);
      expect(screen.queryByText(/×/)).not.toBeInTheDocument();
    });
  });

  describe("size-responsive row cap", () => {
    beforeEach(() => {
      useHomeSummaryMock.mockReturnValue({
        data: {
          recentActivity: Array.from({ length: 8 }, (_, i) => ({
            id: `a${i}`,
            action: "issue.completed",
            entityType: "issue",
            entityId: `i${i}`,
            details: { title: `Task ${i}` },
            createdAt: "x",
            actorType: "agent",
            actorId: "z",
          })),
        },
        isLoading: false,
        isError: false,
        error: null,
      });
    });

    it("caps at 2 rows + a '+N more' tail for a short (h=1) tile", () => {
      renderWithProviders(<ActivityFeedWidget companyId="co-1" role="founder" size={{ w: 2, h: 1 }} />);
      expect(screen.getByText("Task 0")).toBeInTheDocument();
      expect(screen.getByText("Task 1")).toBeInTheDocument();
      expect(screen.queryByText("Task 2")).not.toBeInTheDocument();
      expect(screen.getByText("+6 more")).toBeInTheDocument();
    });

    it("caps at 6 rows + a '+N more' tail for a tall (h=2) tile", () => {
      renderWithProviders(<ActivityFeedWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);
      expect(screen.getByText("Task 0")).toBeInTheDocument();
      expect(screen.getByText("Task 5")).toBeInTheDocument();
      expect(screen.queryByText("Task 6")).not.toBeInTheDocument();
      expect(screen.getByText("+2 more")).toBeInTheDocument();
    });
  });

  it("shows no '+N more' tail when every activity row fits inside the current row cap", () => {
    renderWithProviders(<ActivityFeedWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);
    expect(screen.getByText("Draft spec")).toBeInTheDocument();
    expect(screen.queryByText(/more$/)).not.toBeInTheDocument();
  });
});
