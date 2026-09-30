// Shared, surface-agnostic "ref tab body" components.
//
// Extracted verbatim (behavior-preserving) from CommanderViewerPanel.tsx so that
// non-Commander surfaces (e.g. the Thread viewer) can reuse the same self-fetching
// bodies. Each body takes explicit primitive props ({ companyId, refId, ... }) and
// has NO dependency on the Commander viewer tab model — the caller maps its own
// tab into these props.
import { useQuery } from "@tanstack/react-query";
import { Brain, Globe, MessageSquare, Package } from "lucide-react";
import type { TaskOutput } from "@armyofagents/shared";
import { toSafeBrowserUrl } from "@armyofagents/shared";
import { Skeleton } from "@/components/ui/skeleton";
import { artifactsApi } from "@/api/artifacts";
import { assetsApi } from "@/api/assets";
import { taskOutputsApi } from "@/api/task-outputs";
import { memoryApi } from "@/api/memory";
import { discussionsApi } from "@/api/discussions";
import { SharedContentViewer } from "@/components/viewers/SharedContentViewer";
import {
  assetUrlForArtifactVersion,
  contentTypeForArtifactVersion,
  filenameForArtifactVersion,
} from "@/components/viewers/artifact-version-viewer";
import { resolveViewer } from "@/components/viewers/viewer-registry";

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export function LoadingBody() {
  return (
    <div className="flex flex-1 flex-col gap-3 overflow-hidden p-4" data-testid="commander-viewer-loading">
      <Skeleton className="h-5 w-2/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-4/5" />
    </div>
  );
}

export function UnavailableBody({ message }: { message: string }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}

// --- Artifact ---------------------------------------------------------------

export function ArtifactTabBody({
  refId,
  versionId,
}: {
  refId: string;
  versionId?: string | null;
}) {
  const {
    data: artifact,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["commander-viewer-artifact", refId],
    queryFn: () => artifactsApi.get(refId),
    enabled: Boolean(refId),
  });

  if (isLoading) return <LoadingBody />;

  if (isError || !artifact) {
    return (
      <UnavailableBody message="This item is no longer available (it may have been deleted, or you may not have access)." />
    );
  }

  // Pick the version by versionId match, else versions[0].
  const version =
    (versionId ? artifact.versions.find((v) => v.id === versionId) : null) ??
    artifact.versions[0] ??
    null;

  if (!version) {
    return <UnavailableBody message={`${artifact.title} has no versions yet.`} />;
  }

  const filename = filenameForArtifactVersion(artifact, version);
  const contentType = contentTypeForArtifactVersion(artifact, version);
  const viewer = resolveViewer({
    contentType,
    filename,
    assetId: version.assetId,
    assetUrl: assetUrlForArtifactVersion(version),
  });

  return (
    <SharedContentViewer
      viewer={viewer}
      filename={filename}
      inlineTextContent={version.content ?? null}
    />
  );
}

// --- Asset ------------------------------------------------------------------

export function AssetRefTabBody({
  refId,
  viewerKind,
}: {
  refId: string;
  viewerKind?: string;
}) {
  const {
    data: asset,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["commander-viewer-asset", refId],
    queryFn: () => assetsApi.getMeta(refId),
    enabled: Boolean(refId),
  });

  if (isLoading) return <LoadingBody />;

  if (isError || !asset) {
    return (
      <UnavailableBody message="This file is no longer available (it may have been deleted, or you may not have access)." />
    );
  }

  const filename = asset.originalFilename ?? "file";
  // resolveViewer derives the content URL from assetId (/api/assets/:id/content);
  // SharedContentViewer has no `src` prop — it reads viewer.assetUrl.
  const viewer = resolveViewer({
    contentType: asset.contentType,
    filename,
    assetId: refId,
    metadata: viewerKind ? { viewerKind } : null,
  });

  return <SharedContentViewer viewer={viewer} filename={filename} />;
}

// --- Task output (polymorphic) ---------------------------------------------

export function OutputLinkCard({ output }: { output: TaskOutput }) {
  // toSafeBrowserUrl returns "about:blank" for blocked schemes — treat that as no link.
  const gated = output.url ? toSafeBrowserUrl(output.url) : "";
  const safeUrl = gated && gated !== "about:blank" ? gated : "";
  return (
    <div className="h-full overflow-auto p-4" data-testid="commander-output-ref-link">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Globe className="size-4" aria-hidden />
        <span>{[output.type.replaceAll("_", " "), output.provider].filter(Boolean).join(" · ")}</span>
      </div>
      <h2 className="mt-2 text-base font-semibold leading-snug text-foreground">{output.title}</h2>
      {output.summary ? (
        <p className="mt-3 text-sm leading-6 text-muted-foreground">{output.summary}</p>
      ) : null}
      {safeUrl ? (
        <a
          href={safeUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 inline-flex items-center gap-1 rounded-md border border-border bg-background/60 px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted/60"
        >
          Open link
        </a>
      ) : (
        <p className="mt-4 text-xs text-muted-foreground">
          This link uses an unsupported scheme and cannot be opened.
        </p>
      )}
      {output.url ? (
        <p className="mt-2 break-all text-xs text-muted-foreground">{output.url}</p>
      ) : null}
    </div>
  );
}

export function OutputDetailCard({ output }: { output: TaskOutput }) {
  const meta = [output.type.replaceAll("_", " "), output.provider, output.status]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="h-full overflow-auto p-4" data-testid="commander-output-ref-body">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Package className="size-4" aria-hidden />
        <span>{meta}</span>
      </div>
      <h2 className="mt-2 text-base font-semibold leading-snug text-foreground">{output.title}</h2>
      {output.summary ? (
        <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{output.summary}</p>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">No preview is available for this output.</p>
      )}
    </div>
  );
}

export function OutputRefTabBody({
  companyId,
  refId,
  viewerKind,
}: {
  companyId: string;
  refId: string;
  viewerKind?: string;
}) {
  const {
    data: output,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["commander-viewer-output", companyId, refId],
    queryFn: () => taskOutputsApi.get(companyId, refId),
    enabled: Boolean(companyId && refId),
  });

  if (isLoading) return <LoadingBody />;

  if (isError || !output) {
    return (
      <UnavailableBody message="This output is no longer available (it may have been deleted, or you may not have access)." />
    );
  }

  // artifact / artifact_version → render through the artifact body.
  if (output.artifactId) {
    return <ArtifactTabBody refId={output.artifactId} versionId={output.artifactVersionId ?? null} />;
  }

  // asset-backed output → same content viewer path as a bare asset ref.
  if (output.assetId) {
    return <AssetRefTabBody refId={output.assetId} viewerKind={viewerKind} />;
  }

  // url-bearing output (preview_url / pull_request / external_link) → scheme-gated link.
  if (output.url) {
    return <OutputLinkCard output={output} />;
  }

  // Non-content output (branch / commit / runtime_service, …) → compact detail card.
  return <OutputDetailCard output={output} />;
}

// --- Memory item ------------------------------------------------------------

export function MemoryItemRefTabBody({
  companyId,
  refId,
}: {
  companyId: string;
  refId: string;
}) {
  const {
    data: item,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["commander-viewer-memory", companyId, refId],
    queryFn: () => memoryApi.get(companyId, refId),
    enabled: Boolean(companyId && refId),
  });

  if (isLoading) return <LoadingBody />;

  if (isError || !item) {
    return (
      <UnavailableBody message="This memory item is no longer available (it may have been deleted, or you may not have access)." />
    );
  }

  const meta = [item.layer, item.category, item.status].filter(Boolean).join(" · ");

  return (
    <div className="h-full overflow-auto p-4" data-testid="commander-memory-ref-body">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Brain className="size-4" aria-hidden />
        <span>{meta}</span>
      </div>
      <h2 className="mt-2 text-base font-semibold leading-snug text-foreground">{item.title}</h2>
      <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{item.content}</p>
      {item.tags && item.tags.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {item.tags.map((t) => (
            <span
              key={t}
              className="rounded-full border border-border/70 bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground"
            >
              {t}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// --- Discussion -------------------------------------------------------------

export function DiscussionRefTabBody({
  companyId,
  refId,
  fallbackTitle,
  fallbackLabel,
  fallbackSource,
  fallbackDetail,
}: {
  companyId: string;
  refId: string;
  /** Title shown before/if the live discussion can't be loaded. */
  fallbackTitle: string;
  /** Optional richer label (e.g. from an input ref) — wins over fallbackTitle. */
  fallbackLabel?: string;
  /** Meta line fallback when the discussion isn't loaded. */
  fallbackSource?: string | null;
  /** Body copy fallback when there are no messages. */
  fallbackDetail?: string | null;
}) {
  const {
    data: discussion,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["commander-viewer-discussion", companyId, refId],
    queryFn: () => discussionsApi.get(companyId, refId),
    enabled: Boolean(companyId && refId),
  });

  if (isLoading) return <LoadingBody />;

  const title = discussion?.title ?? fallbackLabel ?? fallbackTitle;
  const entries = discussion?.entries.slice(-3) ?? [];
  const meta = discussion
    ? [
        discussion.derivedStage?.label,
        discussion.scopeName,
        `${discussion.entryCount} ${discussion.entryCount === 1 ? "message" : "messages"}`,
        discussion.pendingItemCount > 0 ? `${discussion.pendingItemCount} pending` : null,
      ].filter(Boolean).join(" · ")
    : fallbackSource ?? "Discussion";

  return (
    <div className="h-full overflow-auto p-4" data-testid="commander-discussion-ref-body">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <MessageSquare className="size-4" aria-hidden />
        <span>{meta}</span>
      </div>
      <h2 className="mt-2 text-base font-semibold leading-snug text-foreground">{title}</h2>
      {entries.length > 0 ? (
        <div className="mt-4 space-y-3">
          {entries.map((entry) => (
            <article
              key={entry.id}
              className="rounded-md border border-border/70 bg-background/60 p-3"
            >
              <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                <span className="truncate">{entry.authorAgentName ?? entry.createdBy}</span>
                <span className="shrink-0">{new Date(entry.createdAt).toLocaleDateString()}</span>
              </div>
              {entry.title ? (
                <h3 className="mt-2 text-sm font-medium leading-snug text-foreground">{entry.title}</h3>
              ) : null}
              <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                {entry.rawContent}
              </p>
            </article>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">
          {fallbackDetail ?? "No discussion messages were found."}
        </p>
      )}
      {isError ? (
        <p className="mt-3 text-xs text-muted-foreground">
          The live discussion could not be loaded, so this preview is showing the referenced context.
        </p>
      ) : null}
    </div>
  );
}
