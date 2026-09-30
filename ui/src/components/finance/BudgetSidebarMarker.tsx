import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ShieldAlert } from "lucide-react";
import type { BudgetPolicySummary } from "@armyofagents/shared";
import { budgetsApi } from "../../api/budgets";
import { useCompany } from "../../context/CompanyContext";
import { cn } from "@/lib/utils";

type Tone = "warning" | "hard";

interface Worst {
  tone: Tone;
  utilizationPercent: number;
}

function pickWorst(policies: BudgetPolicySummary[]): Worst | null {
  let worst: Worst | null = null;
  for (const p of policies) {
    if (!p.isActive) continue;
    if (p.status === "hard_stop") {
      if (!worst || worst.tone !== "hard" || p.utilizationPercent > worst.utilizationPercent) {
        worst = { tone: "hard", utilizationPercent: p.utilizationPercent };
      }
    } else if (p.status === "warning") {
      if (!worst) {
        worst = { tone: "warning", utilizationPercent: p.utilizationPercent };
      } else if (worst.tone === "warning" && p.utilizationPercent > worst.utilizationPercent) {
        worst = { tone: "warning", utilizationPercent: p.utilizationPercent };
      }
    }
  }
  return worst;
}

export interface BudgetSidebarMarkerProps {
  collapsed?: boolean;
}

export function BudgetSidebarMarker({ collapsed = false }: BudgetSidebarMarkerProps) {
  const { selectedCompanyId } = useCompany();
  const { data } = useQuery({
    queryKey: ["budgets", "overview", selectedCompanyId],
    queryFn: () => budgetsApi.overview(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const worst = data ? pickWorst(data.policies) : null;
  if (!worst) return null;

  const Icon = worst.tone === "hard" ? ShieldAlert : AlertTriangle;
  const label = `${worst.tone === "hard" ? "Over" : "Warn"} · Budget ${worst.utilizationPercent}% used`;
  const title =
    worst.tone === "hard"
      ? `Budget exceeded (${worst.utilizationPercent}% used)`
      : `Budget warning (${worst.utilizationPercent}% used)`;

  const toneClasses =
    worst.tone === "hard"
      ? "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400"
      : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";

  if (collapsed) {
    return (
      <span
        data-testid="budget-sidebar-marker"
        data-tone={worst.tone}
        title={title}
        aria-label={title}
        className={cn(
          "mx-auto flex h-4 w-4 items-center justify-center rounded-full border",
          toneClasses,
        )}
      >
        <Icon className="h-2.5 w-2.5" />
      </span>
    );
  }

  return (
    <div
      data-testid="budget-sidebar-marker"
      data-tone={worst.tone}
      title={title}
      aria-label={title}
      className={cn(
        "mx-3 mt-0.5 mb-1 flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium",
        toneClasses,
      )}
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span className="truncate">{label}</span>
    </div>
  );
}
