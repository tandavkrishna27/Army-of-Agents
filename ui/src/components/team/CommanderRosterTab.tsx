import type { Agent, AgentTrustScore } from "@armyofagents/shared";
import { useNavigate } from "@/lib/router";
import { cn } from "../../lib/utils";
import { StatusBadge } from "../StatusBadge";
import { AgentIcon } from "../AgentIconPicker";
import { agentStatusDot, agentStatusDotDefault } from "../../lib/status-colors";
import {
  getTrustScoreTone,
  getTrustScoreToneClasses,
  formatTrustScorePercent,
  hasTrustScoreData,
} from "../../lib/trust-score";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";

interface CommanderRosterTabProps {
  agents: Agent[];
  trustScores: AgentTrustScore[];
  isFounder: boolean;
  onNewAgent: () => void;
}

function BudgetBar({ spent, limit }: { spent: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, Math.round((spent / limit) * 100)) : 0;
  const spentDollars = (spent / 100).toFixed(0);
  const limitDollars = (limit / 100).toFixed(0);
  const color =
    pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-yellow-500" : "bg-green-500";

  return (
    <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
      <span className="shrink-0">Budget</span>
      <div className="flex-1 h-1 rounded-full bg-accent overflow-hidden">
        <div className={cn("h-full rounded-full transition-all", color)} style={{ width: `${pct}%` }} />
      </div>
      <span className={cn("shrink-0", pct >= 90 && "text-red-400")}>
        ${spentDollars} / ${limitDollars}
      </span>
    </div>
  );
}

export function CommanderRosterTab({
  agents,
  trustScores,
  isFounder,
  onNewAgent,
}: CommanderRosterTabProps) {
  const navigate = useNavigate();
  const trustMap = new Map(trustScores.map((ts) => [ts.agentId, ts]));

  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-bold">
            Commander Team{" "}
            <span className="ml-1 text-xs font-medium text-muted-foreground">
              {agents.length}
            </span>
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">AoA agents in this company</p>
        </div>
        {isFounder && (
          <Button size="sm" variant="outline" onClick={onNewAgent}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            New AoA Agent
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {agents.map((agent) => {
          const isLead = (agent.runtimeConfig as any)?.aoa?.role === "lead";
          const isRunning = agent.status === "running";
          const trust = trustMap.get(agent.id) ?? null;
          const hasTrust = hasTrustScoreData(trust);
          const tone = trust ? getTrustScoreTone(trust.currentScore) : null;
          const toneClasses = tone ? getTrustScoreToneClasses(tone) : null;
          const dotClass = agentStatusDot[agent.status] ?? agentStatusDotDefault;

          return (
            <div
              key={agent.id}
              data-testid={`commander-agent-card-${agent.id}`}
              className={cn(
                "group relative border border-border bg-card rounded-lg p-4",
                "transition-all duration-150 cursor-pointer",
                "hover:border-primary/40 hover:shadow-sm",
                isRunning && "border-cyan-500/30 shadow-[0_0_12px_rgba(6,182,212,0.06)]",
              )}
              onClick={() => navigate(`/team/aoa/${agent.id}`)}
            >
              {/* Header */}
              <div className="flex items-start gap-3">
                <div className="shrink-0 flex items-center justify-center h-10 w-10 rounded-lg bg-accent">
                  <AgentIcon icon={agent.icon} className="h-5 w-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold truncate">{agent.name}</h3>
                    <div className={cn("h-2.5 w-2.5 rounded-full shrink-0", dotClass)} />
                    {isLead && (
                      <span className="inline-flex items-center rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-medium text-brand ring-1 ring-inset ring-brand/20">
                        Lead
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground truncate">
                    {isLead ? "Commander" : "Member"} · {agent.adapterType}
                  </p>
                </div>
              </div>

              {/* Body */}
              <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                <StatusBadge status={agent.status} />
              </div>

              {/* Footer */}
              <div className="mt-3 pt-3 border-t border-border/50 flex items-center justify-between text-[11px] text-muted-foreground">
                <span>
                  {agent.lastHeartbeatAt
                    ? `Last active ${new Date(agent.lastHeartbeatAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                    : "Never run"}
                </span>
                {hasTrust && trust && toneClasses && (
                  <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 font-medium", toneClasses.badge)}>
                    {formatTrustScorePercent(trust.currentScore)}
                  </span>
                )}
              </div>

              {/* Budget bar */}
              <BudgetBar spent={agent.spentMonthlyCents} limit={agent.budgetMonthlyCents} />
            </div>
          );
        })}
      </div>
    </>
  );
}
