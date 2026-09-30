import { useId, useEffect, useState } from "react";
import { ChevronRight, ChevronDown } from "lucide-react";

export function CommanderReasoningBlock({
  text,
  streaming,
  defaultCollapsed = false,
}: { text: string; streaming: boolean; defaultCollapsed?: boolean }) {
  // REVIEW FIX (Lens C major): prop-driven collapse. The SAME instance persists
  // across the streaming→settled flip (no remount), so a mount-only initializer
  // never auto-collapses. Expand while streaming; collapse once settled / on reload.
  const [expanded, setExpanded] = useState(streaming && !defaultCollapsed);
  const contentId = useId();
  useEffect(() => {
    setExpanded(streaming && !defaultCollapsed);
  }, [streaming, defaultCollapsed]);
  if (!text.trim()) return null;
  return (
    <div className="mb-2 rounded-lg bg-muted/20 p-2" data-testid="commander-reasoning">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={contentId}
        aria-label="Show reasoning"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground/60"
      >
        {streaming ? (
          <span className="animate-pulse">Thinking…</span>
        ) : (
          <>
            <span>Thinking</span>
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </>
        )}
      </button>
      {(expanded || streaming) && (
        <p
          id={contentId}
          className="mt-1 max-h-[200px] overflow-auto whitespace-pre-wrap text-xs italic text-muted-foreground/80"
        >
          {text}
        </p>
      )}
    </div>
  );
}
