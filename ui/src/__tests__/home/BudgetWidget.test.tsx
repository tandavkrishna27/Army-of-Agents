import { screen } from "@testing-library/react";
import { renderWithProviders, mockCompanyContext } from "../test-utils";
import { BudgetWidget } from "../../components/home/widgets/BudgetWidget";

const { dashboardApiMock } = vi.hoisted(() => ({ dashboardApiMock: { summary: vi.fn() } }));
vi.mock("../../context/CompanyContext", () => ({ useCompany: () => mockCompanyContext }));
vi.mock("../../api/dashboard", () => ({ dashboardApi: dashboardApiMock, homeApi: { summary: vi.fn() } }));

describe("BudgetWidget", () => {
  beforeEach(() => {
    dashboardApiMock.summary.mockResolvedValue({ costs: { monthSpendCents: 41200, monthBudgetCents: 200000, monthUtilizationPercent: 21 }, pendingApprovals: 0 });
  });
  it("renders month spend vs budget", async () => {
    renderWithProviders(<BudgetWidget companyId="co-1" role="founder" size={{ w: 1, h: 1 }} />);
    expect(await screen.findByText(/\$412/)).toBeInTheDocument();
    expect(screen.getByText(/of \$2,000/)).toBeInTheDocument();
  });

  it("shows the shell + loading placeholder while budget data is missing (still loading)", () => {
    dashboardApiMock.summary.mockReturnValue(new Promise(() => {})); // never resolves
    renderWithProviders(<BudgetWidget companyId="co-1" role="founder" size={{ w: 1, h: 1 }} />);
    expect(screen.getByText("Budget")).toBeInTheDocument();
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
  });

  it("shows an error empty state (no throw) when the summary query errors", async () => {
    dashboardApiMock.summary.mockRejectedValue(new Error("network error"));
    renderWithProviders(<BudgetWidget companyId="co-1" role="founder" size={{ w: 1, h: 1 }} />);
    expect(await screen.findByText("Couldn't load")).toBeInTheDocument();
  });

  it("renders $0 of $0 (not null) when budget data resolves to all-zero costs", async () => {
    dashboardApiMock.summary.mockResolvedValue({ costs: { monthSpendCents: 0, monthBudgetCents: 0, monthUtilizationPercent: 0 }, pendingApprovals: 0 });
    renderWithProviders(<BudgetWidget companyId="co-1" role="founder" size={{ w: 1, h: 1 }} />);
    // The shell (title) renders immediately regardless of loading state now,
    // so wait on the actual content ("$0") rather than the title as the
    // "data has loaded" proxy.
    expect(await screen.findByText("$0")).toBeInTheDocument();
    expect(screen.getByText("Budget")).toBeInTheDocument();
    expect(screen.getByText(/of \$0 this month/)).toBeInTheDocument();
  });

  it("the tile body is a link to /budget when not editing", async () => {
    renderWithProviders(<BudgetWidget companyId="co-1" role="founder" size={{ w: 1, h: 1 }} />);
    const rowLink = await screen.findByRole("link", { name: /\$412/ });
    expect(rowLink).toHaveAttribute("href", "/budget");
  });

  // Regression: the row was a hardcoded <Link>, ignoring `editing` — a click
  // during arrange mode navigated away instead of letting drag/select work,
  // unlike every other widget (which use WidgetRowLink to swap to a plain
  // div while editing).
  it("does not render any link while editing, so a click during arrange doesn't navigate", async () => {
    renderWithProviders(<BudgetWidget companyId="co-1" role="founder" size={{ w: 1, h: 1 }} editing />);
    expect(await screen.findByText(/\$412/)).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
