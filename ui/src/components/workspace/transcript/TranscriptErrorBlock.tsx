// ui/src/components/workspace/transcript/TranscriptErrorBlock.tsx

import { useState } from "react";
import { cn } from "@/lib/utils";
import { ChevronRight, ChevronDown, AlertCircle } from "lucide-react";

interface TranscriptErrorBlockProps {
  lines: Array<{ ts: string; text: string }>;
  className?: string;
}

export function TranscriptErrorBlock({ lines, className }: TranscriptErrorBlockProps) {
  const [expanded, setExpanded] = useState(lines.length <= 3);

  return (
    <div className={cn("border-l-2 border-l-red-500 bg-red-500/5 rounded-r-lg", className)}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 px-3 h-9 w-full text-left text-xs"
      >
        <AlertCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />
        <span className="text-red-500/80">Error details ({lines.length} line{lines.length !== 1 ? "s" : ""})</span>
        {expanded ? <ChevronDown className="h-3 w-3 text-muted-foreground ml-auto" /> : <ChevronRight className="h-3 w-3 text-muted-foreground ml-auto" />}
      </button>
      {expanded && (
        <div className="px-3 pb-2 font-mono text-xs text-red-400/80 max-h-[200px] overflow-auto whitespace-pre-wrap">
          {lines.map((line, i) => (
            <div key={i}>{line.text}</div>
          ))}
        </div>
      )}
    </div>
  );
}
