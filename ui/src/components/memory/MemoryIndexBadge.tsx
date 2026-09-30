import { CheckCircle2, Loader2, AlertTriangle, Circle } from "lucide-react";
import type { MemoryIndexStatus } from "@armyofagents/shared";
import { cn } from "@/lib/utils";

interface Props {
  status: MemoryIndexStatus;
  onReindex?: () => void;
  className?: string;
}

export function MemoryIndexBadge({ status, onReindex, className }: Props) {
  if (status === "indexed") {
    return (
      <span
        data-testid="memory-index-status"
        className={cn(
          "inline-flex items-center gap-1 rounded px-1.5 py-0.5",
          "border border-border bg-white/[0.04]",
          "text-[10px] leading-[14px] font-medium text-muted-foreground whitespace-nowrap",
          className,
        )}
      >
        <CheckCircle2 className="size-2.5 text-[var(--data-green)]" aria-hidden />
        <span>Indexed</span>
      </span>
    );
  }

  if (status === "pending") {
    return (
      <span
        data-testid="memory-index-status"
        className={cn(
          "inline-flex items-center gap-1 rounded px-1.5 py-0.5",
          "border border-border bg-white/[0.04]",
          "text-[10px] leading-[14px] font-medium text-muted-foreground whitespace-nowrap",
          className,
        )}
      >
        <Loader2 className="size-2.5 animate-spin text-[var(--data-amber)]" aria-hidden />
        <span>Indexing…</span>
      </span>
    );
  }

  if (status === "failed") {
    return (
      <span
        data-testid="memory-index-status"
        className={cn(
          "inline-flex items-center gap-1 rounded px-1.5 py-0.5",
          "border border-border bg-white/[0.04]",
          "text-[10px] leading-[14px] font-medium whitespace-nowrap",
          className,
        )}
      >
        <AlertTriangle className="size-2.5 text-[var(--data-amber)]" aria-hidden />
        <span className="text-[var(--data-amber)]">Failed</span>
        {onReindex && (
          <button
            type="button"
            data-testid="memory-reindex-button"
            onClick={(e) => {
              e.stopPropagation();
              onReindex();
            }}
            className={cn(
              "ml-0.5 rounded px-1 py-px",
              "text-[10px] leading-[14px] font-medium text-muted-foreground",
              "border border-border hover:bg-white/[0.08] hover:text-foreground",
              "transition-colors",
            )}
          >
            Re-index
          </button>
        )}
      </span>
    );
  }

  // not_indexed
  return (
    <span
      data-testid="memory-index-status"
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5",
        "border border-border bg-white/[0.04]",
        "text-[10px] leading-[14px] font-medium text-very-dim whitespace-nowrap",
        className,
      )}
    >
      <Circle className="size-2.5" aria-hidden />
      <span>Not indexed</span>
    </span>
  );
}
