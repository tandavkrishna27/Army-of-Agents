/**
 * CockpitBudgetPulseCard — Opt-in cockpit card.
 *
 * Presentational only — receives the budget pulse snapshot from the shared /cockpit query.
 * Returns null when pulse is null (no budget configured, or non-founder user).
 */

import type { CockpitBudgetPulseItem } from "@armyofagents/shared";
import { cn, formatCents } from "../../../lib/utils";

export function CockpitBudgetPulseCard({
  pulse,
}: {
  pulse: CockpitBudgetPulseItem | null;
}) {
  if (!pulse) return null;

  const pct = Math.min(pulse.percentUsed, 100);
  // "Pulse" thresholds (over=100 / warn=80) are intentionally stricter than the
  // shared budgetProgressColor (90/70) — a budget glance wants a tighter warning band.
  const isOver = pulse.percentUsed >= 100;
  const isWarning = !isOver && pulse.percentUsed >= 80;

  // Phase 5B: Internal <header> removed — title/icon now live in the
  // CockpitSection trigger in CommanderCockpitPanel. Card renders only body rows.
  return (
    <div data-testid="cockpit-card-budgetPulse">
      <div className="px-1">
        {/* Spend line */}
        <div className="mb-1 flex items-baseline justify-between text-xs">
          <span className="font-medium">
            {formatCents(pulse.spentCents)}
          </span>
          <span className="text-muted-foreground">
            / {formatCents(pulse.limitCents)}
          </span>
        </div>
        {/* Percent bar */}
        <div className="mb-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full transition-all",
              isOver ? "bg-red-500" : isWarning ? "bg-amber-500" : "bg-brand",
            )}
            style={{ width: `${pct}%` }}
            aria-label={`${Math.round(pulse.percentUsed)}% of budget used`}
          />
        </div>
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span>{Math.round(pulse.percentUsed)}%</span>
          {pulse.openIncidentCount > 0 && (
            <span className="font-medium text-red-600 dark:text-red-400">
              {pulse.openIncidentCount} open incident{pulse.openIncidentCount === 1 ? "" : "s"}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
