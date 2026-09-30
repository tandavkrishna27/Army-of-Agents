import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertOctagon, ArrowUpRight, PauseCircle } from "lucide-react";
import type { BudgetIncident, ResolveBudgetIncidentInput } from "@armyofagents/shared";
import { budgetsApi } from "../../api/budgets";
import { useCompany } from "../../context/CompanyContext";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCents, formatDate } from "@/lib/utils";

function centsToDollars(cents: number) {
  return (cents / 100).toFixed(2);
}

function parseDollarInput(value: string): number | null {
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

export interface BudgetIncidentCardProps {
  incident: BudgetIncident;
}

export function BudgetIncidentCard({ incident }: BudgetIncidentCardProps) {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const isHardStop = incident.thresholdType === "hard_stop";
  const suggestedCents = Math.max(
    incident.amountObservedCents + 1_000,
    incident.amountLimitCents,
  );
  const [draftAmount, setDraftAmount] = useState(centsToDollars(suggestedCents));
  const parsedCents = parseDollarInput(draftAmount);
  const tone = isHardStop
    ? {
        border: "border-red-500/40",
        bg: "bg-red-500/10",
        text: "text-red-600 dark:text-red-400",
        label: "Hard Stop",
      }
    : {
        border: "border-amber-500/40",
        bg: "bg-amber-500/10",
        text: "text-amber-700 dark:text-amber-300",
        label: "Warning",
      };

  const resolveMutation = useMutation({
    mutationFn: (input: ResolveBudgetIncidentInput) =>
      budgetsApi.resolveIncident(selectedCompanyId!, incident.id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["budgets", "overview", selectedCompanyId],
      });
    },
  });

  const raiseDisabled =
    !selectedCompanyId ||
    resolveMutation.isPending ||
    parsedCents === null ||
    parsedCents <= incident.amountObservedCents;

  return (
    <Card className={`overflow-hidden border ${tone.border}`}>
      <CardContent className="p-4 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className={`text-xs font-medium uppercase tracking-wide ${tone.text}`}>
              {incident.scopeType} · {tone.label}
            </p>
            <h3 className="text-sm font-semibold mt-0.5 truncate">
              {incident.scopeName ?? incident.scopeId}
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {formatCents(incident.amountObservedCents)} observed /{" "}
              {formatCents(incident.amountLimitCents)} limit
            </p>
            <p className="text-xs text-muted-foreground">
              Window started {formatDate(incident.windowStart)}
            </p>
          </div>
          <span
            className={`inline-flex h-7 w-7 items-center justify-center rounded-full border ${tone.border} ${tone.bg} ${tone.text}`}
          >
            <AlertOctagon className="h-3.5 w-3.5" />
          </span>
        </div>

        <div className={`flex items-start gap-2 rounded-md border ${tone.border} ${tone.bg} px-3 py-2 text-xs ${tone.text}`}>
          <PauseCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>
            {isHardStop
              ? "Execution is paused for this scope. Resolve to resume."
              : "Budget warning — spend is approaching the configured limit."}
          </span>
        </div>

        {incident.approvalId && (
          <p className="text-xs text-muted-foreground">
            Linked approval:{" "}
            <span className="font-mono">{incident.approvalId}</span>
          </p>
        )}

        {isHardStop && (
          <div className="rounded-md border border-border/70 p-3 space-y-2">
            <Label
              htmlFor={`incident-${incident.id}-new-budget`}
              className="text-[10px] uppercase tracking-wide text-muted-foreground"
            >
              New budget (USD)
            </Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id={`incident-${incident.id}-new-budget`}
                value={draftAmount}
                onChange={(e) => setDraftAmount(e.target.value)}
                inputMode="decimal"
                placeholder="0.00"
                className="h-8"
              />
              <Button
                size="sm"
                className="gap-1.5"
                disabled={raiseDisabled}
                onClick={() => {
                  if (parsedCents === null) return;
                  resolveMutation.mutate({
                    action: "raise_and_resume",
                    newAmountCents: parsedCents,
                  });
                }}
              >
                <ArrowUpRight className="h-3.5 w-3.5" />
                {resolveMutation.isPending ? "Applying..." : "Raise & Resume"}
              </Button>
            </div>
            {parsedCents !== null && parsedCents <= incident.amountObservedCents && (
              <p className="text-xs text-red-600 dark:text-red-400">
                New budget must exceed current observed spend.
              </p>
            )}
          </div>
        )}

        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-muted-foreground"
            disabled={!selectedCompanyId || resolveMutation.isPending}
            onClick={() => resolveMutation.mutate({ action: "dismiss" })}
          >
            Dismiss
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
