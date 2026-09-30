import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { artifactsApi } from "../../../api/artifacts";
import { outputDetectionApi } from "../../../api/output-detection";
import { queryKeys } from "../../../lib/queryKeys";
import { useToast } from "../../../context/ToastContext";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { Check, FileCode, FileText, Image, File, MoreVertical, Package, XCircle } from "lucide-react";
import type { ArtifactWithVersions, ArtifactVersion, ArtifactType, DetectedOutputForUI } from "@armyofagents/shared";

function typeIcon(type: ArtifactType) {
  switch (type) {
    case "code":
      return FileCode;
    case "document":
    case "report":
      return FileText;
    case "design":
      return Image;
    case "presentation":
      return Package;
    default:
      return File;
  }
}

function versionLabel(version: ArtifactVersion) {
  const changelog = version.changelog?.trim();
  if (changelog?.startsWith("Agent output:")) {
    const outputName = changelog.slice("Agent output:".length).trim();
    if (outputName) return outputName;
  }
  if (changelog) return changelog;
  if (version.fileUrl) return version.fileUrl.split(/[\\/]/).pop() ?? version.fileUrl;
  return "Saved version";
}

interface ArtifactsSectionProps {
  issueId: string;
  onPreviewArtifact?: (artifact: ArtifactWithVersions, version: ArtifactVersion) => void;
  onPreviewOutput?: (output: DetectedOutputForUI) => void;
}

export function ArtifactsSection({ issueId, onPreviewArtifact, onPreviewOutput }: ArtifactsSectionProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const { data: artifact, isLoading } = useQuery({
    queryKey: queryKeys.artifacts.byIssue(issueId),
    queryFn: () => artifactsApi.getByIssueId(issueId),
    staleTime: 5000,
  });

  const confirmOutput = useMutation({
    mutationFn: (data: {
      runId: string;
      index: number;
      payload: { artifactId?: string; title?: string; type?: string; changelog?: string | null };
    }) => outputDetectionApi.confirm(data.runId, data.index, data.payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.detectedOutputs.byIssue(issueId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.artifacts.byIssue(issueId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.taskOutputs.byIssue(issueId) });
      pushToast({ title: "Output saved as artifact" });
    },
  });

  const dismissOutput = useMutation({
    mutationFn: (data: { runId: string; index: number }) =>
      outputDetectionApi.dismiss(data.runId, data.index),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.detectedOutputs.byIssue(issueId) });
    },
  });

  const { data: detectedOutputs, isLoading: outputsLoading } = useQuery({
    queryKey: queryKeys.detectedOutputs.byIssue(issueId),
    queryFn: () => outputDetectionApi.listForIssue(issueId),
    staleTime: 5000,
  });

  if (isLoading) {
    return (
      <div className="px-3 space-y-2" data-testid="artifacts-skeleton">
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  const candidates = (detectedOutputs ?? []).filter((output) => output.status === "pending");

  if (!artifact && !outputsLoading && candidates.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-muted-foreground" data-testid="artifacts-empty">
        No artifacts yet
      </div>
    );
  }

  const latestVersion = artifact?.versions.length ? artifact.versions[0] : null;
  const savedVersions = artifact?.versions.slice(0, 4) ?? [];
  const Icon = artifact ? typeIcon(artifact.type) : File;

  return (
    <div className="max-w-full min-w-0 space-y-1 overflow-hidden" data-testid="artifacts-list">
      {artifact && (
        <>
          <button
            type="button"
            className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-1 py-1.5 text-left transition-colors hover:bg-white/[0.06] hover:text-foreground focus-visible:bg-white/[0.06] focus-visible:outline-none"
            onClick={() => {
              if (latestVersion && onPreviewArtifact) {
                onPreviewArtifact(artifact, latestVersion);
              }
            }}
            data-testid="artifact-row"
          >
            <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="truncate text-xs">{artifact.title}</div>
            </div>
          </button>
          {savedVersions.length > 0 && (
            <div className="ml-3 space-y-0.5 border-l border-border/60 pl-2" data-testid="artifact-version-list">
              {savedVersions.map((version) => (
                <button
                  key={version.id}
                  type="button"
                  className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-white/[0.06] hover:text-foreground focus-visible:bg-white/[0.06] focus-visible:outline-none"
                  onClick={() => {
                    if (onPreviewArtifact) {
                      onPreviewArtifact(artifact, version);
                    }
                  }}
                  data-testid={`artifact-version-row-${version.id}`}
                >
                  <span className="shrink-0 rounded border border-border/70 px-1 py-0.5 font-mono text-[10px] leading-none text-muted-foreground">
                    v{version.versionNumber}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                    {versionLabel(version)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {candidates.map((output) => {
        const canPreview = Boolean(output.assetId && onPreviewOutput);
        return (
          <div
            key={`${output.runId}:${output.outputIndex}`}
            className={cn(
              "flex w-full min-w-0 max-w-full items-center gap-1 overflow-hidden rounded-md px-1 py-1.5 text-left transition-colors",
              canPreview
                ? "cursor-pointer hover:bg-white/[0.06] hover:text-foreground focus-visible:bg-white/[0.06] focus-visible:outline-none"
                : "cursor-default",
            )}
            role={canPreview ? "button" : undefined}
            tabIndex={canPreview ? 0 : undefined}
            onClick={canPreview ? () => onPreviewOutput?.(output) : undefined}
            onKeyDown={
              canPreview
                ? (event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onPreviewOutput?.(output);
                    }
                  }
                : undefined
            }
            data-testid="artifact-candidate-row"
          >
            <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
              <File className="h-4 w-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1 overflow-hidden">
                <div className="truncate font-mono text-xs">{output.filename}</div>
              </div>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0 text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
                  aria-label="Artifact actions"
                  data-testid="artifact-candidate-actions"
                  onClick={(event) => event.stopPropagation()}
                >
                  <MoreVertical className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44" onClick={(event) => event.stopPropagation()}>
                <DropdownMenuItem
                  disabled={!output.assetId || confirmOutput.isPending}
                  onSelect={() => {
                    confirmOutput.mutate({
                      runId: output.runId,
                      index: output.outputIndex,
                      payload: artifact
                        ? {
                            artifactId: artifact.id,
                            changelog: `Agent output: ${output.filename}`,
                          }
                        : {
                            title: output.filename,
                            type: output.artifactType ?? "other",
                            changelog: `Agent output: ${output.filename}`,
                          },
                    });
                  }}
                >
                  <Check className="h-3.5 w-3.5" />
                  {artifact ? "Add as version" : "Save as artifact"}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={dismissOutput.isPending}
                  onSelect={() => {
                    dismissOutput.mutate({
                      runId: output.runId,
                      index: output.outputIndex,
                    });
                  }}
                >
                  <XCircle className="h-3.5 w-3.5" />
                  Dismiss
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      })}
    </div>
  );
}
