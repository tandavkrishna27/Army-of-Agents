import { useState } from "react";
import { cn } from "@/lib/utils";
import { ChevronRight, ChevronDown, AlertCircle } from "lucide-react";

interface ThreadErrorBannerProps {
  /** The thread's coordination-level error (`DiscussionDetail.lastError`). Renders nothing when falsy. */
  error: string | null | undefined;
  /** Reserved for future detail (consecutiveCommitFailures); not rendered yet. */
  consecutiveFailures?: number;
  className?: string;
}

/**
 * PR-A2: surfaces a thread's coordination-level error to the founder. The controller records it on
 * `thread_orchestration_state.lastError` (commit failure / circuit-breaker / runner throw) and clears
 * it on the next successful run — so this banner self-clears on recovery (it renders nothing when
 * `error` is falsy). The raw internal error is hidden behind a "Show details" expander so a
 * non-technical founder sees a plain-language headline first. Mirrors `TranscriptErrorBlock`.
 */
export function ThreadErrorBanner({ error, consecutiveFailures: _consecutiveFailures, className }: ThreadErrorBannerProps) {
  const [expanded, setExpanded] = useState(false);
  if (!error) return null;

  return (
    <div
      data-testid="thread-error-banner"
      className={cn("border-l-2 border-l-red-500 bg-red-500/5 rounded-r-lg my-2 px-3 py-2", className)}
    >
      <div className="flex items-start gap-2">
        <AlertCircle className="h-3.5 w-3.5 text-red-500 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">An agent action on this thread didn't go through</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            The coordinator retried and paused after repeated failures. It will resume automatically on the next run.
          </div>
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="mt-1.5 flex items-center gap-1 text-xs text-red-500/80"
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Show details
          </button>
          {expanded && (
            <div className="mt-1.5 font-mono text-[11.5px] text-red-400/80 bg-muted rounded px-2 py-1.5 max-h-[200px] overflow-auto whitespace-pre-wrap">
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
