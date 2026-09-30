import { useQuery } from "@tanstack/react-query";
import {
  ExternalLink,
  FileBox,
  FileText,
  GitBranch,
  GitPullRequest,
  Globe,
  Server,
} from "lucide-react";
import { artifactsApi } from "@/api/artifacts";
import { taskOutputsApi } from "@/api/task-outputs";
import { queryKeys } from "@/lib/queryKeys";
import type {
  ArtifactVersion,
  ArtifactWithVersions,
  TaskOutput,
} from "@armyofagents/shared";
import type { WorkspaceRuntimeService } from "@/api/execution-workspaces";

interface OutputsSectionProps {
  issueId: string;
  onPreviewArtifact?: (artifact: ArtifactWithVersions, version: ArtifactVersion) => void;
  onOpenBrowser?: (service: WorkspaceRuntimeService) => void;
}

function outputIcon(type: TaskOutput["type"]) {
  switch (type) {
    case "preview_url":
      return Globe;
    case "runtime_service":
      return Server;
    case "pull_request":
      return GitPullRequest;
    case "branch":
    case "commit":
      return GitBranch;
    case "artifact":
    case "artifact_version":
    case "detected_file":
      return FileText;
    default:
      return ExternalLink;
  }
}

function statusClass(status: TaskOutput["status"]) {
  if (status === "failed") return "text-destructive";
  if (status === "running" || status === "active" || status === "merged") return "text-emerald-500";
  return "text-muted-foreground";
}

function outputDetail(output: TaskOutput) {
  if (output.type === "pull_request") return output.status;
  if (output.type === "preview_url") return output.healthStatus === "unknown" ? output.status : output.healthStatus;
  if (output.type === "runtime_service") return output.status;
  if (output.type === "branch") return output.provider;
  return output.reviewState === "none" ? output.status : output.reviewState.replace(/_/g, " ");
}

function makeBrowserService(output: TaskOutput): WorkspaceRuntimeService {
  const createdAt = new Date(output.createdAt).toISOString();
  const updatedAt = new Date(output.updatedAt).toISOString();
  return {
    id: output.runtimeServiceId ?? output.id,
    companyId: output.companyId,
    projectId: output.projectId,
    projectWorkspaceId: null,
    executionWorkspaceId: output.executionWorkspaceId,
    issueId: output.issueId,
    scopeType: "execution_workspace",
    scopeId: output.executionWorkspaceId,
    serviceName: output.title,
    status: output.status === "failed" ? "failed" : "running",
    lifecycle: "workspace",
    reuseKey: null,
    command: null,
    cwd: null,
    port: null,
    url: output.url,
    previewUrl: output.url,
    localTargetUrl: output.url,
    provider: output.provider,
    providerRef: null,
    ownerAgentId: output.createdByAgentId,
    startedByRunId: output.createdByRunId,
    lastUsedAt: updatedAt,
    startedAt: createdAt,
    stoppedAt: null,
    stopPolicy: null,
    healthStatus: output.healthStatus,
    createdAt,
    updatedAt,
  } as unknown as WorkspaceRuntimeService;
}

export function OutputsSection({ issueId, onPreviewArtifact, onOpenBrowser }: OutputsSectionProps) {
  const { data: outputs, isLoading } = useQuery({
    queryKey: queryKeys.taskOutputs.byIssue(issueId),
    queryFn: () => taskOutputsApi.listForIssue(issueId),
    enabled: Boolean(issueId),
    staleTime: 5000,
  });

  const sortedOutputs = [...(outputs ?? [])].sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  if (isLoading) {
    return (
      <div className="space-y-2 px-1" data-testid="outputs-section-loading">
        <div className="h-9 rounded-md bg-muted/40" />
        <div className="h-9 rounded-md bg-muted/30" />
      </div>
    );
  }

  if (sortedOutputs.length === 0) {
    return (
      <div className="flex min-w-0 items-start gap-2 px-1 py-2 text-xs" data-testid="outputs-empty">
        <FileBox className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="font-medium text-foreground">No outputs yet</p>
          <p className="text-[11px] leading-4 text-muted-foreground">
            Artifacts, previews, branches, and PRs will appear here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-w-0 max-w-full space-y-1 overflow-hidden px-1" data-testid="outputs-section">
      {sortedOutputs.map((output) => {
        const Icon = outputIcon(output.type);
        const canPreviewArtifact = Boolean(output.artifactId && onPreviewArtifact);
        const canOpenUrl = Boolean(output.url);
        const clickable = canPreviewArtifact || canOpenUrl;

        const handleClick = async () => {
          if (canPreviewArtifact && output.artifactId) {
            const artifact = await artifactsApi.get(output.artifactId);
            const version =
              artifact.versions.find((item) => item.id === output.artifactVersionId) ??
              artifact.versions[0];
            if (version) onPreviewArtifact?.(artifact, version);
            return;
          }
          if (output.url) {
            if (output.type === "preview_url") onOpenBrowser?.(makeBrowserService(output));
            else window.open(output.url, "_blank", "noopener,noreferrer");
          }
        };

        return (
          <button
            key={output.id}
            type="button"
            className="flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-1.5 text-left transition-colors hover:bg-white/[0.06] disabled:cursor-default disabled:hover:bg-transparent"
            onClick={clickable ? handleClick : undefined}
            disabled={!clickable}
            data-testid={`task-output-${output.type}`}
          >
            <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1">
                <span className="min-w-0 truncate text-xs font-medium text-foreground">
                  {output.title}
                </span>
                {output.isPrimary && (
                  <span className="shrink-0 rounded border border-border px-1 py-0.5 text-[10px] leading-none text-muted-foreground">
                    Primary
                  </span>
                )}
              </div>
              <div className={`truncate text-[11px] ${statusClass(output.status)}`}>
                {outputDetail(output)}
              </div>
            </div>
            {canOpenUrl && <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
          </button>
        );
      })}
    </div>
  );
}
