import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import type {
  BudgetPolicySummary,
  BudgetIncident,
  BudgetOverview,
} from "@armyofagents/shared";
import {
  renderWithProviders,
  mockBreadcrumbContext,
  mockCompanyContext,
  makeCompany,
} from "./test-utils";
import { Costs } from "../pages/Costs";
import type {
  CostSummary,
  CostByModelRow,
  CostByBillerRow,
} from "../api/costs";
import type {
  FinanceSummary,
  FinanceBillerRow,
  FinanceKindRow,
  FinanceEvent,
} from "../api/finance";
import type { ProviderQuotaWindow } from "../api/quotas";

// ─── Mock setup ────────────────────────────────────────────────────────
const costsSummaryMock = vi.fn();
const costsByModelMock = vi.fn();
const costsByBillerMock = vi.fn();
const budgetsOverviewMock = vi.fn();
const resolveIncidentMock = vi.fn();
const quotasListMock = vi.fn();
const quotasRefreshMock = vi.fn();
const financeSummaryMock = vi.fn();
const financeByBillerMock = vi.fn();
const financeByKindMock = vi.fn();
const financeListMock = vi.fn();

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => mockCompanyContext,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => mockBreadcrumbContext,
}));

vi.mock("../api/costs", () => ({
  costsApi: {
    summary: (...args: unknown[]) => costsSummaryMock(...args),
    byModel: (...args: unknown[]) => costsByModelMock(...args),
    byBiller: (...args: unknown[]) => costsByBillerMock(...args),
    byAgent: vi.fn().mockResolvedValue([]),
    byProject: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../api/budgets", () => ({
  budgetsApi: {
    overview: (...args: unknown[]) => budgetsOverviewMock(...args),
    upsertPolicy: vi.fn(),
    resolveIncident: (...args: unknown[]) => resolveIncidentMock(...args),
  },
}));

vi.mock("../api/quotas", () => ({
  quotasApi: {
    list: (...args: unknown[]) => quotasListMock(...args),
    refresh: (...args: unknown[]) => quotasRefreshMock(...args),
  },
}));

vi.mock("../api/finance", () => ({
  financeApi: {
    summary: (...args: unknown[]) => financeSummaryMock(...args),
    byBiller: (...args: unknown[]) => financeByBillerMock(...args),
    byKind: (...args: unknown[]) => financeByKindMock(...args),
    list: (...args: unknown[]) => financeListMock(...args),
    createEvent: vi.fn(),
  },
}));

// ─── Fixtures ──────────────────────────────────────────────────────────
function loadedSummary(): CostSummary {
  return {
    companyId: "comp-1",
    spendCents: 1234,
    budgetCents: 10_000,
    utilizationPercent: 12,
    inputTokens: 50_000,
    outputTokens: 10_000,
    cachedInputTokens: 5_000,
    runCount: 4,
    apiRunCount: 3,
    subscriptionRunCount: 1,
    subscriptionInputTokens: 20_000,
    subscriptionOutputTokens: 4_000,
  };
}

function makePolicy(overrides: Partial<BudgetPolicySummary> = {}): BudgetPolicySummary {
  return {
    id: "pol-1",
    companyId: "comp-1",
    scopeType: "company",
    scopeId: "comp-1",
    scopeName: "Acme Inc",
    metric: "cost_usd",
    windowKind: "month_utc",
    amountCents: 10_000,
    warnPercent: 80,
    hardStopEnabled: true,
    isActive: true,
    observedCents: 2_500,
    utilizationPercent: 25,
    status: "ok",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeIncident(overrides: Partial<BudgetIncident> = {}): BudgetIncident {
  return {
    id: "inc-1",
    companyId: "comp-1",
    policyId: "pol-1",
    scopeType: "company",
    scopeId: "comp-1",
    scopeName: "Acme Inc",
    windowStart: new Date("2026-04-01T00:00:00Z"),
    windowEnd: new Date("2026-05-01T00:00:00Z"),
    thresholdType: "hard_stop",
    amountLimitCents: 10_000,
    amountObservedCents: 11_000,
    status: "open",
    approvalId: null,
    resolvedAt: null,
    createdAt: new Date("2026-04-15T12:00:00Z"),
    ...overrides,
  };
}

function makeOverview(overrides: Partial<BudgetOverview> = {}): BudgetOverview {
  return {
    policies: [],
    openIncidents: [],
    ...overrides,
  };
}

function makeModelRow(overrides: Partial<CostByModelRow> = {}): CostByModelRow {
  return {
    model: "claude-3-5-sonnet",
    totalCostCents: 2_500,
    totalInputTokens: 50_000,
    totalCachedInputTokens: 10_000,
    totalOutputTokens: 5_000,
    eventCount: 3,
    ...overrides,
  };
}

function makeBillerCostRow(overrides: Partial<CostByBillerRow> = {}): CostByBillerRow {
  return {
    biller: "claude_local",
    totalCostCents: 3_500,
    totalInputTokens: 100_000,
    totalCachedInputTokens: 25_000,
    totalOutputTokens: 15_000,
    eventCount: 12,
    ...overrides,
  };
}

function makeQuotaWindow(overrides: Partial<ProviderQuotaWindow> = {}): ProviderQuotaWindow {
  return {
    id: "qw-1",
    companyId: "comp-1",
    provider: "anthropic",
    model: null,
    windowKind: "5h",
    label: "5h",
    limitValue: 100,
    usedValue: 30,
    usedPercent: 30,
    valueLabel: "30 / 100 msgs",
    resetAt: null,
    lastUpdatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeFinanceBillerRow(overrides: Partial<FinanceBillerRow> = {}): FinanceBillerRow {
  return {
    biller: "anthropic",
    debitCents: 5_000,
    creditCents: 1_000,
    estimatedDebitCents: 0,
    eventCount: 4,
    kindCount: 2,
    netCents: 4_000,
    ...overrides,
  };
}

function makeFinanceKindRow(overrides: Partial<FinanceKindRow> = {}): FinanceKindRow {
  return {
    eventKind: "top_up",
    debitCents: 10_000,
    creditCents: 0,
    estimatedDebitCents: 0,
    eventCount: 1,
    billerCount: 1,
    netCents: 10_000,
    ...overrides,
  };
}

function makeFinanceEvent(overrides: Partial<FinanceEvent> = {}): FinanceEvent {
  return {
    id: "fe-1",
    companyId: "comp-1",
    agentId: null,
    issueId: null,
    projectId: null,
    goalId: null,
    heartbeatRunId: null,
    costEventId: null,
    billingCode: null,
    description: "Monthly credit top-up",
    eventKind: "top_up",
    direction: "credit",
    biller: "anthropic",
    provider: null,
    executionAdapterType: null,
    pricingTier: null,
    region: null,
    model: null,
    quantity: null,
    unit: null,
    amountCents: 10_000,
    currency: "USD",
    estimated: false,
    externalInvoiceId: null,
    metadataJson: null,
    occurredAt: new Date("2026-04-20T12:00:00Z").toISOString(),
    createdAt: new Date("2026-04-20T12:00:00Z").toISOString(),
    ...overrides,
  };
}

function emptyFinanceSummary(): FinanceSummary {
  return {
    companyId: "comp-1",
    debitCents: 0,
    creditCents: 0,
    netCents: 0,
    estimatedDebitCents: 0,
    eventCount: 0,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────
describe("Costs page — integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompanyContext.selectedCompanyId = "comp-1";
    mockCompanyContext.selectedCompany = makeCompany();
    mockCompanyContext.companies = [makeCompany()];

    // Default: loaded summary with populated downstream data so every section renders.
    costsSummaryMock.mockResolvedValue(loadedSummary());
    costsByModelMock.mockResolvedValue([makeModelRow()]);
    costsByBillerMock.mockResolvedValue([makeBillerCostRow()]);
    budgetsOverviewMock.mockResolvedValue(
      makeOverview({ policies: [makePolicy()], openIncidents: [] }),
    );
    quotasListMock.mockResolvedValue([makeQuotaWindow()]);
    financeSummaryMock.mockResolvedValue(emptyFinanceSummary());
    financeByBillerMock.mockResolvedValue([makeFinanceBillerRow()]);
    financeByKindMock.mockResolvedValue([makeFinanceKindRow()]);
    financeListMock.mockResolvedValue([makeFinanceEvent()]);
  });

  it("composes all four sections when every API returns populated data", async () => {
    renderWithProviders(<Costs />);

    // Summary card
    expect(await screen.findByText(/\$12\.34/)).toBeInTheDocument();

    // Breakdown section (renders models + subscription panels)
    await screen.findByRole("heading", { name: "Breakdown" });
    expect(screen.getAllByTestId("accounting-model-row").length).toBeGreaterThan(0);
    expect(screen.getByText(/anthropic subscription/i)).toBeInTheDocument();

    // Budgets section (populated with 1 policy)
    expect(screen.getByRole("heading", { name: "Budgets" })).toBeInTheDocument();
    expect(screen.getByTestId("budget-policy-card")).toBeInTheDocument();

    // Quotas section (populated with 1 window)
    expect(screen.getByRole("heading", { name: "Quotas" })).toBeInTheDocument();
    expect(screen.getAllByTestId("quota-bar-fill").length).toBeGreaterThan(0);

    // Ledger section (populated)
    expect(screen.getByRole("heading", { name: "Ledger" })).toBeInTheDocument();
    expect(screen.getAllByTestId("finance-timeline-event").length).toBeGreaterThan(0);
  });

  it("falls back to placeholders when downstream data is empty", async () => {
    costsByModelMock.mockResolvedValue([]);
    costsByBillerMock.mockResolvedValue([]);
    budgetsOverviewMock.mockResolvedValue(makeOverview());
    quotasListMock.mockResolvedValue([]);
    financeByBillerMock.mockResolvedValue([]);
    financeByKindMock.mockResolvedValue([]);
    financeListMock.mockResolvedValue([]);

    renderWithProviders(<Costs />);

    // Page still shows summary from costsApi.summary
    expect(await screen.findByText(/\$12\.34/)).toBeInTheDocument();

    // All four sections fall back to placeholder text
    await waitFor(() => {
      expect(screen.getByText(/per-model spend and subscription utilization/i)).toBeInTheDocument();
      expect(screen.getByText(/no budget policies configured yet/i)).toBeInTheDocument();
      expect(screen.getByText(/provider rate-limit windows will appear/i)).toBeInTheDocument();
      expect(screen.getByText(/finance events by biller, by kind/i)).toBeInTheDocument();
    });
  });

  it("re-requests downstream data when a different date range is picked", async () => {
    renderWithProviders(<Costs />);

    await waitFor(() => {
      expect(costsSummaryMock).toHaveBeenCalled();
    });
    const summaryCallsBefore = costsSummaryMock.mock.calls.length;
    const byModelCallsBefore = costsByModelMock.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: /last 7 days/i }));

    // Switching presets changes the range → react-query refetches with new key.
    await waitFor(() => {
      expect(costsSummaryMock.mock.calls.length).toBeGreaterThan(summaryCallsBefore);
      expect(costsByModelMock.mock.calls.length).toBeGreaterThan(byModelCallsBefore);
    });
  });

  it("drives a budget incident resolution end-to-end through the Budgets section", async () => {
    budgetsOverviewMock.mockResolvedValue(
      makeOverview({
        policies: [makePolicy({ status: "hard_stop", utilizationPercent: 110 })],
        openIncidents: [makeIncident()],
      }),
    );
    resolveIncidentMock.mockResolvedValue({ ok: true });

    renderWithProviders(<Costs />);

    // Incident card renders within the Budgets section
    await screen.findByRole("heading", { name: "Budgets" });
    const input = (await screen.findByLabelText(/new budget/i)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "150.00" } });
    fireEvent.click(screen.getByRole("button", { name: /raise.*resume/i }));

    await waitFor(() => {
      expect(resolveIncidentMock).toHaveBeenCalledWith("comp-1", "inc-1", {
        action: "raise_and_resume",
        newAmountCents: 15_000,
      });
    });
  });
});
