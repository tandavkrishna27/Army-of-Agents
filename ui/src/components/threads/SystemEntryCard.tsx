/**
 * SystemEntryCard — render for entries with inputType='system'.
 *
 * Used for crew/agent failure messages with retry affordances. The warning
 * icon + amber tint distinguish it from regular human/agent entries. When
 * onRetry is supplied a Retry button is rendered.
 */
import { AlertTriangle, RotateCcw } from "lucide-react";
import { relativeTime } from "@/lib/utils";
import type { DiscussionEntry } from "../../api/discussions";

interface SystemEntryCardProps {
  entry: DiscussionEntry;
  onRetry?: () => void;
}

export function SystemEntryCard({ entry, onRetry }: SystemEntryCardProps) {
  return (
    <div
      className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 flex items-start gap-3"
      data-testid="system-entry-card"
      data-entry-id={entry.id}
    >
      <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] uppercase tracking-wider font-bold text-amber-300">
            System
          </span>
          <span className="text-[11px] text-muted-foreground/70">
            {relativeTime(entry.createdAt)}
          </span>
        </div>
        <p
          className="mt-1 text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap break-words"
          data-testid="system-entry-card-message"
        >
          {entry.rawContent}
        </p>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-300 hover:bg-amber-500/20 transition-colors"
          data-testid="system-entry-card-retry"
        >
          <RotateCcw className="h-3 w-3" />
          Retry
        </button>
      )}
    </div>
  );
}
