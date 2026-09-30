/**
 * InlineArtifactCard — renders an entry's attachments inline.
 *
 * Each attachment is a small clickable card showing artifact type + title.
 * Used by EntryRow when an entry has attachments[]. Click → onOpen(artifactId).
 * Attachments without an artifactId (asset-only uploads) render with a generic
 * "File" label and a non-clickable presentation (the asset is still surfaced
 * elsewhere by the asset viewer).
 */
import { useState } from "react";
import { FileText, FileCode2, Image as ImageIcon, FileBox, FileQuestion } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/format";
import { resolveViewer } from "@/components/viewers/viewer-registry";
import { SharedContentViewer } from "@/components/viewers/SharedContentViewer";
import { isInlinePreviewable, normalizeMime, INLINE_IMAGE_TYPES } from "@/lib/inline-preview";
import type { DiscussionEntryAttachment } from "../../api/discussions";

export { isInlinePreviewable } from "@/lib/inline-preview";

interface InlineArtifactCardProps {
  attachments: DiscussionEntryAttachment[];
  onOpen?: (attachment: DiscussionEntryAttachment) => void;
  /** Artifact Lifecycle P1: founder-gated archive/unarchive actions per attachment. */
  canManage?: boolean;
  onArchiveArtifact?: (artifactId: string) => void | Promise<void>;
  onUnarchiveArtifact?: (artifactId: string) => void | Promise<void>;
}

const TYPE_LABEL: Record<string, string> = {
  document: "Document",
  presentation: "Presentation",
  code: "Code",
  design: "Design",
  report: "Report",
  other: "Artifact",
};

function iconFor(type: string | null) {
  switch (type) {
    case "code":
      return FileCode2;
    case "design":
      return ImageIcon;
    case "document":
    case "report":
      return FileText;
    case "presentation":
      return FileBox;
    default:
      return FileQuestion;
  }
}

function fileMetaFor(a: DiscussionEntryAttachment): { filename: string; contentType: string | null; byteSize: number | null; assetId: string } | null {
  if (a.currentVersionStorageKind === "asset" && a.currentVersionAssetId) {
    return { filename: a.currentVersionFilename ?? a.artifactTitle ?? "file", contentType: a.currentVersionContentType ?? null, byteSize: a.currentVersionByteSize ?? null, assetId: a.currentVersionAssetId };
  }
  if (a.assetId) {
    return { filename: a.assetOriginalFilename ?? "file", contentType: a.assetContentType ?? null, byteSize: a.assetByteSize ?? null, assetId: a.assetId };
  }
  return null;
}

function iconForContentType(contentType: string | null) {
  if (!contentType) return FileBox;
  if (contentType.startsWith("image/")) return ImageIcon;
  if (contentType === "application/pdf" || contentType.startsWith("text/")) return FileText;
  if (contentType.includes("zip") || contentType.includes("octet-stream")) return FileBox;
  return FileText;
}

/**
 * Artifact Lifecycle P1: founder-gated archive/unarchive control rendered
 * underneath an attachment whose artifactId is known. Local busy/error state
 * keeps the row responsive while the mutation runs.
 */
function ArtifactActions({
  artifactId, status, onArchive, onUnarchive,
}: {
  artifactId: string;
  status: string | null | undefined;
  onArchive?: (id: string) => void | Promise<void>;
  onUnarchive?: (id: string) => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const archived = status === "archived";
  const active = status === "active";
  async function run(fn: ((id: string) => void | Promise<void>) | undefined) {
    if (!fn) return;
    setBusy(true); setError(null);
    try { await fn(artifactId); } catch { setError("Action failed."); } finally { setBusy(false); }
  }
  if (!archived && !active) return null;
  return (
    <div className="flex items-center gap-2">
      {archived ? (
        <button type="button" disabled={busy} onClick={() => run(onUnarchive)} className="text-[11px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-50" data-testid="artifact-unarchive">Unarchive</button>
      ) : (
        <button type="button" disabled={busy} onClick={() => run(onArchive)} className="text-[11px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-50" data-testid="artifact-archive">Archive</button>
      )}
      {error ? <span className="text-[11px] text-amber-600" data-testid="artifact-action-error">{error}</span> : null}
    </div>
  );
}

export function InlineArtifactCard({
  attachments,
  onOpen,
  canManage,
  onArchiveArtifact,
  onUnarchiveArtifact,
}: InlineArtifactCardProps) {
  if (attachments.length === 0) return null;
  return (
    <div
      className="flex flex-col gap-1.5"
      data-testid="inline-artifact-card"
    >
      {attachments.map((a) => {
        // Artifact Lifecycle P1: founder-only archive/unarchive row, shown under
        // an attachment that maps to a known artifact.
        const actions =
          canManage && a.artifactId ? (
            <ArtifactActions
              artifactId={a.artifactId}
              status={a.artifactStatus}
              onArchive={onArchiveArtifact}
              onUnarchive={onUnarchiveArtifact}
            />
          ) : null;

        const file = fileMetaFor(a);
        if (file) {
          const FileIcon = iconForContentType(file.contentType);
          const showPreview = isInlinePreviewable(file.contentType, file.byteSize);
          const isImagePreview = INLINE_IMAGE_TYPES.has(normalizeMime(file.contentType) ?? "");
          return (
            <div key={a.id} className="flex flex-col gap-1">
              {showPreview ? (
                <div
                  className="max-h-72 overflow-auto rounded-md border border-border"
                  data-testid="attachment-inline-preview"
                >
                  {isImagePreview ? (
                    <img
                      src={`/api/assets/${file.assetId}/content`}
                      alt={file.filename}
                      loading="lazy"
                      className="max-h-72 w-auto"
                    />
                  ) : (
                    <SharedContentViewer
                      viewer={resolveViewer({
                        contentType: file.contentType,
                        filename: file.filename,
                        assetId: file.assetId,
                        assetUrl: `/api/assets/${file.assetId}/content`,
                      })}
                      filename={file.filename}
                    />
                  )}
                </div>
              ) : null}
              <div
                className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-left"
                data-testid="artifact-file-chip"
              >
                <FileIcon className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
                {onOpen ? (
                  <button
                    type="button"
                    onClick={() => onOpen(a)}
                    className="flex-1 min-w-0 truncate text-sm text-foreground text-left hover:underline"
                    data-testid={`inline-artifact-card-${a.id}`}
                  >
                    {file.filename}
                  </button>
                ) : (
                  <span
                    className="flex-1 min-w-0 truncate text-sm text-foreground"
                    data-testid={`inline-artifact-card-${a.id}`}
                  >
                    {file.filename}
                  </span>
                )}
                {file.byteSize ? (
                  <span className="shrink-0 text-[11px] text-muted-foreground/70">{formatBytes(file.byteSize)}</span>
                ) : null}
                <a
                  href={`/api/assets/${file.assetId}/content`}
                  download={file.filename}
                  className="shrink-0 text-[11px] font-semibold text-primary hover:underline"
                  data-testid="artifact-download"
                  aria-label={`Download ${file.filename}`}
                >
                  Download
                </a>
              </div>
              {actions}
            </div>
          );
        }

        const Icon = iconFor(a.artifactType);
        const label = a.artifactType ? TYPE_LABEL[a.artifactType] ?? a.artifactType : "File";
        const title = a.artifactTitle ?? a.assetOriginalFilename ?? (a.assetId ? "Attached file" : "Artifact");
        const clickable = (!!a.artifactId || !!a.assetId) && !!onOpen;
        const className = cn(
          "flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-left",
          clickable && "hover:bg-muted/50 transition-colors cursor-pointer",
        );
        const inner = (
          <>
            <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="flex-1 min-w-0 truncate text-sm text-foreground">{title}</span>
            <span className="shrink-0 text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/70">
              {label}
            </span>
          </>
        );
        return (
          <div key={a.id} className="flex flex-col gap-1">
            {clickable ? (
              <button
                type="button"
                onClick={() => onOpen!(a)}
                className={className}
                data-testid={`inline-artifact-card-${a.id}`}
              >
                {inner}
              </button>
            ) : (
              <div
                className={className}
                data-testid={`inline-artifact-card-${a.id}`}
              >
                {inner}
              </div>
            )}
            {actions}
          </div>
        );
      })}
    </div>
  );
}
