import type { FormatCapability, FormatFailure } from "@armyofagents/shared";
import { SharedContentViewer } from "../viewers/SharedContentViewer";
import { resolveViewer } from "../viewers/viewer-registry";

export interface ArtifactPanelProps {
  assetId: string;
  filename: string;
  contentType?: string | null;
  capability: FormatCapability;
  previewReady: boolean;
  failure?: FormatFailure | null;
}

const extractionLabel = (capability: FormatCapability) => {
  if (capability.extraction === "none") return "No extraction";
  if (capability.extraction === "provider_gated") return "Extraction gated";
  return "Extraction ready";
};

export function ArtifactPanel({
  assetId,
  filename,
  contentType,
  capability,
  previewReady,
  failure = null,
}: ArtifactPanelProps) {
  const assetUrl = `/api/assets/${encodeURIComponent(assetId)}/content`;
  const viewer = previewReady
    ? resolveViewer({ assetId, filename, contentType, assetUrl, metadata: null })
    : null;
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={`Artifact ${filename}`}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <span>{previewReady ? "Preview ready" : "Preview unavailable"}</span>
        <span>{extractionLabel(capability)}</span>
        <span>{capability.nativeExport === "qualified_writer" ? "Native export" : "Original export"}</span>
      </div>
      {failure === "locked" ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          This file is locked. Its original remains available.
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col">
        {viewer ? (
          <SharedContentViewer viewer={viewer} filename={filename} />
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center p-5">
            <a href={assetUrl} download={filename} className="text-sm font-medium underline">
              Download original
            </a>
          </div>
        )}
      </div>
      {capability.limitations.length > 0 ? (
        <ul className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
          {capability.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
        </ul>
      ) : null}
    </section>
  );
}
