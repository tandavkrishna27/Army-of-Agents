import { useQuery } from "@tanstack/react-query";
import { executionWorkspacesApi } from "../../../api/execution-workspaces";
import { artifactsApi } from "../../../api/artifacts";
import { queryKeys } from "../../../lib/queryKeys";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Globe, RefreshCw, FileCode, FileText, Image, File, Package } from "lucide-react";
import type { ArtifactWithVersions, ArtifactVersion, ArtifactType } from "@armyofagents/shared";

function typeIcon(type: ArtifactType) {
  switch (type) {
    case "code": return FileCode;
    case "document":
    case "report": return FileText;
    case "design": return Image;
    case "presentation": return Package;
    default: return File;
  }
}

interface PreviewContextSectionProps {
  issueId: string;
  workspaceId: string | null;
  functionType: string | null;
  onPreviewArtifact?: (artifact: ArtifactWithVersions, version: ArtifactVersion) => void;
  onRefreshPreview?: () => void;
}

export function PreviewContextSection({
  issueId,
  workspaceId,
  functionType,
  onPreviewArtifact,
  onRefreshPreview,
}: PreviewContextSectionProps) {
  const { data: runtimeServices, isLoading: servicesLoading } = useQuery({
    queryKey: ["runtime-services", workspaceId],
    queryFn: () => executionWorkspacesApi.runtimeServices(workspaceId!),
    enabled: functionType === "software_development" && !!workspaceId,
    refetchInterval: 10000,
  });

  const { data: artifact, isLoading: artifactLoading } = useQuery({
    queryKey: queryKeys.artifacts.byIssue(issueId),
    queryFn: () => artifactsApi.getByIssueId(issueId),
  });

  const isLoading = servicesLoading || artifactLoading;
  const runningService = runtimeServices?.find((s) => s.status === "running" && s.url);

  if (isLoading) {
    return (
      <div className="space-y-1.5 px-3" data-testid="preview-context-skeleton">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-6 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="preview-context-section">
      {/* Dev server status */}
      {functionType === "software_development" && (
        <div className="px-3 space-y-1">
          <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Dev Server</div>
          {runningService ? (
            <div className="flex items-center gap-2">
              <div className="h-2 w-2 rounded-full bg-green-500 animate-pulse shrink-0" />
              <Globe className="h-3 w-3 text-muted-foreground shrink-0" />
              <span className="flex-1 text-[11px] font-mono text-muted-foreground truncate">
                {runningService.url}
              </span>
              {onRefreshPreview && (
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground transition-colors"
                  onClick={onRefreshPreview}
                  title="Refresh preview"
                >
                  <RefreshCw className="h-3 w-3" />
                </button>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <div className="h-2 w-2 rounded-full bg-muted-foreground/40 shrink-0" />
              <span className="text-[11px] text-muted-foreground">Not running</span>
            </div>
          )}
        </div>
      )}

      {/* Artifact */}
      {artifact && (
        <div className="px-3 space-y-1">
          <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Artifact</div>
          <button
            type="button"
            className="w-full flex items-center gap-2 py-1.5 text-left hover:bg-accent/50 rounded transition-colors"
            onClick={() => {
              const latestVersion = artifact.versions[0];
              if (latestVersion && onPreviewArtifact) {
                onPreviewArtifact(artifact, latestVersion);
              }
            }}
            data-testid="preview-context-artifact"
          >
            {(() => { const Icon = typeIcon(artifact.type); return <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />; })()}
            <span className="flex-1 text-[11px] truncate">{artifact.title}</span>
            {artifact.versions[0] && (
              <Badge variant="outline" className="text-[9px] h-4 px-1 shrink-0">
                v{artifact.versions[0].versionNumber}
              </Badge>
            )}
          </button>
        </div>
      )}

      {!artifact && functionType !== "software_development" && (
        <div className="px-3 py-2 text-xs text-muted-foreground">
          No preview content available
        </div>
      )}
    </div>
  );
}
