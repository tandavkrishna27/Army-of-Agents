// Chip row under assistant bubbles. Chips are handles, not
// previews — click opens the ref in the viewer panel.
import { FileText } from "lucide-react";
import type { ShowRef } from "@armyofagents/shared";
import { cn } from "@/lib/utils";
import { chipLabel } from "./commanderViewerModel";

interface OutputRefChipsProps {
  refs: ShowRef[];
  onOpen: (ref: ShowRef) => void;
}

export function OutputRefChips({ refs, onOpen }: OutputRefChipsProps) {
  if (refs.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5" data-testid="output-ref-chips">
      {refs.map((ref) => (
        <button
          key={`${ref.v}|${ref.kind}|${ref.id}|${ref.versionId ?? "latest"}`}
          type="button"
          onClick={() => onOpen(ref)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors",
            ref.action === "created"
              ? "border-primary/40 bg-primary/5 text-primary hover:bg-primary/10"
              : "border-border bg-muted/40 text-foreground hover:bg-muted",
          )}
        >
          <FileText className="h-3 w-3 shrink-0" />
          <span className="max-w-[220px] truncate font-medium">{chipLabel(ref)}</span>
          {typeof ref.versionNumber === "number" && (
            <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
              v{ref.versionNumber}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
