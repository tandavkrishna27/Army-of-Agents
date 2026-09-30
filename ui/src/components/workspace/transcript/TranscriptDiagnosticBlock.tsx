import { useState } from "react";
import { ChevronDown, ChevronRight, Info } from "lucide-react";
import { cn } from "@/lib/utils";

interface TranscriptDiagnosticBlockProps {
  lines: Array<{ ts: string; text: string }>;
  className?: string;
}

export function TranscriptDiagnosticBlock({ lines, className }: TranscriptDiagnosticBlockProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={cn("rounded-lg border border-border/60 bg-muted/20", className)}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex h-8 w-full items-center gap-2 px-3 text-left text-xs text-muted-foreground"
      >
        <Info className="h-3.5 w-3.5 shrink-0" />
        <span>Diagnostics ({lines.length} line{lines.length !== 1 ? "s" : ""})</span>
        {expanded ? (
          <ChevronDown className="ml-auto h-3 w-3" />
        ) : (
          <ChevronRight className="ml-auto h-3 w-3" />
        )}
      </button>
      {expanded && (
        <div className="max-h-[180px] overflow-auto whitespace-pre-wrap px-3 pb-2 font-mono text-xs text-muted-foreground/80">
          {lines.map((line, i) => (
            <div key={i}>{line.text}</div>
          ))}
        </div>
      )}
    </div>
  );
}
