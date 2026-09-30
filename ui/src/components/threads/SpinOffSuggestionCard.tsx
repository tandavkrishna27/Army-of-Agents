/**
 * SpinOffSuggestionCard — Adjutant's inline "Want a new thread for X?" CTA.
 *
 * Rendered when the Router (Adjutant) detects that a sub-topic deserves its own
 * thread. The card shows the topic summary + rationale + Accept/Dismiss buttons.
 * In the DB this lives as a system-input-type entry whose sourceInfo carries
 * a spin_off_suggestion payload (the EntryRow renderer routes such entries here
 * when the payload is present).
 */
import { GitFork, X, Check } from "lucide-react";

export interface SpinOffSuggestion {
  topicSummary: string;
  rationale: string;
}

interface SpinOffSuggestionCardProps {
  suggestion: SpinOffSuggestion;
  onAccept: () => void;
  onDismiss: () => void;
}

export function SpinOffSuggestionCard({
  suggestion,
  onAccept,
  onDismiss,
}: SpinOffSuggestionCardProps) {
  return (
    <div
      className="rounded-lg border border-teal-500/30 bg-teal-500/5 p-3 flex flex-col gap-2"
      data-testid="spinoff-suggestion-card"
    >
      <div className="flex items-center gap-2">
        <GitFork className="h-4 w-4 text-teal-400" />
        <span className="text-[10px] uppercase tracking-wider font-bold text-teal-300">
          Want a new thread for this?
        </span>
      </div>
      <p
        className="text-sm font-medium text-foreground/90"
        data-testid="spinoff-suggestion-summary"
      >
        {suggestion.topicSummary}
      </p>
      <p
        className="text-xs text-muted-foreground"
        data-testid="spinoff-suggestion-rationale"
      >
        {suggestion.rationale}
      </p>
      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={onAccept}
          className="inline-flex items-center gap-1.5 rounded-md bg-teal-500/15 px-3 py-1.5 text-xs font-medium text-teal-300 hover:bg-teal-500/25 transition-colors"
          data-testid="spinoff-suggestion-accept"
        >
          <Check className="h-3 w-3" />
          Yes, spin it off
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="inline-flex items-center gap-1.5 rounded-md bg-muted/60 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          data-testid="spinoff-suggestion-dismiss"
        >
          <X className="h-3 w-3" />
          No thanks
        </button>
      </div>
    </div>
  );
}
