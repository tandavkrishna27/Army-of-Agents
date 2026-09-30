import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { agentsApi } from "../../../api/agents";
import { activityApi } from "../../../api/activity";
import { heartbeatsApi } from "../../../api/heartbeats";
import { issuesApi } from "../../../api/issues";
import { dependenciesApi } from "../../../api/dependencies";
import { artifactsApi } from "../../../api/artifacts";
import { queryKeys } from "../../../lib/queryKeys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Bot, ExternalLink, AlertTriangle, ArrowDown, Play } from "lucide-react";
import type { Agent, Issue } from "@armyofagents/shared";

interface ProcessSectionProps {
  issueId: string;
  companyId: string;
  companyPrefix: string;
}

export function ProcessSection({
  issueId,
  companyId,
  companyPrefix,
}: ProcessSectionProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: issue, isLoading: issueLoading } = useQuery({
    queryKey: queryKeys.issues.detail(issueId),
    queryFn: () => issuesApi.get(issueId),
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });

  const { data: runs } = useQuery({
    queryKey: queryKeys.issues.runs(issueId),
    queryFn: () => activityApi.runsForIssue(issueId),
  });

  const { data: activeRun } = useQuery({
    queryKey: queryKeys.issues.activeRun(issueId),
    queryFn: () => heartbeatsApi.activeRunForIssue(issueId),
    refetchInterval: 5000,
  });

  const { data: deps } = useQuery({
    queryKey: queryKeys.issues.dependencies(issueId),
    queryFn: () => dependenciesApi.list(companyId, issueId),
  });

  const assignedAgent = agents?.find((a: Agent) => a.id === issue?.assigneeAgentId);
  const isRunning = !!activeRun;
  const totalRuns = runs?.length ?? 0;
  const isBlocked = issue?.status === "blocked";

  const blockingTasks = isBlocked
    ? (deps?.upstream ?? []).filter((d) => d.status !== "done" && d.status !== "completed")
    : [];

  const completedUpstream = (deps?.upstream ?? []).filter(
    (d) => d.status === "done" || d.status === "completed",
  );

  const wakeAgent = useMutation({
    mutationFn: (agentId: string) =>
      agentsApi.wakeup(
        agentId,
        {
          source: "on_demand",
          triggerDetail: "manual",
          reason: "workspace_process_wake",
          payload: { issueId },
        },
        companyId,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.activeRun(issueId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.runs(issueId) });
    },
  });

  if (issueLoading) {
    return (
      <div className="px-3 space-y-2" data-testid="process-skeleton">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-4 w-32" />
      </div>
    );
  }

  return (
    <div className="min-w-0 max-w-full space-y-2 overflow-hidden px-1" data-testid="process-section">
      {/* Agent info */}
      {assignedAgent ? (
        <button
          type="button"
          className="flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-md p-1.5 text-left transition-colors hover:bg-accent/50"
          onClick={() => navigate(`/${companyPrefix}/agents/${assignedAgent.urlKey}`)}
          data-testid="agent-link"
        >
          <Bot className="h-4 w-4 text-muted-foreground shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm truncate">{assignedAgent.name}</div>
            <Badge variant="outline" className="text-[10px] h-4 px-1 mt-0.5">
              {assignedAgent.adapterType}
            </Badge>
          </div>
          <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />
        </button>
      ) : (
        <div className="text-xs text-muted-foreground py-1" data-testid="no-agent">
          No agent assigned
        </div>
      )}

      {/* Status + runs */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <div className="flex min-w-0 items-center gap-1.5">
          <div
            className={`h-2 w-2 rounded-full ${isRunning ? "bg-green-500 animate-pulse" : "bg-muted-foreground/40"}`}
          />
          <span className="min-w-0 truncate">{isRunning ? "Running" : "Idle"}</span>
        </div>
        <span className="shrink-0">{totalRuns} run{totalRuns !== 1 ? "s" : ""}</span>
      </div>

      {assignedAgent && !activeRun && (
        <Button
          type="button"
          size="sm"
          variant="default"
          className="h-7 w-full text-xs"
          onClick={() => wakeAgent.mutate(assignedAgent.id)}
          disabled={wakeAgent.isPending}
        >
          <Play className="mr-1.5 h-3.5 w-3.5" />
          Wake agent
        </Button>
      )}

      {/* Blockers */}
      {isBlocked && blockingTasks.length > 0 && (
        <div className="min-w-0 space-y-1 overflow-hidden" data-testid="blockers-list">
          <div className="flex min-w-0 items-center gap-1 text-xs font-medium text-amber-600">
            <AlertTriangle className="h-3 w-3" />
            Blocked by
          </div>
          {blockingTasks.map((b) => (
            <div key={b.id} className="text-xs text-muted-foreground pl-4 truncate">
              {b.title}
            </div>
          ))}
        </div>
      )}

      {/* Upstream dependency outputs (absorbed from ContextSection) */}
      {completedUpstream.length > 0 && (
        <div className="min-w-0 space-y-1 overflow-hidden" data-testid="upstream-deps">
          <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
            Dependency Outputs
          </div>
          {completedUpstream.map((dep) => (
            <UpstreamDep
              key={dep.dependencyIssueId ?? dep.id}
              issueId={dep.dependencyIssueId ?? dep.id}
              title={dep.title}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function UpstreamDep({ issueId, title }: { issueId: string; title: string }) {
  const { data: artifact } = useQuery({
    queryKey: queryKeys.artifacts.byIssue(issueId),
    queryFn: () => artifactsApi.getByIssueId(issueId),
  });

  return (
    <div className="flex min-w-0 items-center gap-2 overflow-hidden py-0.5 text-xs" data-testid="upstream-dep">
      <ArrowDown className="h-3 w-3 text-muted-foreground shrink-0" />
      <span className="min-w-0 truncate">{title}</span>
      {artifact && (
        <span className="min-w-0 truncate text-muted-foreground">
          ({artifact.title} v{artifact.versions[0]?.versionNumber ?? 0})
        </span>
      )}
    </div>
  );
}
