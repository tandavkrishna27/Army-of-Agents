// ui/src/components/workspace/transcript/TranscriptThinkingBlock.tsx

import { useState } from "react";
import { cn } from "@/lib/utils";
import { ChevronRight, ChevronDown } from "lucide-react";

interface TranscriptThinkingBlockProps {
  text: string;
  streaming: boolean;
  /** If true, this is from a previous turn and should be collapsed */
  isPreviousTurn?: boolean;
  className?: string;
}

export function TranscriptThinkingBlock({
  text,
  streaming,
  isPreviousTurn = false,
  className,
}: TranscriptThinkingBlockProps) {
  const [expanded, setExpanded] = useState(!isPreviousTurn && streaming);

  if (isPreviousTurn && !expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className={cn(
          "flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground hover:text-foreground/60 transition-colors",
          className,
        )}
        aria-label="Expand thinking"
      >
        <span className="h-2 w-2 rounded-full bg-muted-foreground/40" />
        <span>Thinking</span>
        <ChevronRight className="h-3 w-3" />
      </button>
    );
  }

  return (
    <div className={cn("rounded-lg bg-muted/20 p-3", className)}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground/60 mb-1"
      >
        {streaming ? (
          <span className="text-muted-foreground animate-pulse">Thinking...</span>
        ) : (
          <>
            <span>Thinking</span>
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </>
        )}
      </button>
      {(expanded || streaming) && (
        <p className="text-xs text-muted-foreground/80 italic whitespace-pre-wrap max-h-[200px] overflow-auto">
          {text}
        </p>
      )}
    </div>
  );
}
