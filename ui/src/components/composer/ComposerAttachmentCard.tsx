import { FileText, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type ComposerAttachmentState = "uploading" | "ready" | "failed";

export interface ComposerAttachmentCardProps {
  name: string;
  /** Optional: the artifact-upload path carries no size — omit rather than fake. */
  byteSize?: number;
  state: ComposerAttachmentState;
  /** Image thumbnail (object URL) when available. */
  previewUrl?: string;
  onRemove: () => void;
  /** Failed uploads offer Retry only when the host retained the File to retry. */
  onRetry?: () => void;
  /** Override for hosts with load-bearing legacy testids. */
  "data-testid"?: string;
}

/** Compact human size: 412 KB / 1.5 MB (1 decimal for MB, none for KB). */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Board-accurate attachment card (Quiet Operator): thumbnail/type icon,
 * filename, compact size, state, Retry (failed, when retryable), Remove.
 * Lives INSIDE the ComposerFrame tray — never a detached panel.
 */
export function ComposerAttachmentCard({
  name,
  byteSize,
  state,
  previewUrl,
  onRemove,
  onRetry,
  "data-testid": testId,
}: ComposerAttachmentCardProps) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]",
        state === "failed"
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-border bg-muted/40 text-foreground",
      )}
      data-testid={testId ?? `composer-attachment-${name}`}
      data-state={state}
    >
      {previewUrl ? (
        <img src={previewUrl} alt="" className="h-6 w-6 rounded object-cover" />
      ) : state === "uploading" ? (
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden="true" />
      ) : (
        <FileText className="h-3 w-3 shrink-0" aria-hidden="true" />
      )}
      <span className="min-w-0 truncate max-w-[160px]">{name}</span>
      {byteSize !== undefined && (
        <span className="shrink-0 text-muted-foreground">{formatBytes(byteSize)}</span>
      )}
      <span
        className={cn(
          "shrink-0",
          state === "failed" ? "font-medium" : "text-muted-foreground",
        )}
        role="status"
      >
        {state === "uploading" ? "Uploading…" : state === "failed" ? "Failed to upload" : "Ready"}
      </span>
      {state === "failed" && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 rounded px-1 font-medium hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-focus-ring"
        >
          Retry
        </button>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${name}`}
        className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-focus-ring"
      >
        <X className="h-3 w-3" aria-hidden="true" />
      </button>
    </span>
  );
}
