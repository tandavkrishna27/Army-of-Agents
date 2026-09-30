import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, mockCompanyContext } from "../test-utils";
import { ApprovalsWidget } from "../../components/home/widgets/ApprovalsWidget";

const { approvalsApiMock, wqApiMock } = vi.hoisted(() => ({
  approvalsApiMock: { list: vi.fn() },
  wqApiMock: { list: vi.fn() },
}));
vi.mock("../../context/CompanyContext", () => ({ useCompany: () => mockCompanyContext }));
vi.mock("../../api/approvals", () => ({ approvalsApi: approvalsApiMock }));
vi.mock("../../api/work-questions", () => ({ workQuestionsApi: wqApiMock }));

describe("ApprovalsWidget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    approvalsApiMock.list.mockResolvedValue([]);
    wqApiMock.list.mockResolvedValue([]);
  });

  it("renders the 'Waiting on you' title", async () => {
    renderWithProviders(<ApprovalsWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);
    expect(await screen.findByText("Waiting on you")).toBeInTheDocument();
  });

  it("shows the shell + loading placeholder while either query is in flight", () => {
    wqApiMock.list.mockReturnValue(new Promise(() => {})); // never resolves
    renderWithProviders(<ApprovalsWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);
    expect(screen.getByText("Waiting on you")).toBeInTheDocument();
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
  });

  it("shows 'Nothing waiting on you' with no CTA when both approvals and questions are empty", async () => {
    renderWithProviders(<ApprovalsWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);
    expect(await screen.findByText("Nothing waiting on you")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders an approval row labeled from the ApprovalType map, linking to /approvals/:id", async () => {
    approvalsApiMock.list.mockResolvedValue([
      { id: "appr-1", companyId: "co-1", type: "hire_agent", status: "pending", payload: {}, createdAt: new Date().toISOString() },
    ]);
    renderWithProviders(<ApprovalsWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);

    const link = await screen.findByRole("link", { name: /Hire Agent/i });
    expect(link).toHaveAttribute("href", "/approvals/appr-1");
  });

  it("renders a question row using title (falling back to question), linking to the issue by identifier over id", async () => {
    wqApiMock.list.mockResolvedValue([
      { id: "q1", title: "Need input on scope", question: "", issueId: "iss-1", issueIdentifierSnapshot: "TC-9" },
      { id: "q2", title: "", question: "Should we ship Friday?", issueId: "iss-2", issueIdentifierSnapshot: null },
    ]);
    renderWithProviders(<ApprovalsWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);

    const withIdentifier = await screen.findByRole("link", { name: /Need input on scope/i });
    expect(withIdentifier).toHaveAttribute("href", "/issues/TC-9");

    const withoutIdentifier = screen.getByRole("link", { name: /Should we ship Friday/i });
    expect(withoutIdentifier).toHaveAttribute("href", "/issues/iss-2");
  });

  it("renders a non-navigating question row when both issueId and issueIdentifierSnapshot are null (never /issues/null)", async () => {
    wqApiMock.list.mockResolvedValue([
      { id: "q1", title: "Orphaned question", question: "", issueId: null, issueIdentifierSnapshot: null },
    ]);
    renderWithProviders(<ApprovalsWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);

    expect(await screen.findByText("Orphaned question")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Orphaned question/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /issues\/null/ })).not.toBeInTheDocument();
  });

  it("shows an error empty state (no misleading partial list) when approvals fails but questions resolves", async () => {
    approvalsApiMock.list.mockRejectedValue(new Error("network error"));
    wqApiMock.list.mockResolvedValue([{ id: "q1", title: "Still here", question: "", issueId: "iss-1", issueIdentifierSnapshot: null }]);
    renderWithProviders(<ApprovalsWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);

    expect(await screen.findByText("Couldn't load")).toBeInTheDocument();
    expect(screen.queryByText("Still here")).not.toBeInTheDocument();
  });

  it("shows an error empty state (no misleading partial list) when questions fails but approvals resolves", async () => {
    approvalsApiMock.list.mockResolvedValue([
      { id: "appr-1", companyId: "co-1", type: "hire_agent", status: "pending", payload: {}, createdAt: new Date().toISOString() },
    ]);
    wqApiMock.list.mockRejectedValue(new Error("network error"));
    renderWithProviders(<ApprovalsWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);

    expect(await screen.findByText("Couldn't load")).toBeInTheDocument();
    expect(screen.queryByText(/Hire Agent/i)).not.toBeInTheDocument();
  });

  it("does not render rows as links while editing", async () => {
    approvalsApiMock.list.mockResolvedValue([
      { id: "appr-1", companyId: "co-1", type: "hire_agent", status: "pending", payload: {}, createdAt: new Date().toISOString() },
    ]);
    renderWithProviders(<ApprovalsWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} editing />);

    expect(await screen.findByText(/Hire Agent/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Hire Agent/i })).not.toBeInTheDocument();
  });

  it("caps the merged list at 6 rows with a '+N more' tail for a tall (h=2) tile", async () => {
    approvalsApiMock.list.mockResolvedValue(
      Array.from({ length: 4 }, (_, i) => ({ id: `a${i}`, companyId: "co-1", type: "hire_agent", status: "pending", payload: {}, createdAt: new Date().toISOString() })),
    );
    wqApiMock.list.mockResolvedValue(
      Array.from({ length: 3 }, (_, i) => ({ id: `q${i}`, title: `Question ${i}`, question: "", issueId: `iss-${i}`, issueIdentifierSnapshot: null })),
    );
    renderWithProviders(<ApprovalsWidget companyId="co-1" role="founder" size={{ w: 2, h: 2 }} />);

    // 4 approvals + first 2 questions visible (6 total), "+1 more" tail for the remaining question.
    expect(await screen.findByText("Question 0")).toBeInTheDocument();
    expect(await screen.findByText("Question 1")).toBeInTheDocument();
    expect(screen.queryByText("Question 2")).not.toBeInTheDocument();
    expect(screen.getByText("+1 more")).toBeInTheDocument();
  });

  it("caps the merged list at 2 rows with a '+N more' tail for a short (h=1) tile", async () => {
    approvalsApiMock.list.mockResolvedValue(
      Array.from({ length: 4 }, (_, i) => ({ id: `a${i}`, companyId: "co-1", type: "hire_agent", status: "pending", payload: {}, createdAt: new Date().toISOString() })),
    );
    renderWithProviders(<ApprovalsWidget companyId="co-1" role="founder" size={{ w: 2, h: 1 }} />);

    expect(await screen.findAllByText("Hire Agent")).toHaveLength(2);
    expect(screen.getByText("+2 more")).toBeInTheDocument();
  });

  it("shows no '+N more' tail when the merged list fits inside the current row cap", async () => {
    approvalsApiMock.list.mockResolvedValue([
      { id: "a1", companyId: "co-1", type: "hire_agent", status: "pending", payload: {}, createdAt: new Date().toISOString() },
    ]);
    renderWithProviders(<ApprovalsWidget companyId="co-1" role="founder" size={{ w: 2, h: 1 }} />);

    expect(await screen.findByText("Hire Agent")).toBeInTheDocument();
    expect(screen.queryByText(/more$/)).not.toBeInTheDocument();
  });
});
