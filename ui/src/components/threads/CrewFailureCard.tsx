import { AlertTriangle, RefreshCw, UserCog, SkipForward } from "lucide-react";

export interface CrewFailurePayload {
  issueId: string;
  agentName: string;
  taskTitle: string;
  error: string;
}

interface CrewFailureCardProps {
  payload: CrewFailurePayload;
  onRetry: () => void;
  onReassign: () => void;
  onSkip: () => void;
}

export function CrewFailureCard({
  payload,
  onRetry,
  onReassign,
  onSkip,
}: CrewFailureCardProps) {
  return (
    <div
      className="rounded-lg border border-red-500/30 bg-card/40 p-4 flex flex-col gap-3"
      data-testid="crew-failure-card"
    >
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-red-400" />
        <span className="text-sm font-semibold text-foreground">Task failed</span>
        <span
          className="ml-auto text-xs text-muted-foreground truncate max-w-[50%]"
          title={payload.taskTitle}
        >
          {payload.taskTitle}
        </span>
      </div>
      <p className="text-sm text-foreground/80">
        <span className="font-medium">{payload.agentName}</span> couldn't complete this
        task.
      </p>
      {payload.error && (
        <p
          className="text-xs text-muted-foreground font-mono bg-background/40 rounded px-2 py-1.5 line-clamp-3 break-words"
          data-testid="crew-failure-error"
        >
          {payload.error}
        </p>
      )}
      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/15 px-3 py-1.5 text-sm font-medium text-emerald-300 hover:bg-emerald-500/25 transition-colors"
          data-testid="crew-failure-retry"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Retry
        </button>
        <button
          type="button"
          onClick={onReassign}
          className="inline-flex items-center gap-1.5 rounded-md bg-muted/60 px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          data-testid="crew-failure-reassign"
        >
          <UserCog className="h-3.5 w-3.5" />
          Reassign
        </button>
        <button
          type="button"
          onClick={onSkip}
          className="inline-flex items-center gap-1.5 rounded-md bg-muted/60 px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          data-testid="crew-failure-skip"
        >
          <SkipForward className="h-3.5 w-3.5" />
          Skip
        </button>
      </div>
    </div>
  );
}
