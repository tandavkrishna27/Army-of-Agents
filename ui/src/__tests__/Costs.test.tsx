import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import {
  renderWithProviders,
  mockBreadcrumbContext,
  mockCompanyContext,
  makeCompany,
} from "./test-utils";
import { Costs } from "../pages/Costs";

const costsSummaryMock = vi.fn();
const budgetsOverviewMock = vi.fn();
const quotasListMock = vi.fn();
const financeSummaryMock = vi.fn();

vi.mock("@/lib/router", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    Link: actual.Link,
  };
});

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => mockCompanyContext,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => mockBreadcrumbContext,
}));

vi.mock("../api/costs", () => ({
  costsApi: {
    summary: (...args: unknown[]) => costsSummaryMock(...args),
    byAgent: vi.fn().mockResolvedValue([]),
    byProject: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../api/budgets", () => ({
  budgetsApi: {
    overview: (...args: unknown[]) => budgetsOverviewMock(...args),
    upsertPolicy: vi.fn(),
    resolveIncident: vi.fn(),
  },
}));

vi.mock("../api/quotas", () => ({
  quotasApi: {
    list: (...args: unknown[]) => quotasListMock(...args),
    refresh: vi.fn(),
  },
}));

vi.mock("../api/finance", () => ({
  financeApi: {
    summary: (...args: unknown[]) => financeSummaryMock(...args),
    byBiller: vi.fn().mockResolvedValue([]),
    byKind: vi.fn().mockResolvedValue([]),
    list: vi.fn().mockResolvedValue([]),
    createEvent: vi.fn(),
  },
}));

function loadedSummary() {
  return {
    companyId: "comp-1",
    spendCents: 1234,
    budgetCents: 10_000,
    utilizationPercent: 12,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    runCount: 0,
    apiRunCount: 0,
    subscriptionRunCount: 0,
    subscriptionInputTokens: 0,
    subscriptionOutputTokens: 0,
  };
}

describe("Costs page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompanyContext.selectedCompanyId = "comp-1";
    mockCompanyContext.selectedCompany = makeCompany();
    mockCompanyContext.companies = [makeCompany()];
    costsSummaryMock.mockResolvedValue(loadedSummary());
    budgetsOverviewMock.mockResolvedValue({ policies: [], openIncidents: [] });
    quotasListMock.mockResolvedValue([]);
    financeSummaryMock.mockResolvedValue({
      companyId: "comp-1",
      debitCents: 0,
      creditCents: 0,
      netCents: 0,
      estimatedDebitCents: 0,
      eventCount: 0,
    });
  });

  it("renders the Budget heading", async () => {
    renderWithProviders(<Costs />);
    expect(await screen.findByRole("heading", { name: /^Budget\.?$/ })).toBeInTheDocument();
  });

  it("calls costsApi.summary on mount", async () => {
    renderWithProviders(<Costs />);
    await waitFor(() => {
      expect(costsSummaryMock).toHaveBeenCalled();
    });
    expect(costsSummaryMock.mock.calls[0]![0]).toBe("comp-1");
  });

  it("renders the summary card when data loads", async () => {
    renderWithProviders(<Costs />);
    expect(await screen.findByText(/\$12\.34/)).toBeInTheDocument();
  });

  it("shows the four section placeholders", async () => {
    renderWithProviders(<Costs />);
    expect(
      await screen.findByRole("heading", { name: "Breakdown" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Budgets" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Quotas" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Ledger" })).toBeInTheDocument();
  });

  it("shows empty state when no company is selected", () => {
    mockCompanyContext.selectedCompanyId = null;
    mockCompanyContext.selectedCompany = null;
    mockCompanyContext.companies = [];
    renderWithProviders(<Costs />);
    expect(
      screen.getByText(/select a company to view budget/i),
    ).toBeInTheDocument();
  });
});
