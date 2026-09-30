import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, mockCompanyContext, mockDialogContext } from "../test-utils";
import { SuggestionsWidget } from "../../components/home/widgets/SuggestionsWidget";

const { suggestionsApiMock } = vi.hoisted(() => ({
  suggestionsApiMock: { pending: vi.fn(), detect: vi.fn(), accept: vi.fn(), dismiss: vi.fn() },
}));
vi.mock("../../context/CompanyContext", () => ({ useCompany: () => mockCompanyContext }));
vi.mock("../../context/DialogContext", () => ({ useDialog: () => mockDialogContext }));
vi.mock("../../context/ToastContext", () => ({ useToast: () => ({ pushToast: vi.fn() }) }));
vi.mock("../../api/suggestions", () => ({ suggestionsApi: suggestionsApiMock }));

const s = (over: Record<string, unknown>) => ({ id: "s1", companyId: "co-1", category: "memory_gap", actionType: "flag_risk", actionPayload: {}, title: "T", evidence: "E", status: "pending", expiresAt: null, relatedMemoryItemId: null, createdAt: "x", updatedAt: "x", ...over });

describe("SuggestionsWidget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompanyContext.selectedCompanyId = "co-1";
    suggestionsApiMock.pending.mockResolvedValue([s({ id: "s-risk", actionType: "flag_risk", title: "Flag launch risk" })]);
    suggestionsApiMock.accept.mockResolvedValue({});
    suggestionsApiMock.dismiss.mockResolvedValue({});
  });

  it("renders pending suggestions with founder actions and dismiss calls the API", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SuggestionsWidget companyId="co-1" role="founder" size={{ w: 2, h: 1 }} />);
    expect(await screen.findByText("Flag launch risk")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    await vi.waitFor(() => expect(suggestionsApiMock.dismiss).toHaveBeenCalledWith("co-1", "s-risk"));
  });

  it("hides accept/dismiss for non-founders", async () => {
    renderWithProviders(<SuggestionsWidget companyId="co-1" role="team_member" size={{ w: 2, h: 1 }} />);
    expect(await screen.findByText("Flag launch risk")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("shows the loading placeholder while the pending-suggestions query is in flight", () => {
    suggestionsApiMock.pending.mockReset().mockReturnValue(new Promise(() => {})); // never resolves
    renderWithProviders(<SuggestionsWidget companyId="co-1" role="team_member" size={{ w: 2, h: 1 }} />);
    expect(screen.getByText(/Refreshing suggestions/i)).toBeInTheDocument();
  });

  it("shows the 'All caught up' empty state when there are zero pending suggestions", async () => {
    suggestionsApiMock.pending.mockReset().mockResolvedValue([]);
    renderWithProviders(<SuggestionsWidget companyId="co-1" role="team_member" size={{ w: 2, h: 1 }} />);
    expect(await screen.findByText("All caught up")).toBeInTheDocument();
  });

  it("falls back to the empty state (no throw) when the pending-suggestions query errors", async () => {
    suggestionsApiMock.pending.mockReset().mockRejectedValue(new Error("network error"));
    renderWithProviders(<SuggestionsWidget companyId="co-1" role="team_member" size={{ w: 2, h: 1 }} />);
    // useQuery's `data` defaults to [] on error (`const { data: suggestions =
    // [] } = useQuery(...)`), so the widget settles into its normal empty
    // shell rather than throwing or hanging on the loading placeholder.
    expect(await screen.findByText("All caught up")).toBeInTheDocument();
  });

  it("hides the View all toggle when every suggestion fits inside the current row cap", async () => {
    renderWithProviders(<SuggestionsWidget companyId="co-1" role="founder" size={{ w: 2, h: 1 }} />);
    expect(await screen.findByText("Flag launch risk")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View all" })).not.toBeInTheDocument();
  });

  describe("size-responsive default visible count", () => {
    beforeEach(() => {
      suggestionsApiMock.pending.mockResolvedValue(
        Array.from({ length: 8 }, (_, i) => s({ id: `s${i}`, title: `Suggestion ${i}` })),
      );
    });

    it("shows only 2 suggestions by default at h=1, with a View all toggle for the rest", async () => {
      renderWithProviders(<SuggestionsWidget companyId="co-1" role="founder" size={{ w: 2, h: 1 }} />);
      expect(await screen.findByText("Suggestion 0")).toBeInTheDocument();
      expect(screen.getByText("Suggestion 1")).toBeInTheDocument();
      expect(screen.queryByText("Suggestion 2")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "View all" })).toBeInTheDocument();
    });

    it("shows 6 suggestions by default at h=2, with a View all toggle for the rest", async () => {
      renderWithProviders(<SuggestionsWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);
      expect(await screen.findByText("Suggestion 0")).toBeInTheDocument();
      expect(screen.getByText("Suggestion 5")).toBeInTheDocument();
      expect(screen.queryByText("Suggestion 6")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "View all" })).toBeInTheDocument();
    });

    it("View all reveals every suggestion regardless of tile size, and Show less re-collapses it", async () => {
      const user = userEvent.setup();
      renderWithProviders(<SuggestionsWidget companyId="co-1" role="founder" size={{ w: 2, h: 1 }} />);
      await screen.findByText("Suggestion 0");

      await user.click(screen.getByRole("button", { name: "View all" }));
      expect(screen.getByText("Suggestion 7")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Show less" }));
      expect(screen.queryByText("Suggestion 7")).not.toBeInTheDocument();
    });
  });
});
