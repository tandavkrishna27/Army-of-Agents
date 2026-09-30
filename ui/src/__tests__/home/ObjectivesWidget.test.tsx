import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, mockCompanyContext, mockDialogContext } from "../test-utils";
import { ObjectivesWidget } from "../../components/home/widgets/ObjectivesWidget";

const { useHomeSummaryMock } = vi.hoisted(() => ({ useHomeSummaryMock: vi.fn() }));
vi.mock("../../context/CompanyContext", () => ({ useCompany: () => mockCompanyContext }));
vi.mock("../../context/DialogContext", () => ({ useDialog: () => mockDialogContext }));
vi.mock("../../hooks/useHomeSummary", () => ({ useHomeSummary: useHomeSummaryMock }));

describe("ObjectivesWidget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useHomeSummaryMock.mockReturnValue({
      data: {
        goalProgress: [
          { id: "g1", title: "Launch v1.1", status: "at_risk", totalTasks: 10, doneTasks: 7, inProgressTasks: 2, blockedTasks: 1, progressPercent: 70 },
          { id: "g2", title: "No tasks goal", status: "active", totalTasks: 0, doneTasks: 0, inProgressTasks: 0, blockedTasks: 0, progressPercent: 0 },
        ],
      },
      isLoading: false,
      isError: false,
      error: null,
    });
  });

  it("renders goals with the At Risk pill and task counts", () => {
    renderWithProviders(<ObjectivesWidget companyId="co-1" role="founder" size={{ w: 2, h: 1 }} />);
    expect(screen.getByText("Launch v1.1")).toBeInTheDocument();
    expect(screen.getByText("At Risk")).toBeInTheDocument();
    expect(screen.getByText("7/10 tasks")).toBeInTheDocument();
  });
  it("shows 'no tasks yet' instead of a 0% bar for a zero-task goal", () => {
    renderWithProviders(<ObjectivesWidget companyId="co-1" role="founder" size={{ w: 2, h: 1 }} />);
    expect(screen.getByText(/no tasks yet/i)).toBeInTheDocument();
  });

  it("shows the shell + loading placeholder while the summary query is in flight", () => {
    useHomeSummaryMock.mockReturnValue({ data: undefined, isLoading: true, isError: false, error: null });
    renderWithProviders(<ObjectivesWidget companyId="co-1" role="founder" size={{ w: 2, h: 1 }} />);
    // The shell (title) always renders now — never a blank tile.
    expect(screen.getByText("Objectives")).toBeInTheDocument();
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
  });

  it("shows the empty state with a New goal CTA when there are zero goals", async () => {
    useHomeSummaryMock.mockReturnValue({ data: { goalProgress: [] }, isLoading: false, isError: false, error: null });
    const user = userEvent.setup();
    renderWithProviders(<ObjectivesWidget companyId="co-1" role="founder" size={{ w: 2, h: 1 }} />);

    expect(screen.getByText("No objectives yet")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "+ New goal" }));
    expect(mockDialogContext.openNewGoal).toHaveBeenCalledTimes(1);
  });

  it("hides the New goal CTA while the board is in edit mode (review P2: no add-dialog mid-drag)", () => {
    useHomeSummaryMock.mockReturnValue({ data: { goalProgress: [] }, isLoading: false, isError: false, error: null });
    renderWithProviders(<ObjectivesWidget companyId="co-1" role="founder" size={{ w: 2, h: 1 }} editing />);

    expect(screen.getByText("No objectives yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ New goal" })).not.toBeInTheDocument();
  });

  it("shows an error empty state (no CTA, no throw) when the summary query errors", () => {
    useHomeSummaryMock.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: new Error("network error") });
    renderWithProviders(<ObjectivesWidget companyId="co-1" role="founder" size={{ w: 2, h: 1 }} />);

    expect(screen.getByText("Couldn't load objectives")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders each goal row as a deep link to its objective when not editing", () => {
    renderWithProviders(<ObjectivesWidget companyId="co-1" role="founder" size={{ w: 2, h: 1 }} />);
    const link = screen.getByRole("link", { name: /Launch v1\.1/i });
    expect(link).toHaveAttribute("href", "/goals/g1");
  });

  it("does not render goal rows as links while editing", () => {
    renderWithProviders(<ObjectivesWidget companyId="co-1" role="founder" size={{ w: 2, h: 1 }} editing />);
    expect(screen.getByText("Launch v1.1")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Launch v1\.1/i })).not.toBeInTheDocument();
  });

  describe("size-responsive row cap", () => {
    beforeEach(() => {
      useHomeSummaryMock.mockReturnValue({
        data: {
          goalProgress: Array.from({ length: 8 }, (_, i) => ({
            id: `g${i}`,
            title: `Goal ${i}`,
            status: "active",
            totalTasks: 4,
            doneTasks: 1,
            inProgressTasks: 1,
            blockedTasks: 0,
            progressPercent: 25,
          })),
        },
        isLoading: false,
        isError: false,
        error: null,
      });
    });

    it("caps at 2 rows + a '+N more' tail for a short (h=1) tile", () => {
      renderWithProviders(<ObjectivesWidget companyId="co-1" role="founder" size={{ w: 2, h: 1 }} />);
      expect(screen.getByText("Goal 0")).toBeInTheDocument();
      expect(screen.getByText("Goal 1")).toBeInTheDocument();
      expect(screen.queryByText("Goal 2")).not.toBeInTheDocument();
      expect(screen.getByText("+6 more")).toBeInTheDocument();
    });

    it("caps at 6 rows + a '+N more' tail for a tall (h=2) tile", () => {
      renderWithProviders(<ObjectivesWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);
      expect(screen.getByText("Goal 0")).toBeInTheDocument();
      expect(screen.getByText("Goal 5")).toBeInTheDocument();
      expect(screen.queryByText("Goal 6")).not.toBeInTheDocument();
      expect(screen.getByText("+2 more")).toBeInTheDocument();
    });
  });

  it("shows no '+N more' tail when every goal fits inside the current row cap", () => {
    renderWithProviders(<ObjectivesWidget companyId="co-1" role="founder" size={{ w: 2, h: 1 }} />);
    expect(screen.getByText("Launch v1.1")).toBeInTheDocument();
    expect(screen.queryByText(/more$/)).not.toBeInTheDocument();
  });
});
