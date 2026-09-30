import { Brain } from "lucide-react";
import { cn } from "@/lib/utils";

interface MemoryContextStripProps {
  strictness: "strict" | "balanced" | "recall-heavy" | "precision-heavy";
  layers: string[];
  surface: string;
  hasWorkingContext?: boolean;
  className?: string;
}

export function MemoryContextStrip({
  strictness,
  layers,
  surface,
  hasWorkingContext = layers.includes("working"),
  className,
}: MemoryContextStripProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 border-b border-border bg-muted/35 px-3 py-1.5 text-[11px] text-muted-foreground",
        className,
      )}
    >
      <Brain className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="font-medium text-foreground">Memory</span>
      <span>{strictness}</span>
      <span aria-hidden="true">/</span>
      <span>{surface}</span>
      <span aria-hidden="true">/</span>
      <span className="truncate">{layers.join(", ")}</span>
      {hasWorkingContext && (
        <span className="ml-auto rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-foreground">
          working
        </span>
      )}
    </div>
  );
}
