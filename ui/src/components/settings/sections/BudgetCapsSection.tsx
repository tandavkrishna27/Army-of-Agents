import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "@/context/CompanyContext";
import { costsApi, type CostByBillerRow } from "@/api/costs";
import { budgetsApi } from "@/api/budgets";
import { quotasApi, type ProviderQuotaWindow } from "@/api/quotas";
import { financeApi } from "@/api/finance";
import { internalAgentApi } from "@/api/internal-agent";
import { queryKeys } from "@/lib/queryKeys";
import { formatCents, formatTokens, budgetProgressColor } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DollarSign, Plus } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Identity } from "@/components/Identity";
import { StatusBadge } from "@/components/StatusBadge";
import { CreateBudgetPolicyDialog } from "@/components/finance/CreateBudgetPolicyDialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { BudgetPolicyCard } from "@/components/finance/BudgetPolicyCard";
import { BudgetIncidentCard } from "@/components/finance/BudgetIncidentCard";
import { ProviderQuotaCard } from "@/components/finance/ProviderQuotaCard";
import { AccountingModelCard } from "@/components/finance/AccountingModelCard";
import {
  ClaudeSubscriptionPanel,
  type SubscriptionRollup,
} from "@/components/finance/ClaudeSubscriptionPanel";
import { CodexSubscriptionPanel } from "@/components/finance/CodexSubscriptionPanel";
import { FinanceBillerCard } from "@/components/finance/FinanceBillerCard";
import { FinanceKindCard } from "@/components/finance/FinanceKindCard";
import { FinanceTimelineCard } from "@/components/finance/FinanceTimelineCard";

// ─── Date preset helpers ───────────────────────────────────────────────
type DatePreset = "mtd" | "7d" | "30d" | "ytd" | "all" | "custom";

const PRESET_LABELS: Record<DatePreset, string> = {
  mtd: "MTD",
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

// ─── Section placeholder ───────────────────────────────────────────────
function SectionPlaceholder({ title, description }: { title: string; description: string }) {
  return (
    <Card>
      <CardContent className="p-4 space-y-1.5">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  );
}

// ─── Main section ──────────────────────────────────────────────────────
export function BudgetCapsSection() {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();

  const [preset, setPreset] = useState<DatePreset>("mtd");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [newPolicyOpen, setNewPolicyOpen] = useState(false);
  const [deletePolicyTarget, setDeletePolicyTarget] = useState<{ id: string; scopeName: string } | null>(null);

  const { from, to } = useMemo(() => {
    if (preset === "custom") {
      return {
        from: customFrom ? new Date(customFrom).toISOString() : "",
        to: customTo ? new Date(customTo + "T23:59:59.999Z").toISOString() : "",
      };
    }
    return computeRange(preset);
  }, [preset, customFrom, customTo]);

  // ── Queries ────────────────────────────────────────────────────────
  const costsSummaryQuery = useQuery({
    queryKey: queryKeys.costs(selectedCompanyId!, from || undefined, to || undefined),
    queryFn: () => costsApi.summary(selectedCompanyId!, from || undefined, to || undefined),
    enabled: !!selectedCompanyId,
  });

  const costsByAgentQuery = useQuery({
    queryKey: ["costs", "by-agent", selectedCompanyId, from, to],
    queryFn: () => costsApi.byAgent(selectedCompanyId!, from || undefined, to || undefined),
    enabled: !!selectedCompanyId,
  });

  const costsByProjectQuery = useQuery({
    queryKey: ["costs", "by-project", selectedCompanyId, from, to],
    queryFn: () => costsApi.byProject(selectedCompanyId!, from || undefined, to || undefined),
    enabled: !!selectedCompanyId,
  });

  const costsByModelQuery = useQuery({
    queryKey: ["costs", "by-model", selectedCompanyId, from, to],
    queryFn: () => costsApi.byModel(selectedCompanyId!, from || undefined, to || undefined),
    enabled: !!selectedCompanyId,
  });

  const costsByBillerQuery = useQuery({
    queryKey: ["costs", "by-biller", selectedCompanyId, from, to],
    queryFn: () => costsApi.byBiller(selectedCompanyId!, from || undefined, to || undefined),
    enabled: !!selectedCompanyId,
  });

  const financeByBillerQuery = useQuery({
    queryKey: ["finance", "by-biller", selectedCompanyId, from, to],
    queryFn: () => financeApi.byBiller(selectedCompanyId!, from || undefined, to || undefined),
    enabled: !!selectedCompanyId,
  });

  const financeByKindQuery = useQuery({
    queryKey: ["finance", "by-kind", selectedCompanyId, from, to],
    queryFn: () => financeApi.byKind(selectedCompanyId!, from || undefined, to || undefined),
    enabled: !!selectedCompanyId,
  });

  const financeListQuery = useQuery({
    queryKey: ["finance", "list", selectedCompanyId, from, to],
    queryFn: () =>
      financeApi.list(selectedCompanyId!, { from: from || undefined, to: to || undefined, limit: 25 }),
    enabled: !!selectedCompanyId,
  });

  const agentConfigQuery = useQuery({
    queryKey: queryKeys.agentConfig(selectedCompanyId!),
    queryFn: () => internalAgentApi.getConfig(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const budgetOverviewQuery = useQuery({
    queryKey: ["budgets", "overview", selectedCompanyId],
    queryFn: () => budgetsApi.overview(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const quotasQuery = useQuery({
    queryKey: ["quotas", selectedCompanyId],
    queryFn: () => quotasApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // ── Mutations ──────────────────────────────────────────────────────
  const deletePolicyMutation = useMutation({
    mutationFn: (policyId: string) => budgetsApi.deletePolicy(selectedCompanyId!, policyId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["budgets", "overview", selectedCompanyId] });
    },
  });

  const refreshQuotaMutation = useMutation({
    mutationFn: () => quotasApi.refresh(selectedCompanyId!, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["quotas", selectedCompanyId] });
    },
  });

  const presetKeys: DatePreset[] = ["mtd", "7d", "30d", "ytd", "all", "custom"];

  const summary = costsSummaryQuery.data;
  const agentConfig = agentConfigQuery.data;
  const budgetOverview = budgetOverviewQuery.data;
  const policies = budgetOverview?.policies ?? [];
  const incidents = budgetOverview?.openIncidents ?? [];

  const claudeRollup = rollupBiller(costsByBillerQuery.data ?? [], ["claude_local"]);
  const codexRollup = rollupBiller(costsByBillerQuery.data ?? [], ["codex_local"]);

  const groupedQuotas = useMemo(() => {
    const windows = quotasQuery.data;
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
  }, [quotasQuery.data]);

  return (
    <div>
      {/* Section header */}
      <div className="px-8 pt-6 pb-3 border-b border-border">
        <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60 font-semibold">
          Settings · Operations
        </div>
        <h2 className="text-[1.4rem] font-bold tracking-tight mt-1">
          Budget &amp; caps<span className="text-brand">.</span>
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Spend, budgets, quotas, and the finance ledger across the company.
        </p>
      </div>

      <div className="p-8">
        {!selectedCompanyId ? (
          <EmptyState icon={DollarSign} message="Select a company to view budget." />
        ) : costsSummaryQuery.isLoading ? (
          <PageSkeleton variant="costs" />
        ) : (
          <div className="space-y-6">
            {/* Date range selector */}
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

            {costsSummaryQuery.error && (
              <p className="text-sm text-destructive">{costsSummaryQuery.error.message}</p>
            )}

            {/* Summary card */}
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
                    {formatCents(
                      summary.spendCents + (agentConfig?.spentMonthlyCents ?? 0),
                    )}{" "}
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
                        style={{ width: `${Math.min(100, summary.utilizationPercent)}%` }}
                      />
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Budget Policies */}
            {policies.length === 0 && incidents.length === 0 ? (
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
                    <Button size="sm" onClick={() => setNewPolicyOpen(true)} className="shrink-0">
                      <Plus className="h-3.5 w-3.5 mr-1.5" />
                      New Policy
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold">Budgets</h3>
                  <Button size="sm" variant="outline" onClick={() => setNewPolicyOpen(true)}>
                    <Plus className="h-3.5 w-3.5 mr-1.5" />
                    New Policy
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
                        onDelete={(p) => setDeletePolicyTarget({ id: p.id, scopeName: p.scopeName })}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            <CreateBudgetPolicyDialog
              open={newPolicyOpen}
              onOpenChange={setNewPolicyOpen}
              onCreated={() => {
                queryClient.invalidateQueries({ queryKey: ["budgets", "overview", selectedCompanyId] });
              }}
            />
            <ConfirmDialog
              open={deletePolicyTarget !== null}
              onOpenChange={(open) => { if (!open) setDeletePolicyTarget(null); }}
              title={`Delete budget policy for ${deletePolicyTarget?.scopeName ?? ""}?`}
              description="This cannot be undone."
              confirmLabel="Delete"
              destructive
              onConfirm={() => {
                if (deletePolicyTarget) deletePolicyMutation.mutate(deletePolicyTarget.id);
                setDeletePolicyTarget(null);
              }}
            />

            {/* Quotas */}
            {groupedQuotas.length === 0 ? (
              <SectionPlaceholder
                title="Quotas"
                description="Provider rate-limit windows will appear here once an adapter reports quota usage."
              />
            ) : (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold">Quotas</h3>
                <div className="grid gap-3 md:grid-cols-2">
                  {groupedQuotas.map((g) => (
                    <ProviderQuotaCard
                      key={g.provider}
                      provider={g.provider}
                      windows={g.rows}
                      lastUpdatedAt={g.lastUpdatedAt}
                      onRefresh={() => refreshQuotaMutation.mutate()}
                      isRefreshing={refreshQuotaMutation.isPending}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Breakdown — by model + subscription panels */}
            {(costsByModelQuery.data?.length ?? 0) === 0 && claudeRollup == null && codexRollup == null ? (
              <SectionPlaceholder
                title="Breakdown"
                description="Per-model spend and subscription utilization appear here once cost events are recorded."
              />
            ) : (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold">Breakdown</h3>
                <div className="grid gap-3 md:grid-cols-2">
                  <AccountingModelCard rows={costsByModelQuery.data ?? []} />
                  <div className="space-y-3">
                    <ClaudeSubscriptionPanel rollup={claudeRollup} settingsHref="" />
                    <CodexSubscriptionPanel rollup={codexRollup} settingsHref="" />
                  </div>
                </div>
              </div>
            )}

            {/* By Agent / By Project */}
            <div className="grid md:grid-cols-2 gap-4">
              <Card>
                <CardContent className="p-4">
                  <h3 className="text-sm font-semibold mb-3">By Agent</h3>
                  {(costsByAgentQuery.data?.length ?? 0) === 0 ? (
                    <p className="text-sm text-muted-foreground">No cost events yet.</p>
                  ) : (
                    <div className="space-y-2">
                      {costsByAgentQuery.data!.map((row) => (
                        <div
                          key={row.agentId}
                          className="flex items-start justify-between text-sm"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <Identity name={row.agentName ?? row.agentId} size="sm" />
                            {row.agentStatus === "terminated" && (
                              <StatusBadge status="terminated" />
                            )}
                          </div>
                          <div className="text-right shrink-0 ml-2">
                            <span className="font-medium block">{formatCents(row.costCents)}</span>
                            <span className="text-xs text-muted-foreground block">
                              in {formatTokens(row.inputTokens)} / out{" "}
                              {formatTokens(row.outputTokens)} tok
                            </span>
                            {(row.apiRunCount > 0 || row.subscriptionRunCount > 0) && (
                              <span className="text-xs text-muted-foreground block">
                                {row.apiRunCount > 0 ? `metered runs: ${row.apiRunCount}` : null}
                                {row.apiRunCount > 0 && row.subscriptionRunCount > 0 ? " | " : null}
                                {row.subscriptionRunCount > 0
                                  ? `subscription runs: ${row.subscriptionRunCount} (${formatTokens(row.subscriptionInputTokens)} in / ${formatTokens(row.subscriptionOutputTokens)} out tok)`
                                  : null}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {agentConfig && agentConfig.budgetMonthlyCents != null && (
                    <div className="mt-4 pt-4 border-t border-border">
                      <p className="text-xs font-medium text-muted-foreground mb-2">Commander</p>
                      <div className="flex items-center justify-between text-sm">
                        <span>AI Assistant</span>
                        <span>
                          {formatCents(agentConfig.spentMonthlyCents)} /{" "}
                          {formatCents(agentConfig.budgetMonthlyCents)}
                        </span>
                      </div>
                      <div className="h-1.5 rounded-full bg-muted overflow-hidden mt-1">
                        <div
                          className={`h-full rounded-full ${budgetProgressColor(
                            agentConfig.budgetMonthlyCents > 0
                              ? (agentConfig.spentMonthlyCents / agentConfig.budgetMonthlyCents) * 100
                              : 0,
                          )}`}
                          style={{
                            width: `${
                              agentConfig.budgetMonthlyCents > 0
                                ? Math.min(
                                    (agentConfig.spentMonthlyCents / agentConfig.budgetMonthlyCents) * 100,
                                    100,
                                  )
                                : 0
                            }%`,
                          }}
                        />
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-4">
                  <h3 className="text-sm font-semibold mb-3">By Project</h3>
                  {(costsByProjectQuery.data?.length ?? 0) === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No project-attributed run costs yet.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {costsByProjectQuery.data!.map((row) => (
                        <div
                          key={row.projectId ?? "na"}
                          className="flex items-center justify-between text-sm"
                        >
                          <span className="truncate">
                            {row.projectName ?? row.projectId ?? "Unattributed"}
                          </span>
                          <span className="font-medium">{formatCents(row.costCents)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Ledger — biller + kind + timeline */}
            {(financeByBillerQuery.data?.length ?? 0) === 0 &&
            (financeByKindQuery.data?.length ?? 0) === 0 &&
            (financeListQuery.data?.length ?? 0) === 0 ? (
              <SectionPlaceholder
                title="Ledger"
                description="Finance events by biller, by kind, and over time load here once any finance event is recorded."
              />
            ) : (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold">Ledger</h3>
                {(financeByBillerQuery.data?.length ?? 0) > 0 && (
                  <div className="grid gap-3 md:grid-cols-2">
                    {financeByBillerQuery.data!.map((row) => (
                      <FinanceBillerCard key={row.biller ?? "__unknown"} row={row} />
                    ))}
                  </div>
                )}
                <div className="grid gap-3 md:grid-cols-2">
                  <FinanceKindCard rows={financeByKindQuery.data ?? []} />
                  <FinanceTimelineCard rows={financeListQuery.data ?? []} />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
