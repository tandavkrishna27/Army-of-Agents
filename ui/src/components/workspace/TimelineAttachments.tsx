import { Download, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { isInlineImage } from "@/lib/inline-preview";
import type { IssueAttachment } from "@armyofagents/shared";

interface TimelineAttachmentsProps {
  attachments: IssueAttachment[];
  testId: string;
  className?: string;
  /** Pop the attachment into a preview panel. Absent → open control is a direct link. */
  onOpen?: (att: IssueAttachment) => void;
}

export function TimelineAttachments({ attachments, testId, className, onOpen }: TimelineAttachmentsProps) {
  if (attachments.length === 0) return null;

  return (
    <div className={cn("mt-2 flex flex-col gap-2 not-prose", className)} data-testid={testId}>
      {attachments.map((attachment) => {
        const label = attachment.originalFilename ?? "Attachment";
        const assetUrl = `/api/assets/${attachment.assetId}/content`;
        const isImage = isInlineImage(attachment.contentType);

        return (
          <div
            key={attachment.id}
            className={cn(
              "flex min-w-0 flex-col gap-1.5 rounded-lg border border-border/70 bg-background/60 p-1.5 text-xs text-foreground",
              isImage ? "max-w-72" : "max-w-full",
            )}
          >
            {isImage && (
              <div data-testid={`attachment-inline-preview-${attachment.id}`} className="min-w-0">
                {onOpen ? (
                  <button
                    type="button"
                    data-testid={`attachment-image-open-${attachment.id}`}
                    onClick={() => onOpen(attachment)}
                    aria-label={`Open ${label}`}
                    className="block min-w-0 cursor-pointer border-0 bg-transparent p-0"
                  >
                    <img
                      src={assetUrl}
                      alt={label}
                      loading="lazy"
                      className="max-h-72 w-auto rounded-md border border-border"
                    />
                  </button>
                ) : (
                  <a
                    data-testid={`attachment-image-open-${attachment.id}`}
                    href={assetUrl}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Open ${label}`}
                    className="block min-w-0"
                  >
                    <img
                      src={assetUrl}
                      alt={label}
                      loading="lazy"
                      className="max-h-72 w-auto rounded-md border border-border"
                    />
                  </a>
                )}
              </div>
            )}
            <div className="flex min-w-0 items-center gap-2">
              {!isImage && (
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground">
                  <FileText className="h-3.5 w-3.5" />
                  <span className="sr-only">file</span>
                </span>
              )}
              {onOpen ? (
                <button
                  type="button"
                  data-testid={`attachment-open-${attachment.id}`}
                  onClick={() => onOpen(attachment)}
                  className="min-w-0 flex-1 truncate text-left text-foreground no-underline transition-colors hover:text-accent-foreground"
                >
                  {label}
                </button>
              ) : (
                <a
                  data-testid={`attachment-open-${attachment.id}`}
                  href={assetUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 truncate text-foreground no-underline transition-colors hover:text-accent-foreground"
                >
                  {label}
                </a>
              )}
              <a
                href={assetUrl}
                download
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border/70 text-muted-foreground transition-colors hover:bg-accent/20 hover:text-foreground"
                aria-label={`Download ${label}`}
              >
                <Download className="h-3.5 w-3.5" />
              </a>
            </div>
          </div>
        );
      })}
    </div>
  );
}
