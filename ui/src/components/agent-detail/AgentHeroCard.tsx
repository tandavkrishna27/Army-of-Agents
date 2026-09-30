import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { Agent } from "@armyofagents/shared";
import { cn } from "@/lib/utils";
import { AgentIcon, AgentIconPicker } from "../AgentIconPicker";
import { StatusBadge } from "../StatusBadge";
import { adapterLabels, roleLabels } from "../agent-config-primitives";

export interface HeroKpi {
  /** stable id; also used as `data-testid="hero-kpi-<key>"`. */
  key: string;
  label: string;
  value: ReactNode;
  /** optional deep-link route; wraps the tile in a <Link>. */
  to?: string;
  /** renders a placeholder while the underlying value loads. */
  loading?: boolean;
}

export interface AgentHeroCardProps {
  agent: Agent;
  kpis?: HeroKpi[];
  badges?: { adapter?: string; model?: string };
  /** header actions (Invoke / Pause / More …). */
  actions?: ReactNode;
  /** when provided, the icon becomes a click-to-edit picker. */
  onIconChange?: (icon: string) => void;
  /** header-error line rendered under the card (actionError / lifecycleError). */
  error?: string | null;
}

function MonoBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-mono text-muted-foreground bg-muted rounded-md px-2 py-0.5">
      {children}
    </span>
  );
}

/**
 * Consolidated hero card for the agent detail page (worker + AoA).
 * Identity, live status, adapter/model, a KPI strip with deep-links, the
 * actions slot, and a header-error line — all in one bordered card.
 */
export function AgentHeroCard({
  agent,
  kpis,
  badges,
  actions,
  onIconChange,
  error,
}: AgentHeroCardProps) {
  const icon = <AgentIcon icon={agent.icon} className="h-6 w-6" />;

  return (
    <div className="space-y-3">
      <div className="border border-border rounded-lg p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {onIconChange ? (
              <AgentIconPicker value={agent.icon} onChange={onIconChange}>
                <button
                  type="button"
                  aria-label="Change agent icon"
                  className="shrink-0 flex items-center justify-center h-12 w-12 rounded-lg bg-accent hover:bg-accent/80 transition-colors"
                >
                  {icon}
                </button>
              </AgentIconPicker>
            ) : (
              <div className="shrink-0 flex items-center justify-center h-12 w-12 rounded-lg bg-accent">
                {icon}
              </div>
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-2xl font-bold truncate">{agent.name}</h1>
                <StatusBadge status={agent.status} />
              </div>
              <p className="text-sm text-muted-foreground truncate">
                {roleLabels[agent.role] ?? agent.role}
                {agent.title ? ` — ${agent.title}` : ""}
              </p>
              {(badges?.adapter || badges?.model) && (
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  {badges.adapter && (
                    <MonoBadge>{adapterLabels[badges.adapter] ?? badges.adapter}</MonoBadge>
                  )}
                  {badges.model && <MonoBadge>{badges.model}</MonoBadge>}
                </div>
              )}
            </div>
          </div>
          {actions && (
            <div className="flex items-center gap-1 sm:gap-2 shrink-0">{actions}</div>
          )}
        </div>

        {kpis && kpis.length > 0 && (
          <div className="mt-4 pt-3 border-t border-border flex flex-wrap gap-x-6 gap-y-3">
            {kpis.map((kpi) => {
              const inner = (
                <>
                  <div className="text-[11px] text-muted-foreground">{kpi.label}</div>
                  <div className="text-lg font-semibold">
                    {kpi.loading ? <span className="text-muted-foreground">—</span> : kpi.value}
                  </div>
                </>
              );
              return kpi.to ? (
                <Link
                  key={kpi.key}
                  to={kpi.to}
                  data-testid={`hero-kpi-${kpi.key}`}
                  className={cn(
                    "block rounded-md px-2 -mx-2 hover:bg-accent/40 transition-colors",
                  )}
                >
                  {inner}
                </Link>
              ) : (
                <div key={kpi.key} data-testid={`hero-kpi-${kpi.key}`} className="px-2 -mx-2">
                  {inner}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
