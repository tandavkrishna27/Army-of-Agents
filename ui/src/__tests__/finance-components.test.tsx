import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { renderWithProviders, mockCompanyContext, makeCompany } from "./test-utils";
import type {
  BudgetPolicySummary,
  BudgetIncident,
  BudgetOverview,
} from "@armyofagents/shared";
import { BudgetPolicyCard } from "../components/finance/BudgetPolicyCard";
import { BudgetIncidentCard } from "../components/finance/BudgetIncidentCard";
import { BudgetSidebarMarker } from "../components/finance/BudgetSidebarMarker";
import { QuotaBar } from "../components/finance/QuotaBar";
import { ProviderQuotaCard } from "../components/finance/ProviderQuotaCard";
import { FinanceBillerCard } from "../components/finance/FinanceBillerCard";
import { FinanceKindCard } from "../components/finance/FinanceKindCard";
import { FinanceTimelineCard } from "../components/finance/FinanceTimelineCard";
import { AccountingModelCard } from "../components/finance/AccountingModelCard";
import { ClaudeSubscriptionPanel } from "../components/finance/ClaudeSubscriptionPanel";
import { CodexSubscriptionPanel } from "../components/finance/CodexSubscriptionPanel";
import type { SubscriptionRollup } from "../components/finance/ClaudeSubscriptionPanel";
import type { ProviderQuotaWindow } from "../api/quotas";
import type {
  FinanceBillerRow,
  FinanceKindRow,
  FinanceEvent,
} from "../api/finance";
import type { CostByModelRow } from "../api/costs";

const budgetsOverviewMock = vi.fn();
const resolveIncidentMock = vi.fn();

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => mockCompanyContext,
}));

vi.mock("../api/budgets", () => ({
  budgetsApi: {
    overview: (...args: unknown[]) => budgetsOverviewMock(...args),
    upsertPolicy: vi.fn(),
    resolveIncident: (...args: unknown[]) => resolveIncidentMock(...args),
  },
}));

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

describe("BudgetPolicyCard", () => {
  it("renders scope name, amount, and utilization bar", () => {
    const policy = makePolicy({ amountCents: 10_000, observedCents: 2_500, utilizationPercent: 25 });
    renderWithProviders(<BudgetPolicyCard policy={policy} />);
    expect(screen.getByText("Acme Inc")).toBeInTheDocument();
    expect(screen.getByText(/\$100\.00/)).toBeInTheDocument();
    expect(screen.getByText(/25%/)).toBeInTheDocument();
    const bar = screen.getByTestId("budget-policy-utilization-bar");
    expect(bar).toHaveStyle({ width: "25%" });
  });

  it("shows warning status when observed >= warn threshold", () => {
    const policy = makePolicy({ status: "warning", utilizationPercent: 85 });
    renderWithProviders(<BudgetPolicyCard policy={policy} />);
    expect(screen.getByText(/warning/i)).toBeInTheDocument();
  });

  it("shows hard-stop status when observed >= 100%", () => {
    const policy = makePolicy({
      status: "hard_stop",
      utilizationPercent: 110,
      observedCents: 11_000,
    });
    renderWithProviders(<BudgetPolicyCard policy={policy} />);
    expect(screen.getByText(/hard stop/i)).toBeInTheDocument();
  });

  it("fires onEdit when edit button clicked", () => {
    const onEdit = vi.fn();
    const policy = makePolicy();
    renderWithProviders(<BudgetPolicyCard policy={policy} onEdit={onEdit} />);
    fireEvent.click(screen.getByRole("button", { name: /edit/i }));
    expect(onEdit).toHaveBeenCalledWith(policy);
  });

  it("visually deemphasizes inactive policies", () => {
    const policy = makePolicy({ isActive: false });
    const { container } = renderWithProviders(<BudgetPolicyCard policy={policy} />);
    const root = container.querySelector("[data-testid=budget-policy-card]");
    expect(root?.className).toMatch(/opacity/);
  });
});

describe("BudgetIncidentCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompanyContext.selectedCompanyId = "comp-1";
    mockCompanyContext.selectedCompany = makeCompany();
  });

  it("renders incident scope name, observed vs limit, and window start", () => {
    const incident = makeIncident();
    renderWithProviders(<BudgetIncidentCard incident={incident} />);
    expect(screen.getByText("Acme Inc")).toBeInTheDocument();
    expect(screen.getByText(/\$110\.00/)).toBeInTheDocument();
    expect(screen.getByText(/\$100\.00/)).toBeInTheDocument();
  });

  it("fires raise-and-resume with the new amount", async () => {
    resolveIncidentMock.mockResolvedValue({ ok: true });
    const incident = makeIncident();
    renderWithProviders(<BudgetIncidentCard incident={incident} />);
    const input = screen.getByLabelText(/new budget/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "150.00" } });
    fireEvent.click(screen.getByRole("button", { name: /raise.*resume/i }));
    await waitFor(() => {
      expect(resolveIncidentMock).toHaveBeenCalledWith("comp-1", "inc-1", {
        action: "raise_and_resume",
        newAmountCents: 15_000,
      });
    });
  });

  it("fires dismiss action", async () => {
    resolveIncidentMock.mockResolvedValue({ ok: true });
    const incident = makeIncident();
    renderWithProviders(<BudgetIncidentCard incident={incident} />);
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    await waitFor(() => {
      expect(resolveIncidentMock).toHaveBeenCalledWith("comp-1", "inc-1", { action: "dismiss" });
    });
  });
});

describe("BudgetSidebarMarker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompanyContext.selectedCompanyId = "comp-1";
    mockCompanyContext.selectedCompany = makeCompany();
  });

  it("renders nothing when no policies are in warn/hard state", async () => {
    budgetsOverviewMock.mockResolvedValue(
      makeOverview({
        policies: [makePolicy({ status: "ok", utilizationPercent: 25 })],
      }),
    );
    const { container } = renderWithProviders(<BudgetSidebarMarker />);
    await waitFor(() => {
      expect(budgetsOverviewMock).toHaveBeenCalled();
    });
    expect(container.querySelector("[data-testid=budget-sidebar-marker]")).toBeNull();
  });

  it("renders warning chip when at least one policy is in warning state", async () => {
    budgetsOverviewMock.mockResolvedValue(
      makeOverview({
        policies: [
          makePolicy({ status: "ok", utilizationPercent: 25 }),
          makePolicy({ id: "pol-2", status: "warning", utilizationPercent: 85 }),
        ],
      }),
    );
    renderWithProviders(<BudgetSidebarMarker />);
    const marker = await screen.findByTestId("budget-sidebar-marker");
    expect(marker).toHaveAttribute("data-tone", "warning");
    expect(marker.textContent).toMatch(/85/);
  });

  it("renders hard-stop chip when at least one policy is in hard_stop state", async () => {
    budgetsOverviewMock.mockResolvedValue(
      makeOverview({
        policies: [
          makePolicy({ status: "warning", utilizationPercent: 85 }),
          makePolicy({ id: "pol-2", status: "hard_stop", utilizationPercent: 110 }),
        ],
      }),
    );
    renderWithProviders(<BudgetSidebarMarker />);
    const marker = await screen.findByTestId("budget-sidebar-marker");
    expect(marker).toHaveAttribute("data-tone", "hard");
  });
});

describe("QuotaBar", () => {
  it("renders label, valueLabel, and percentage", () => {
    renderWithProviders(
      <QuotaBar label="5h window" used={50} limit={100} valueLabel="50 / 100 msgs" />,
    );
    expect(screen.getByText("5h window")).toBeInTheDocument();
    expect(screen.getByText("50 / 100 msgs")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
  });

  it("derives default value label from used/limit when not provided", () => {
    renderWithProviders(<QuotaBar label="24h" used={3} limit={10} />);
    expect(screen.getByText("3 / 10")).toBeInTheDocument();
    expect(screen.getByText("30%")).toBeInTheDocument();
  });

  it("uses healthy tone when percent < 70", () => {
    renderWithProviders(<QuotaBar label="5h" used={50} limit={100} />);
    const fill = screen.getByTestId("quota-bar-fill");
    expect(fill).toHaveAttribute("data-tone", "healthy");
    expect(fill.className).toMatch(/green/);
    expect(fill).toHaveStyle({ width: "50%" });
  });

  it("uses warn tone when percent >= 70 and < 90", () => {
    renderWithProviders(<QuotaBar label="5h" used={80} limit={100} />);
    const fill = screen.getByTestId("quota-bar-fill");
    expect(fill).toHaveAttribute("data-tone", "warn");
    expect(fill.className).toMatch(/amber|yellow/);
  });

  it("uses hard tone when percent >= 90", () => {
    renderWithProviders(<QuotaBar label="5h" used={95} limit={100} />);
    const fill = screen.getByTestId("quota-bar-fill");
    expect(fill).toHaveAttribute("data-tone", "hard");
    expect(fill.className).toMatch(/red/);
  });

  it("visually clamps fill width to 100% when over-limit", () => {
    renderWithProviders(<QuotaBar label="5h" used={150} limit={100} />);
    const fill = screen.getByTestId("quota-bar-fill");
    expect(fill).toHaveStyle({ width: "100%" });
    expect(fill).toHaveAttribute("data-tone", "hard");
    expect(screen.getByText("150%")).toBeInTheDocument();
  });

  it("shows 0% without crashing when limit is 0", () => {
    renderWithProviders(<QuotaBar label="5h" used={0} limit={0} />);
    expect(screen.getByText("0%")).toBeInTheDocument();
    const fill = screen.getByTestId("quota-bar-fill");
    expect(fill).toHaveStyle({ width: "0%" });
  });
});

describe("ProviderQuotaCard", () => {
  function makeWindow(overrides: Partial<ProviderQuotaWindow> = {}): ProviderQuotaWindow {
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

  it("renders provider name capitalized and one bar per window", () => {
    renderWithProviders(
      <ProviderQuotaCard
        provider="anthropic"
        windows={[
          makeWindow({ windowKind: "5h", label: "5h" }),
          makeWindow({ id: "qw-2", windowKind: "24h", label: "24h", usedPercent: 85 }),
          makeWindow({ id: "qw-3", windowKind: "7d", label: "7d", usedPercent: 12 }),
        ]}
        lastUpdatedAt={new Date().toISOString()}
      />,
    );
    expect(screen.getByText(/anthropic/i)).toBeInTheDocument();
    expect(screen.getAllByTestId("quota-bar-fill")).toHaveLength(3);
  });

  it("shows relative last-updated time", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    renderWithProviders(
      <ProviderQuotaCard
        provider="anthropic"
        windows={[makeWindow()]}
        lastUpdatedAt={fiveMinAgo}
      />,
    );
    expect(screen.getByText(/5m ago/i)).toBeInTheDocument();
  });

  it("marks data as stale when older than 10 minutes", () => {
    const stale = new Date(Date.now() - 15 * 60_000).toISOString();
    renderWithProviders(
      <ProviderQuotaCard
        provider="anthropic"
        windows={[makeWindow()]}
        lastUpdatedAt={stale}
      />,
    );
    const freshness = screen.getByTestId("quota-freshness");
    expect(freshness).toHaveAttribute("data-stale", "true");
  });

  it("fires onRefresh when Refresh button clicked", () => {
    const onRefresh = vi.fn();
    renderWithProviders(
      <ProviderQuotaCard
        provider="anthropic"
        windows={[makeWindow()]}
        lastUpdatedAt={new Date().toISOString()}
        onRefresh={onRefresh}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("disables Refresh button while isRefreshing", () => {
    renderWithProviders(
      <ProviderQuotaCard
        provider="anthropic"
        windows={[makeWindow()]}
        lastUpdatedAt={new Date().toISOString()}
        onRefresh={() => {}}
        isRefreshing
      />,
    );
    expect(screen.getByRole("button", { name: /refresh/i })).toBeDisabled();
  });

  it("renders empty state when no windows and never refreshed", () => {
    renderWithProviders(
      <ProviderQuotaCard provider="anthropic" windows={[]} lastUpdatedAt={null} />,
    );
    expect(screen.getByText(/no quota data/i)).toBeInTheDocument();
  });
});

describe("FinanceBillerCard", () => {
  function makeBillerRow(overrides: Partial<FinanceBillerRow> = {}): FinanceBillerRow {
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

  it("renders biller name with net amount and counts", () => {
    renderWithProviders(<FinanceBillerCard row={makeBillerRow()} />);
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(screen.getByText("$40.00")).toBeInTheDocument();
    expect(screen.getByText(/4 events · 2 kinds/)).toBeInTheDocument();
  });

  it("shows debit, credit, and estimated breakdown", () => {
    renderWithProviders(
      <FinanceBillerCard
        row={makeBillerRow({ debitCents: 5_000, creditCents: 1_000, estimatedDebitCents: 750 })}
      />,
    );
    expect(screen.getByText("$50.00")).toBeInTheDocument();
    expect(screen.getByText("$10.00")).toBeInTheDocument();
    expect(screen.getByText("$7.50")).toBeInTheDocument();
  });

  it("falls back to 'Unknown' when biller is null", () => {
    renderWithProviders(<FinanceBillerCard row={makeBillerRow({ biller: null })} />);
    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });
});

describe("FinanceKindCard", () => {
  function makeKindRow(overrides: Partial<FinanceKindRow> = {}): FinanceKindRow {
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

  it("shows empty message when no rows", () => {
    renderWithProviders(<FinanceKindCard rows={[]} />);
    expect(screen.getByText(/no finance events in this period/i)).toBeInTheDocument();
  });

  it("renders each row with humanized kind label and net", () => {
    renderWithProviders(
      <FinanceKindCard
        rows={[
          makeKindRow({ eventKind: "top_up", netCents: 10_000 }),
          makeKindRow({ eventKind: "refund", netCents: -500, creditCents: 500, debitCents: 0 }),
        ]}
      />,
    );
    expect(screen.getByText("Top-up")).toBeInTheDocument();
    expect(screen.getByText("Refund")).toBeInTheDocument();
    expect(screen.getByText("$100.00")).toBeInTheDocument();
  });
});

describe("FinanceTimelineCard", () => {
  function makeEvent(overrides: Partial<FinanceEvent> = {}): FinanceEvent {
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

  it("shows empty message when no events", () => {
    renderWithProviders(<FinanceTimelineCard rows={[]} />);
    expect(screen.getByText(/no financial events in this period/i)).toBeInTheDocument();
  });

  it("renders one row per event with kind, direction, amount, and description", () => {
    renderWithProviders(
      <FinanceTimelineCard
        rows={[
          makeEvent({ id: "fe-1", description: "Monthly credit top-up" }),
          makeEvent({
            id: "fe-2",
            eventKind: "fee",
            direction: "debit",
            amountCents: 500,
            description: "Processing fee",
            estimated: true,
          }),
        ]}
      />,
    );
    expect(screen.getAllByTestId("finance-timeline-event")).toHaveLength(2);
    expect(screen.getByText("Monthly credit top-up")).toBeInTheDocument();
    expect(screen.getByText("Processing fee")).toBeInTheDocument();
    expect(screen.getByText(/estimated/i)).toBeInTheDocument();
  });

  it("honors custom empty message", () => {
    renderWithProviders(
      <FinanceTimelineCard rows={[]} emptyMessage="Nothing here yet." />,
    );
    expect(screen.getByText("Nothing here yet.")).toBeInTheDocument();
  });
});

describe("AccountingModelCard", () => {
  function makeModelRow(overrides: Partial<CostByModelRow> = {}): CostByModelRow {
    return {
      model: "claude-3-5-sonnet",
      totalCostCents: 1_200,
      totalInputTokens: 50_000,
      totalCachedInputTokens: 10_000,
      totalOutputTokens: 5_000,
      eventCount: 3,
      ...overrides,
    };
  }

  it("shows empty state when no rows", () => {
    renderWithProviders(<AccountingModelCard rows={[]} />);
    expect(screen.getByText(/no cost events in this period/i)).toBeInTheDocument();
  });

  it("sorts by cost desc and marks the top-spend model", () => {
    renderWithProviders(
      <AccountingModelCard
        rows={[
          makeModelRow({ model: "gpt-4o", totalCostCents: 500 }),
          makeModelRow({ model: "claude-3-5-sonnet", totalCostCents: 2_500 }),
          makeModelRow({ model: "gemini-pro", totalCostCents: 100 }),
        ]}
      />,
    );
    const rowEls = screen.getAllByTestId("accounting-model-row");
    expect(rowEls[0].textContent).toMatch(/claude-3-5-sonnet/);
    expect(rowEls[0]).toHaveAttribute("data-top", "true");
    expect(rowEls[1]).toHaveAttribute("data-top", "false");
    expect(screen.getByText(/top spend/i)).toBeInTheDocument();
  });

  it("renders token counts including cached when nonzero", () => {
    renderWithProviders(
      <AccountingModelCard rows={[makeModelRow({ totalCachedInputTokens: 12_000 })]} />,
    );
    expect(screen.getByText(/12\.0k cached/)).toBeInTheDocument();
  });
});

describe("ClaudeSubscriptionPanel", () => {
  const rollup: SubscriptionRollup = {
    spendCents: 3_500,
    eventCount: 12,
    inputTokens: 100_000,
    cachedInputTokens: 25_000,
    outputTokens: 15_000,
  };

  it("renders header label, title, and spend amount", () => {
    renderWithProviders(<ClaudeSubscriptionPanel rollup={rollup} />);
    expect(screen.getByText(/anthropic subscription/i)).toBeInTheDocument();
    expect(screen.getByText(/claude pro \/ max/i)).toBeInTheDocument();
    expect(screen.getByText("$35.00")).toBeInTheDocument();
  });

  it("renders token breakdown grid when activity exists", () => {
    renderWithProviders(<ClaudeSubscriptionPanel rollup={rollup} />);
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("100.0k")).toBeInTheDocument();
    expect(screen.getByText("15.0k")).toBeInTheDocument();
  });

  it("shows no-activity message when rollup is null or zero", () => {
    renderWithProviders(<ClaudeSubscriptionPanel rollup={null} />);
    expect(screen.getByText(/no claude subscription activity/i)).toBeInTheDocument();
    expect(screen.getByText("$0.00")).toBeInTheDocument();
  });

  it("shows settings link to configure subscription limits", () => {
    renderWithProviders(<ClaudeSubscriptionPanel rollup={rollup} settingsHref="/acme/settings" />);
    const link = screen.getByRole("link", { name: /configure subscription limits/i });
    expect(link).toHaveAttribute("href", "/acme/settings");
  });
});

describe("CodexSubscriptionPanel", () => {
  const rollup: SubscriptionRollup = {
    spendCents: 1_800,
    eventCount: 6,
    inputTokens: 40_000,
    cachedInputTokens: 0,
    outputTokens: 8_000,
  };

  it("renders Codex title and spend amount", () => {
    renderWithProviders(<CodexSubscriptionPanel rollup={rollup} />);
    expect(screen.getByText(/openai subscription/i)).toBeInTheDocument();
    expect(screen.getByText(/codex plan/i)).toBeInTheDocument();
    expect(screen.getByText("$18.00")).toBeInTheDocument();
  });

  it("shows no-activity message when rollup is null", () => {
    renderWithProviders(<CodexSubscriptionPanel rollup={null} />);
    expect(screen.getByText(/no codex subscription activity/i)).toBeInTheDocument();
  });
});
