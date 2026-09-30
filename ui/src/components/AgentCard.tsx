import { memo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@/lib/router";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { agentStatusDot, agentStatusDotDefault } from "../lib/status-colors";
import { adapterLabels, roleLabels } from "./agent-config-primitives";
import { AgentIcon } from "./AgentIconPicker";
import { StatusBadge } from "./StatusBadge";
import { relativeTime, cn, agentUrl, agentRouteRef } from "../lib/utils";
import { ClickableDiv } from "./ui/clickable-div";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Play, Pause, MoreHorizontal, Settings, History } from "lucide-react";
import type { Agent, AgentTrustScore } from "@armyofagents/shared";
import { TrustScoreBadge } from "./TrustScoreBadge";

interface AgentCardProps {
  agent: Agent;
  liveRun?: { runId: string; liveCount: number } | null;
  currentTaskTitle?: string | null;
  trustScore?: AgentTrustScore | null;
  /**
   * Extra dropdown menu items rendered after the built-in Configure / View Runs
   * options (with a separator). Used by AgentsTab to inject Terminate/Delete
   * for the founder. Stop-propagation is the caller's responsibility.
   */
  dropdownExtras?: React.ReactNode;
  /** When provided, overrides the default card-click navigation. */
  onSelect?: () => void;
}

export const AgentCard = memo(function AgentCard({ agent, liveRun, currentTaskTitle, trustScore, dropdownExtras, onSelect }: AgentCardProps) {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const statusColor = agentStatusDot[agent.status] ?? agentStatusDotDefault;

  const agentAction = useMutation({
    mutationFn: async (action: "pause" | "resume") => {
      switch (action) {
        case "pause":
          return agentsApi.pause(agent.id, selectedCompanyId ?? undefined);
        case "resume":
          return agentsApi.resume(agent.id, selectedCompanyId ?? undefined);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId) });
      }
    },
  });

  const isPaused = agent.status === "paused";
  const isLive = !!liveRun;
  const agentRef = agentRouteRef(agent);

  return (
    <ClickableDiv
      className={cn(
        "group relative border border-border bg-card rounded-lg p-4 transition-all duration-150 cursor-pointer agent-card-hover",
        isLive && "border-cyan-500/30 shadow-[0_0_12px_rgba(6,182,212,0.06)]"
      )}
      onClick={() => onSelect ? onSelect() : navigate(agentUrl(agent))}
    >
      {/* Header: Icon + Name + Status */}
      <div className="flex items-start gap-3">
        <div className="shrink-0 flex items-center justify-center h-10 w-10 rounded-lg bg-accent">
          <AgentIcon icon={agent.icon} className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold truncate">{agent.name}</h3>
            <span className="relative flex h-2.5 w-2.5 shrink-0">
              <span className={cn("absolute inline-flex h-full w-full rounded-full", statusColor)} />
            </span>
          </div>
          <p className="text-xs text-muted-foreground truncate">
            {roleLabels[agent.role] ?? agent.role}
            {agent.title ? ` \u00B7 ${agent.title}` : ""}
          </p>
        </div>

        {/* Quick actions (stop propagation to prevent card click) */}
        <div
          className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => e.stopPropagation()}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => agentAction.mutate(isPaused ? "resume" : "pause")}
                disabled={agentAction.isPending || agent.status === "pending_approval" || agent.status === "terminated"}
                aria-label={isPaused ? `Resume ${agent.name}` : `Pause ${agent.name}`}
              >
                {isPaused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{isPaused ? "Resume" : "Pause"}</TooltipContent>
          </Tooltip>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs" aria-label={`More actions for ${agent.name}`}>
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem onClick={() => navigate(`/agents/${agentRef}/configure`)}>
                <Settings className="h-3.5 w-3.5 mr-2" />
                Configure
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => navigate(`/agents/${agentRef}/runs`)}>
                <History className="h-3.5 w-3.5 mr-2" />
                View Runs
              </DropdownMenuItem>
              {dropdownExtras && (
                <>
                  <DropdownMenuSeparator />
                  {dropdownExtras}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Body: adapter + current task / live indicator */}
      <div className="mt-3 space-y-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono">
            {adapterLabels[agent.adapterType] ?? agent.adapterType}
          </span>
          <span className="text-border">&middot;</span>
          <StatusBadge status={agent.status} />
        </div>

        {/* Current task or live run indicator */}
        {isLive ? (
          <Link
            to={`/agents/${agentRef}/runs/${liveRun.runId}`}
            className="flex items-center gap-1.5 text-xs no-underline"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-400" />
            </span>
            <span className="text-cyan-600 dark:text-cyan-400 font-medium truncate">
              Running{liveRun.liveCount > 1 ? ` (${liveRun.liveCount})` : ""}
              {currentTaskTitle ? `: ${currentTaskTitle}` : ""}
            </span>
          </Link>
        ) : currentTaskTitle ? (
          <p className="text-xs text-muted-foreground truncate">
            Working on: {currentTaskTitle}
          </p>
        ) : null}
      </div>

      {/* Footer: last heartbeat */}
      <div className="mt-3 pt-3 border-t border-border/50 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>
          {agent.lastHeartbeatAt ? `Last active ${relativeTime(agent.lastHeartbeatAt)}` : "No activity yet"}
        </span>
        <TrustScoreBadge score={trustScore} />
      </div>
    </ClickableDiv>
  );
});
