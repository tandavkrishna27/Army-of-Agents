import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DollarSign, Plus } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { costsApi, type CostByBillerRow } from "../api/costs";
import { budgetsApi } from "../api/budgets";
import { quotasApi, type ProviderQuotaWindow } from "../api/quotas";
import { financeApi } from "../api/finance";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "../components/EmptyState";
import { BudgetPolicyCard } from "../components/finance/BudgetPolicyCard";
import { BudgetIncidentCard } from "../components/finance/BudgetIncidentCard";
import { CreateBudgetPolicyDialog } from "../components/finance/CreateBudgetPolicyDialog";
import { ProviderQuotaCard } from "../components/finance/ProviderQuotaCard";
import { FinanceBillerCard } from "../components/finance/FinanceBillerCard";
import { FinanceKindCard } from "../components/finance/FinanceKindCard";
import { FinanceTimelineCard } from "../components/finance/FinanceTimelineCard";
import { AccountingModelCard } from "../components/finance/AccountingModelCard";
import {
  ClaudeSubscriptionPanel,
  type SubscriptionRollup,
} from "../components/finance/ClaudeSubscriptionPanel";
import { CodexSubscriptionPanel } from "../components/finance/CodexSubscriptionPanel";
import { formatCents } from "../lib/utils";

// ─── Date range helpers ────────────────────────────────────────────────
type DatePreset = "mtd" | "7d" | "30d" | "ytd" | "all" | "custom";

const PRESET_LABELS: Record<DatePreset, string> = {
  mtd: "Month to Date",
  "7d": "Last 7 Days",
  "30d": "Last 30 Days",
  ytd: "Year to Date",
  all: "All Time",
  custom: "Custom",
};

function computeRange(preset: DatePreset): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString();
  switch (preset) {
    case "mtd": {
      const d = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: d.toISOString(), to };
    }
    case "7d":
      return { from: new Date(now.getTime() - 7 * 86_400_000).toISOString(), to };
    case "30d":
      return { from: new Date(now.getTime() - 30 * 86_400_000).toISOString(), to };
    case "ytd":
      return { from: new Date(now.getFullYear(), 0, 1).toISOString(), to };
    case "all":
    case "custom":
      return { from: "", to: "" };
  }
}

// ─── Section placeholder ───────────────────────────────────────────────
interface SectionPlaceholderProps {
  title: string;
  description: string;
}

function SectionPlaceholder({ title, description }: SectionPlaceholderProps) {
  return (
    <Card>
      <CardContent className="p-4 space-y-1.5">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────
export function Costs() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Budget" }]);
  }, [setBreadcrumbs]);

  const [preset, setPreset] = useState<DatePreset>("mtd");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [newPolicyOpen, setNewPolicyOpen] = useState(false);

  const { from, to } = useMemo(() => {
    if (preset === "custom") {
      return {
        from: customFrom ? new Date(customFrom).toISOString() : "",
        to: customTo ? new Date(customTo + "T23:59:59.999Z").toISOString() : "",
      };
    }
    return computeRange(preset);
  }, [preset, customFrom, customTo]);

  const costsSummaryQuery = useQuery({
    queryKey: queryKeys.costs(selectedCompanyId ?? "", from || undefined, to || undefined),
    queryFn: () =>
      costsApi.summary(selectedCompanyId!, from || undefined, to || undefined),
    enabled: !!selectedCompanyId,
  });

  const budgetOverviewQuery = useQuery({
    queryKey: ["budgets", "overview", selectedCompanyId],
    queryFn: () => budgetsApi.overview(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const costsQueryClient = useQueryClient();
  const deletePolicyMutation = useMutation({
    mutationFn: (policyId: string) =>
      budgetsApi.deletePolicy(selectedCompanyId!, policyId),
    onSuccess: () => {
      costsQueryClient.invalidateQueries({
        queryKey: ["budgets", "overview", selectedCompanyId],
      });
    },
  });
  const quotasQuery = useQuery({
    queryKey: ["quotas", selectedCompanyId],
    queryFn: () => quotasApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  useQuery({
    queryKey: ["finance", "summary", selectedCompanyId, from, to],
    queryFn: () =>
      financeApi.summary(selectedCompanyId!, from || undefined, to || undefined),
    enabled: !!selectedCompanyId,
  });
  const costsByModelQuery = useQuery({
    queryKey: ["costs", "by-model", selectedCompanyId, from, to],
    queryFn: () =>
      costsApi.byModel(selectedCompanyId!, from || undefined, to || undefined),
    enabled: !!selectedCompanyId,
  });
  const costsByBillerQuery = useQuery({
    queryKey: ["costs", "by-biller", selectedCompanyId, from, to],
    queryFn: () =>
      costsApi.byBiller(selectedCompanyId!, from || undefined, to || undefined),
    enabled: !!selectedCompanyId,
  });
  const financeByBillerQuery = useQuery({
    queryKey: ["finance", "by-biller", selectedCompanyId, from, to],
    queryFn: () =>
      financeApi.byBiller(selectedCompanyId!, from || undefined, to || undefined),
    enabled: !!selectedCompanyId,
  });
  const financeByKindQuery = useQuery({
    queryKey: ["finance", "by-kind", selectedCompanyId, from, to],
    queryFn: () =>
      financeApi.byKind(selectedCompanyId!, from || undefined, to || undefined),
    enabled: !!selectedCompanyId,
  });
  const financeListQuery = useQuery({
    queryKey: ["finance", "list", selectedCompanyId, from, to],
    queryFn: () =>
      financeApi.list(selectedCompanyId!, {
        from: from || undefined,
        to: to || undefined,
        limit: 25,
      }),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return (
      <div className="space-y-6">
        <h1 className="text-[1.6rem] font-bold tracking-tight">
          Budget<span className="text-brand">.</span>
        </h1>
        <EmptyState icon={DollarSign} message="Select a company to view budget." />
      </div>
    );
  }

  const presetKeys: DatePreset[] = ["mtd", "7d", "30d", "ytd", "all", "custom"];
  const summary = costsSummaryQuery.data;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[1.6rem] font-bold tracking-tight">
            Budget<span className="text-brand">.</span>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Spend, budgets, quotas, and the finance ledger across the company.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {presetKeys.map((p) => (
            <Button
              key={p}
              variant={preset === p ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setPreset(p)}
            >
              {PRESET_LABELS[p]}
            </Button>
          ))}
          {preset === "custom" && (
            <div className="flex items-center gap-2 ml-1">
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
              />
              <span className="text-sm text-muted-foreground">to</span>
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
              />
            </div>
          )}
        </div>
      </div>

      {/* Summary card */}
      {costsSummaryQuery.error && (
        <p className="text-sm text-destructive">{costsSummaryQuery.error.message}</p>
      )}
      {summary && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">{PRESET_LABELS[preset]}</p>
              {summary.budgetCents > 0 && (
                <p className="text-sm text-muted-foreground">
                  {summary.utilizationPercent}% utilized
                </p>
              )}
            </div>
            <p className="text-2xl font-bold">
              {formatCents(summary.spendCents)}{" "}
              <span className="text-base font-normal text-muted-foreground">
                {summary.budgetCents > 0
                  ? `/ ${formatCents(summary.budgetCents)}`
                  : "Unlimited budget"}
              </span>
            </p>
            {summary.budgetCents > 0 && (
              <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-[width,background-color] duration-150 ${
                    summary.utilizationPercent > 90
                      ? "bg-red-400"
                      : summary.utilizationPercent > 70
                        ? "bg-yellow-400"
                        : "bg-green-400"
                  }`}
                  style={{
                    width: `${Math.min(100, summary.utilizationPercent)}%`,
                  }}
                />
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Budgets (full-width when populated) */}
      <BudgetsSection
        overview={budgetOverviewQuery.data}
        onNewPolicy={() => setNewPolicyOpen(true)}
        onDeletePolicy={(policy) => {
          if (!selectedCompanyId) return;
          if (!window.confirm(`Delete budget policy for ${policy.scopeName}? This cannot be undone.`)) return;
          deletePolicyMutation.mutate(policy.id);
        }}
      />

      {/* Quotas (full-width when populated) */}
      <QuotasSection
        companyId={selectedCompanyId}
        windows={quotasQuery.data}
      />

      {/* Breakdown — model + subscription panels */}
      <BreakdownSection
        modelRows={costsByModelQuery.data ?? []}
        billerRows={costsByBillerQuery.data ?? []}
        settingsHref={`/${selectedCompanyId}/settings`}
      />

      {/* Ledger — biller + kind + timeline */}
      <LedgerSection
        billerRows={financeByBillerQuery.data ?? []}
        kindRows={financeByKindQuery.data ?? []}
        events={financeListQuery.data ?? []}
      />

      <CreateBudgetPolicyDialog
        open={newPolicyOpen}
        onOpenChange={setNewPolicyOpen}
      />
    </div>
  );
}

// ─── Breakdown section ─────────────────────────────────────────────────
function BreakdownSection({
  modelRows,
  billerRows,
  settingsHref,
}: {
  modelRows: import("../api/costs").CostByModelRow[];
  billerRows: CostByBillerRow[];
  settingsHref: string;
}) {
  const claudeRollup = rollupBiller(billerRows, ["claude_local"]);
  const codexRollup = rollupBiller(billerRows, ["codex_local"]);

  const hasAny =
    modelRows.length > 0 || claudeRollup != null || codexRollup != null;

  if (!hasAny) {
    return (
      <SectionPlaceholder
        title="Breakdown"
        description="Per-model spend and subscription utilization appear here once cost events are recorded."
      />
    );
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold">Breakdown</h3>
      <div className="grid gap-3 md:grid-cols-2">
        <AccountingModelCard rows={modelRows} />
        <div className="space-y-3">
          <ClaudeSubscriptionPanel rollup={claudeRollup} settingsHref={settingsHref} />
          <CodexSubscriptionPanel rollup={codexRollup} settingsHref={settingsHref} />
        </div>
      </div>
    </div>
  );
}

function rollupBiller(
  rows: CostByBillerRow[],
  billerKeys: string[],
): SubscriptionRollup | null {
  const matches = rows.filter(
    (r) => r.biller != null && billerKeys.includes(r.biller.toLowerCase()),
  );
  if (matches.length === 0) return null;
  return matches.reduce<SubscriptionRollup>(
    (acc, r) => ({
      spendCents: acc.spendCents + r.totalCostCents,
      eventCount: acc.eventCount + r.eventCount,
      inputTokens: acc.inputTokens + r.totalInputTokens,
      cachedInputTokens: acc.cachedInputTokens + r.totalCachedInputTokens,
      outputTokens: acc.outputTokens + r.totalOutputTokens,
    }),
    { spendCents: 0, eventCount: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
  );
}

// ─── Ledger section ────────────────────────────────────────────────────
function LedgerSection({
  billerRows,
  kindRows,
  events,
}: {
  billerRows: import("../api/finance").FinanceBillerRow[];
  kindRows: import("../api/finance").FinanceKindRow[];
  events: import("../api/finance").FinanceEvent[];
}) {
  const hasAny = billerRows.length > 0 || kindRows.length > 0 || events.length > 0;

  if (!hasAny) {
    return (
      <SectionPlaceholder
        title="Ledger"
        description="Finance events by biller, by kind, and over time load here once any finance event is recorded."
      />
    );
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold">Ledger</h3>
      {billerRows.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2">
          {billerRows.map((row) => (
            <FinanceBillerCard key={row.biller ?? "__unknown"} row={row} />
          ))}
        </div>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        <FinanceKindCard rows={kindRows} />
        <FinanceTimelineCard rows={events} />
      </div>
    </div>
  );
}

// ─── Quotas section ────────────────────────────────────────────────────
function QuotasSection({
  companyId,
  windows,
}: {
  companyId: string;
  windows: ProviderQuotaWindow[] | undefined;
}) {
  const queryClient = useQueryClient();
  const refreshMutation = useMutation({
    // Sprint 2A removed the API adapters, so there's no adapter-type filter
    // to pass per provider — refresh all quota windows for the company.
    // The provider arg is still accepted so callers don't break, but unused.
    mutationFn: (_provider: string) =>
      quotasApi.refresh(companyId, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["quotas", companyId] });
    },
  });

  const grouped = useMemo(() => {
    if (!windows) return [] as Array<{ provider: string; rows: ProviderQuotaWindow[]; lastUpdatedAt: string | null }>;
    const byProvider = new Map<string, ProviderQuotaWindow[]>();
    for (const w of windows) {
      const bucket = byProvider.get(w.provider);
      if (bucket) bucket.push(w);
      else byProvider.set(w.provider, [w]);
    }
    return Array.from(byProvider.entries()).map(([provider, rows]) => {
      const lastUpdatedAt = rows.reduce<string | null>((acc, r) => {
        if (!acc) return r.lastUpdatedAt;
        return new Date(r.lastUpdatedAt) > new Date(acc) ? r.lastUpdatedAt : acc;
      }, null);
      return { provider, rows, lastUpdatedAt };
    });
  }, [windows]);

  if (!windows || grouped.length === 0) {
    return (
      <SectionPlaceholder
        title="Quotas"
        description="Provider rate-limit windows will appear here once an adapter reports quota usage."
      />
    );
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold">Quotas</h3>
      <div className="grid gap-3 md:grid-cols-2">
        {grouped.map((g) => (
          <ProviderQuotaCard
            key={g.provider}
            provider={g.provider}
            windows={g.rows}
            lastUpdatedAt={g.lastUpdatedAt}
            onRefresh={() => refreshMutation.mutate(g.provider)}
            isRefreshing={
              refreshMutation.isPending && refreshMutation.variables === g.provider
            }
          />
        ))}
      </div>
    </div>
  );
}

// ─── Budgets section ───────────────────────────────────────────────────
function BudgetsSection({
  overview,
  onNewPolicy,
  onDeletePolicy,
}: {
  overview: { policies: import("@armyofagents/shared").BudgetPolicySummary[]; openIncidents: import("@armyofagents/shared").BudgetIncident[] } | undefined;
  onNewPolicy: () => void;
  onDeletePolicy?: (policy: import("@armyofagents/shared").BudgetPolicySummary) => void;
}) {
  const policies = overview?.policies ?? [];
  const incidents = overview?.openIncidents ?? [];
  const hasAny = policies.length > 0 || incidents.length > 0;

  if (!hasAny) {
    return (
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">Budgets</h3>
              <p className="text-xs text-muted-foreground mt-1">
                No budget policies configured yet. Create one to cap monthly spend for the
                whole company or a single agent.
              </p>
            </div>
            <Button size="sm" onClick={onNewPolicy} className="shrink-0">
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              New Budget Policy
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Budgets</h3>
        <Button size="sm" variant="outline" onClick={onNewPolicy}>
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          New Budget Policy
        </Button>
      </div>
      {incidents.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2">
          {incidents.map((incident) => (
            <BudgetIncidentCard key={incident.id} incident={incident} />
          ))}
        </div>
      )}
      {policies.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2">
          {policies.map((policy) => (
            <BudgetPolicyCard
              key={policy.id}
              policy={policy}
              onDelete={onDeletePolicy}
            />
          ))}
        </div>
      )}
    </div>
  );
}
