import { useQuery } from "@tanstack/react-query";
import { activityApi, type RunForIssue } from "../../../api/activity";
import { queryKeys } from "../../../lib/queryKeys";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, relativeTime } from "@/lib/utils";
import { GitBranch, Copy } from "lucide-react";
import { formatDuration, RunStatusIcon } from "../workspace-utils";
import type { ExecutionWorkspace } from "@armyofagents/shared";

interface LogsContextSectionProps {
  issueId: string;
  workspace: ExecutionWorkspace;
  selectedRunId?: string | null;
  onSelectRun?: (runId: string) => void;
}

export function LogsContextSection({
  issueId,
  workspace,
  selectedRunId,
  onSelectRun,
}: LogsContextSectionProps) {
  const { data: runs, isLoading } = useQuery({
    queryKey: queryKeys.issues.runs(issueId),
    queryFn: () => activityApi.runsForIssue(issueId),
  });

  if (isLoading) {
    return (
      <div className="space-y-1.5 px-3" data-testid="logs-context-skeleton">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="logs-context-section">
      {/* Git branch info */}
      {workspace.branchName && (
        <div className="px-3 py-1.5 flex items-center gap-2 text-xs">
          <GitBranch className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <code className="flex-1 font-mono text-[11px] truncate">{workspace.branchName}</code>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => navigator.clipboard.writeText(workspace.branchName!)}
            title="Copy branch name"
          >
            <Copy className="h-3 w-3" />
          </button>
        </div>
      )}
      {workspace.baseRef && (
        <div className="px-3 text-[10px] text-muted-foreground -mt-1">
          from <code className="font-mono">{workspace.baseRef}</code>
        </div>
      )}

      {/* Run list */}
      {(!runs || runs.length === 0) ? (
        <div className="px-3 py-2 text-xs text-muted-foreground" data-testid="logs-context-no-runs">
          No runs yet
        </div>
      ) : (
        <div className="flex flex-col" data-testid="logs-context-run-list">
          {runs.slice(0, 15).map((run) => {
            const isActive = selectedRunId === run.runId;
            const duration = formatDuration(run.startedAt, run.finishedAt);
            return (
              <button
                key={run.runId}
                type="button"
                className={cn(
                  "flex items-center gap-2 px-3 py-1.5 text-left hover:bg-accent/50 transition-colors",
                  isActive && "bg-accent/30",
                )}
                onClick={() => onSelectRun?.(run.runId)}
                data-testid="logs-context-run"
              >
                <RunStatusIcon status={run.status} />
                <span className="text-[11px] text-muted-foreground shrink-0">
                  {run.runId.slice(0, 6)}
                </span>
                {duration && (
                  <span className="text-[10px] text-muted-foreground">{duration}</span>
                )}
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {relativeTime(run.startedAt ?? run.createdAt)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
