import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn, relativeTime } from "@/lib/utils";
import { formatDuration } from "./workspace-utils";
import { formatDuration as formatDurationMs } from "../../lib/run-status";
import type { RunForIssue } from "../../api/activity";
import { StructuredRunBlock } from "./transcript";
import type { DepartmentType } from "./transcript/types";

interface TimelineAgentMessageProps {
  run: RunForIssue;
  agentName: string;
  isLatest?: boolean;
  compact?: boolean;
  adapterType?: string;
  departmentType?: string;
  onActivity?: () => void;
}

export function TimelineAgentMessage({
  run,
  agentName,
  isLatest = false,
  compact = false,
  adapterType = "process",
  departmentType = "general",
  onActivity,
}: TimelineAgentMessageProps) {
  const isRunning = run.status === "running" || run.status === "in_progress";
  const nowMs = useTicker(isRunning);
  const duration = formatDuration(run.startedAt, run.finishedAt, nowMs);
  const hasLogMetadata = run.logStore !== undefined || run.logRef !== undefined;
  const runLogAvailable = hasLogMetadata
    ? Boolean(run.logStore && run.logRef)
    : undefined;
  const actionLabel = isRunning
    ? "Working for"
    : run.status === "failed"
      ? "Failed after"
      : "Worked for";
  const boundaryLabel = duration ? `${actionLabel} ${duration}` : actionLabel;
  const hasWaitAccounting =
    (run.humanQuestionWaitMs ?? 0) > 0 || (run.runtimePermissionWaitMs ?? 0) > 0;

  return (
    <div
      className={cn("group/run min-w-0", compact && "text-sm")}
      data-testid={`timeline-agent-msg-${run.runId}`}
    >
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 border-b border-border px-1 pb-2 pt-1 text-left text-sm text-muted-foreground"
        aria-expanded="true"
      >
        <span className="truncate">{boundaryLabel}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
        <span className="sr-only">Run by {agentName}</span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground/70">
          {relativeTime(run.startedAt ?? run.createdAt)}
        </span>
      </button>

      {(run.activeExecutionMs != null || hasWaitAccounting) && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 px-1 pt-2 text-[11px] text-muted-foreground">
          {run.activeExecutionMs != null && (
            <span>Active: {formatDurationMs(run.activeExecutionMs)}</span>
          )}
          {(run.humanQuestionWaitMs ?? 0) > 0 && (
            <span>Human wait: {formatDurationMs(run.humanQuestionWaitMs)}</span>
          )}
          {(run.runtimePermissionWaitMs ?? 0) > 0 && (
            <span>Permission wait: {formatDurationMs(run.runtimePermissionWaitMs)}</span>
          )}
        </div>
      )}

      <div className="py-3">
        <StructuredRunBlock
          runId={run.runId}
          adapterType={adapterType}
          departmentType={departmentType as DepartmentType}
          isRunning={isRunning}
          isLatest={isLatest}
          compact={compact}
          runLogAvailable={runLogAvailable}
          onActivity={onActivity}
        />
      </div>
    </div>
  );
}

function useTicker(enabled: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [enabled]);

  return nowMs;
}
