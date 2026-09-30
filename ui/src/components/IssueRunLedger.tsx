import { Link } from "react-router-dom";
import type { DetectedOutput } from "@armyofagents/shared";
import { RotateCcw } from "lucide-react";
import { StatusBadge } from "./StatusBadge";
import { cn, formatDateTime } from "../lib/utils";
import { getRunRetryState, type RetryRunLike } from "../lib/runRetryState";

export interface IssueRunLedgerItem extends RetryRunLike {
  runId: string;
  agentId: string;
  createdAt: Date | string;
  startedAt: Date | string | null;
  finishedAt?: Date | string | null;
  invocationSource?: string;
  usageJson?: Record<string, unknown> | null;
  resultJson?: Record<string, unknown> | null;
  detectedOutputs?: DetectedOutput[] | null;
}

const retryToneClass = {
  warning: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  danger: "border-destructive/30 bg-destructive/10 text-destructive",
  muted: "border-border bg-muted/40 text-muted-foreground",
} as const;

export function IssueRunLedger({ runs }: { runs: IssueRunLedgerItem[] }) {
  if (runs.length === 0) {
    return <p className="text-sm text-muted-foreground">No runs yet.</p>;
  }

  return (
    <div className="space-y-2">
      {runs.map((run) => {
        const retryState = getRunRetryState(run);
        return (
          <div key={run.runId} className="border border-border bg-accent/20 p-3 overflow-hidden min-w-0 rounded-sm">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2 text-xs">
                <span className="text-muted-foreground">Run</span>
                <Link
                  to={`/agents/${run.agentId}/runs/${run.runId}`}
                  className="inline-flex items-center rounded-md border border-border bg-accent/40 px-2 py-1 font-mono text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
                >
                  {run.runId.slice(0, 8)}
                </Link>
                <StatusBadge status={run.status} />
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatDateTime(run.startedAt ?? run.createdAt)}
              </span>
            </div>
            {retryState ? (
              <div
                className={cn(
                  "mt-2 inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs",
                  retryToneClass[retryState.tone],
                )}
              >
                <RotateCcw className="h-3 w-3 shrink-0" />
                <span className="font-medium">{retryState.label}</span>
                {retryState.detail ? <span className="text-muted-foreground">{retryState.detail}</span> : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
