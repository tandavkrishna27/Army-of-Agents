// ui/src/components/workspace/transcript/TranscriptStdoutBlock.tsx

import { useState } from "react";
import { cn } from "@/lib/utils";
import { ChevronRight, ChevronDown, FileOutput } from "lucide-react";

interface TranscriptStdoutBlockProps {
  text: string;
  className?: string;
}

export function TranscriptStdoutBlock({ text, className }: TranscriptStdoutBlockProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={cn("", className)}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 px-3 h-8 text-xs text-muted-foreground hover:text-foreground/60 transition-colors"
      >
        <FileOutput className="h-3.5 w-3.5" />
        <span>Raw output</span>
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      </button>
      {expanded && (
        <div className="mx-3 mb-2 p-2 rounded-md bg-muted/20 font-mono text-xs text-foreground/70 max-h-[200px] overflow-auto whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  );
}
