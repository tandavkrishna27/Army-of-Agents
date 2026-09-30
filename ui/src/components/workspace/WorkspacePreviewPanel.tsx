import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { artifactsApi } from "../../api/artifacts";
import { outputDetectionApi } from "../../api/output-detection";
import { taskOutputsApi } from "../../api/task-outputs";
import { heartbeatsApi } from "../../api/heartbeats";
import { activityApi, type RunForIssue } from "../../api/activity";
import { executionWorkspacesApi, type WorkspaceRuntimeService } from "../../api/execution-workspaces";
import { queryKeys } from "../../lib/queryKeys";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { GitBranch, GitCompareArrows, GitPullRequest, Eye, Terminal, X, RefreshCw, Globe, Plus, FileText, LayoutGrid } from "lucide-react";
import { formatBytes, sourceLabel, fileIcon } from "./workspace-utils";
import { resolveOutputViewer } from "./output-viewer-registry";
import { WorkProductViewer } from "./WorkProductViewer";
import {
  assetUrlForArtifactVersion,
  contentTypeForArtifactVersion,
  filenameForArtifactVersion,
} from "../viewers/artifact-version-viewer";
import type { ArtifactWithVersions, ArtifactVersion, DetectedOutput, DetectedOutputForUI, TaskOutput } from "@armyofagents/shared";
import { toSafeBrowserUrl } from "@armyofagents/shared";

export type PreviewMode = "changes" | "preview" | "logs";
export type PreviewTabKind = "home" | "browser" | "changes" | "file" | "artifact" | "output" | "asset" | "logs";

export type WorkspacePreviewTab =
  | {
      id: string;
      kind: "home";
      title: string;
      issueId: string;
    }
  | {
      id: string;
      kind: "browser";
      title: string;
      url: string;
      serviceId?: string | null;
      localTargetUrl?: string | null;
    }
  | {
      id: string;
      kind: "changes";
      title: string;
      issueId: string;
    }
  | {
      id: string;
      kind: "file";
      title: string;
      issueId: string;
      path: string;
    }
  | {
      id: string;
      kind: "artifact";
      title: string;
      artifact: ArtifactWithVersions;
      version: ArtifactVersion;
    }
  | {
      id: string;
      kind: "output";
      title: string;
      output: DetectedOutputForUI;
    }
  | {
      id: string;
      kind: "asset";
      title: string;
      assetId: string;
      contentType: string | null;
      filename: string;
      byteSize?: number | null;
    }
  | {
      id: string;
      kind: "logs";
      title: string;
      issueId: string;
    };

interface WorkspacePreviewPanelProps {
  issueId?: string;
  companyId: string;
  activeMode?: PreviewMode | null;
  onModeChange?: (mode: PreviewMode | null) => void;
  tabs?: WorkspacePreviewTab[];
  activeTabId?: string | null;
  onSelectTab?: (tabId: string) => void;
  onCloseTab?: (tabId: string) => void;
  onOpenTab?: (kind: PreviewTabKind) => void;
  onOpenResolvedTab?: (tab: WorkspacePreviewTab) => void;
  /** Artifact version to preview (set by ArtifactsSection click) */
  previewArtifact?: { artifact: ArtifactWithVersions; version: ArtifactVersion } | null;
  /** Department function type — gates software-dev-only features */
  functionType?: string | null;
  /** Execution workspace ID — used for dev server preview */
  workspaceId?: string | null;
  /** Currently selected file path from FileTree in right sidebar */
  selectedFile?: string | null;
}

export function WorkspacePreviewPanel({
  issueId,
  companyId,
  activeMode,
  onModeChange,
  previewArtifact,
  functionType,
  workspaceId,
  selectedFile,
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onOpenTab,
  onOpenResolvedTab,
}: WorkspacePreviewPanelProps) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const activeTab = tabs?.find((tab) => tab.id === activeTabId) ?? tabs?.[0] ?? null;

  const { data: artifact } = useQuery({
    queryKey: queryKeys.artifacts.byIssue(issueId ?? ""),
    queryFn: () => artifactsApi.getByIssueId(issueId!),
    enabled: Boolean(issueId) && activeMode === "preview" && !previewArtifact,
  });

  const { data: runs } = useQuery({
    queryKey: queryKeys.issues.runs(issueId ?? ""),
    queryFn: () => activityApi.runsForIssue(issueId!),
    enabled: Boolean(issueId) && activeMode === "logs",
  });

  const latestRunId = selectedRunId ?? (runs && runs.length > 0 ? runs[0].runId : null);

  const { data: logData } = useQuery({
    queryKey: ["run-log", latestRunId],
    queryFn: () => heartbeatsApi.log(latestRunId!),
    enabled: activeMode === "logs" && !!latestRunId,
    refetchInterval: 5000,
  });

  if (tabs) {
    if (!activeTab) return null;

    return (
      <div className="flex h-full min-w-0 flex-col overflow-hidden" data-testid="workspace-preview-content">
        <PreviewTabBar
          tabs={tabs}
          activeTabId={activeTab.id}
          onSelectTab={onSelectTab}
          onCloseTab={onCloseTab}
          onOpenTab={onOpenTab}
        />
        <div className="min-h-0 flex-1 overflow-hidden" data-testid="workspace-preview-tab-body">
          {activeTab.kind === "home" && (
            <ScrollArea className="h-full">
              <ViewerHome
                issueId={activeTab.issueId}
                workspaceId={workspaceId ?? null}
                functionType={functionType ?? null}
                onOpenResolvedTab={onOpenResolvedTab}
              />
            </ScrollArea>
          )}
          {activeTab.kind === "browser" && (
            <BrowserTabView
              tab={activeTab}
              workspaceId={workspaceId ?? null}
              functionType={functionType ?? null}
            />
          )}
          {activeTab.kind === "changes" && (
            <ScrollArea className="h-full">
              <ChangesView
                issueId={activeTab.issueId}
                functionType={functionType ?? null}
                selectedFile={null}
              />
            </ScrollArea>
          )}
          {activeTab.kind === "file" && (
            <ScrollArea className="h-full">
              <ChangesView
                issueId={activeTab.issueId}
                functionType={functionType ?? null}
                selectedFile={activeTab.path}
              />
            </ScrollArea>
          )}
          {activeTab.kind === "artifact" && (
            <ArtifactVersionPreviewView artifact={activeTab.artifact} version={activeTab.version} />
          )}
          {activeTab.kind === "output" && <OutputPreviewView output={activeTab.output} />}
          {activeTab.kind === "asset" && <AssetPreviewView tab={activeTab} />}
          {activeTab.kind === "logs" && (
            <ScrollArea className="h-full">
              <LogsTabView issueId={activeTab.issueId} />
            </ScrollArea>
          )}
        </div>
      </div>
    );
  }

  if (!activeMode) return null;

  return (
    <div className="flex flex-col h-full" data-testid="workspace-preview-content">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {activeMode === "changes" && "Changes"}
          {activeMode === "preview" && "Preview"}
          {activeMode === "logs" && "Logs"}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => onModeChange?.(null)}
          data-testid="preview-close"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <ScrollArea className="flex-1">
        {activeMode === "changes" && issueId && <ChangesView issueId={issueId} functionType={functionType ?? null} selectedFile={selectedFile ?? null} />}
        {activeMode === "preview" && (
          <PreviewView
            artifact={previewArtifact?.artifact ?? artifact ?? null}
            version={previewArtifact?.version ?? null}
            functionType={functionType ?? null}
            workspaceId={workspaceId ?? null}
          />
        )}
        {activeMode === "logs" && (
          <LogsView
            runs={runs ?? []}
            selectedRunId={latestRunId}
            onSelectRun={setSelectedRunId}
            logContent={logData?.content ?? null}
          />
        )}
      </ScrollArea>
    </div>
  );
}

function PreviewTabBar({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onOpenTab,
}: {
  tabs: WorkspacePreviewTab[];
  activeTabId: string;
  onSelectTab?: (tabId: string) => void;
  onCloseTab?: (tabId: string) => void;
  onOpenTab?: (kind: PreviewTabKind) => void;
}) {
  return (
    <div className="flex h-[42px] min-w-0 shrink-0 items-center gap-1 border-b border-border px-2" data-testid="workspace-preview-tabs">
      <div className="flex min-w-0 max-w-[calc(100%-2.25rem)] items-center gap-1 overflow-x-auto" role="tablist" aria-label="Workspace preview tabs">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          const Icon = previewTabIcon(tab.kind);
          return (
            <div
              key={tab.id}
              className={cn(
                "flex h-7 min-w-0 max-w-[180px] items-center rounded-md border border-transparent",
                active
                  ? "border-brand/40 bg-accent text-accent-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-2 text-xs"
                onClick={() => onSelectTab?.(tab.id)}
                title={tab.title}
                data-testid={`preview-tab-${tab.id}`}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 truncate">{tab.title}</span>
              </button>
              <button
                type="button"
                className="mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-background/70 hover:text-foreground"
                onClick={() => onCloseTab?.(tab.id)}
                aria-label={`Close ${tab.title}`}
                title={`Close ${tab.title}`}
                data-testid={`preview-tab-close-${tab.id}`}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
      </div>
      {onOpenTab && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 rounded-md border border-border bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          aria-label="Add browser tab"
          title="Add browser tab"
          data-testid="preview-tab-add"
          onClick={() => onOpenTab("browser")}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}

function previewTabIcon(kind: PreviewTabKind) {
  switch (kind) {
    case "home":
      return LayoutGrid;
    case "browser":
      return Globe;
    case "changes":
      return GitCompareArrows;
    case "file":
      return FileText;
    case "artifact":
      return Eye;
    case "output":
      return FileText;
    case "asset":
      return FileText;
    case "logs":
      return Terminal;
  }
}

function BrowserTabView({
  tab,
  workspaceId,
  functionType,
}: {
  tab: Extract<WorkspacePreviewTab, { kind: "browser" }>;
  workspaceId: string | null;
  functionType: string | null;
}) {
  const [iframeKey, setIframeKey] = useState(0);
  const [currentUrl, setCurrentUrl] = useState(tab.url === "about:blank" ? "" : tab.url);
  const [draftUrl, setDraftUrl] = useState(tab.url === "about:blank" ? "" : tab.url);
  const [currentLocalTargetUrl, setCurrentLocalTargetUrl] = useState<string | null>(
    tab.localTargetUrl ?? null,
  );
  const isSoftware = functionType === "software_development";

  const { data: services } = useQuery({
    queryKey: queryKeys.executionWorkspaces.runtimeServices(workspaceId ?? ""),
    queryFn: () => executionWorkspacesApi.runtimeServices(workspaceId!),
    enabled: isSoftware && !!workspaceId,
    staleTime: 2500,
  });

  const runningServices = (services ?? []).filter(
    (service) => service.status === "running" && service.healthStatus !== "unhealthy" && service.previewUrl,
  );

  function normalizeUrl(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("/")) return trimmed;
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
    return `http://${trimmed}`;
  }

  function navigateTo(value: string, localTargetUrl: string | null = null) {
    const nextUrl = normalizeUrl(value);
    if (!nextUrl) return;
    setDraftUrl(nextUrl);
    setCurrentUrl(nextUrl);
    setCurrentLocalTargetUrl(localTargetUrl);
    setIframeKey((key) => key + 1);
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden" data-testid="preview-browser-tab">
      <form
        className="flex min-w-0 shrink-0 items-center gap-2 border-b border-border px-3 py-2"
        onSubmit={(event) => {
          event.preventDefault();
          navigateTo(draftUrl);
        }}
      >
        <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          className="min-w-0 flex-1 rounded-md border border-border bg-muted/30 px-2 py-1 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-brand"
          value={draftUrl}
          onChange={(event) => setDraftUrl(event.target.value)}
          placeholder="Enter a URL"
          aria-label="Browser URL"
          data-testid="preview-browser-url-input"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => setIframeKey((key) => key + 1)}
          title="Reload"
          aria-label="Reload browser preview"
          data-testid="preview-browser-reload"
          disabled={!currentUrl}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
        {currentUrl && (
          <Button asChild type="button" variant="ghost" size="icon" className="h-7 w-7" title="Open externally">
            <a href={currentUrl} target="_blank" rel="noopener noreferrer" aria-label="Open browser preview externally">
              <Globe className="h-3.5 w-3.5" />
            </a>
          </Button>
        )}
      </form>
      {currentLocalTargetUrl && (
        <div
          className="min-w-0 shrink-0 border-b border-border px-3 py-1 text-[11px] text-muted-foreground"
          data-testid="preview-browser-local-target"
        >
          <span className="truncate font-mono">Local target: {currentLocalTargetUrl}</span>
        </div>
      )}
      {currentUrl ? (
        <iframe
          key={iframeKey}
          src={toSafeBrowserUrl(currentUrl) || "about:blank"}
          className="min-h-0 flex-1 border-0"
          title={tab.title}
          data-testid="preview-browser-iframe"
        />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6" data-testid="preview-browser-start">
          <div className="w-full max-w-lg space-y-3">
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Local</div>
              <div className="mt-2 space-y-2">
                {runningServices.length > 0 ? (
                  runningServices.map((service) => (
                    <button
                      key={service.id}
                      type="button"
                      className="flex w-full min-w-0 items-center gap-3 rounded-md border border-border bg-background/40 px-3 py-2 text-left hover:bg-accent/50"
                      onClick={() => service.previewUrl && navigateTo(service.previewUrl, service.localTargetUrl ?? null)}
                      data-testid={`preview-browser-service-${service.id}`}
                    >
                      <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{service.serviceName}</div>
                        {service.previewUrl && <div className="truncate text-xs text-muted-foreground">{service.previewUrl}</div>}
                      </div>
                    </button>
                  ))
                ) : (
                  <div className="rounded-md border border-dashed border-border px-3 py-3 text-sm text-muted-foreground">
                    No live browser services
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ViewerHome({
  issueId,
  workspaceId,
  functionType,
  onOpenResolvedTab,
}: {
  issueId: string;
  workspaceId: string | null;
  functionType: string | null;
  onOpenResolvedTab?: (tab: WorkspacePreviewTab) => void;
}) {
  const isSoftware = functionType === "software_development";

  const { data: services } = useQuery({
    queryKey: queryKeys.executionWorkspaces.runtimeServices(workspaceId ?? ""),
    queryFn: () => executionWorkspacesApi.runtimeServices(workspaceId!),
    enabled: isSoftware && !!workspaceId,
    staleTime: 2500,
  });

  const { data: artifact } = useQuery({
    queryKey: queryKeys.artifacts.byIssue(issueId),
    queryFn: () => artifactsApi.getByIssueId(issueId),
    enabled: !!issueId,
    staleTime: 5000,
  });

  const { data: detectedOutputs } = useQuery({
    queryKey: queryKeys.detectedOutputs.byIssue(issueId),
    queryFn: () => outputDetectionApi.listForIssue(issueId),
    enabled: !!issueId,
    staleTime: 5000,
  });

  const { data: taskOutputs } = useQuery({
    queryKey: queryKeys.taskOutputs.byIssue(issueId),
    queryFn: () => taskOutputsApi.listForIssue(issueId),
    enabled: !!issueId,
    staleTime: 5000,
  });

  const { data: runs } = useQuery({
    queryKey: queryKeys.issues.runs(issueId),
    queryFn: () => activityApi.runsForIssue(issueId),
    enabled: !!issueId,
  });

  const runningServices = (services ?? []).filter(
    (service) => service.status === "running" && service.healthStatus !== "unhealthy" && service.previewUrl,
  );
  const candidates = (detectedOutputs ?? []).filter((output) => output.status === "pending");
  const latestVersion = artifact?.versions[0] ?? null;
  const visibleOutputs = taskOutputs ?? [];

  return (
    <div className="space-y-4 p-3" data-testid="viewer-home">
      <ViewerHomeSection title="Task Outputs">
        {visibleOutputs.length > 0 ? (
          visibleOutputs.slice(0, 6).map((output) => (
            <ViewerHomeRow
              key={output.id}
              icon={viewerOutputIcon(output.type)}
              title={output.title}
              detail={viewerOutputDetail(output)}
              testId={`viewer-home-task-output-${output.id}`}
              onClick={() => openTaskOutputFromViewer(output, onOpenResolvedTab)}
            />
          ))
        ) : (
          <ViewerHomeEmpty>No outputs yet</ViewerHomeEmpty>
        )}
      </ViewerHomeSection>

      <ViewerHomeSection title="Browser">
        {runningServices.length > 0 ? (
          runningServices.map((service) => (
            <ViewerHomeRow
              key={service.id}
              icon={Globe}
              title={service.serviceName}
              detail={service.previewUrl ?? ""}
              testId={`viewer-home-service-${service.id}`}
              onClick={() => {
                if (!service.previewUrl) return;
                onOpenResolvedTab?.({
                  id: `browser:${service.id}`,
                  kind: "browser",
                  title: service.serviceName,
                  url: service.previewUrl,
                  serviceId: service.id,
                  localTargetUrl: service.localTargetUrl ?? null,
                });
              }}
            />
          ))
        ) : (
          <ViewerHomeEmpty>No live browser services</ViewerHomeEmpty>
        )}
      </ViewerHomeSection>

      <ViewerHomeSection title="Artifacts">
        {artifact && latestVersion ? (
          <ViewerHomeRow
            icon={Eye}
            title={artifact.title}
            detail={`v${latestVersion.versionNumber} · ${latestVersion.source}`}
            testId={`viewer-home-artifact-${artifact.id}`}
            onClick={() =>
              onOpenResolvedTab?.({
                id: `artifact:${artifact.id}:${latestVersion.id}`,
                kind: "artifact",
                title: artifact.title,
                artifact,
                version: latestVersion,
              })
            }
          />
        ) : candidates.length > 0 ? (
          candidates.slice(0, 4).map((output) => (
            <ViewerHomeRow
              key={`${output.runId}:${output.outputIndex}`}
              icon={FileText}
              title={output.filename}
              detail={output.assetId ? output.contentType : `${output.contentType} · live only`}
              testId={`viewer-home-output-${output.runId}-${output.outputIndex}`}
              onClick={
                output.assetId
                  ? () =>
                      onOpenResolvedTab?.({
                        id: `output:${output.runId}:${output.outputIndex}`,
                        kind: "output",
                        title: output.filename,
                        output,
                      })
                  : undefined
              }
            />
          ))
        ) : (
          <ViewerHomeEmpty>No artifacts yet</ViewerHomeEmpty>
        )}
      </ViewerHomeSection>

      <ViewerHomeSection title="Runs and logs">
        <ViewerHomeRow
          icon={Terminal}
          title="Logs"
          detail={(runs?.length ?? 0) > 0 ? `${runs?.length ?? 0} run${runs?.length === 1 ? "" : "s"}` : "No runs yet"}
          testId="viewer-home-logs"
          onClick={() =>
            onOpenResolvedTab?.({
              id: `logs:${issueId}`,
              kind: "logs",
              title: "Logs",
              issueId,
            })
          }
        />
      </ViewerHomeSection>
    </div>
  );
}

function viewerOutputIcon(type: TaskOutput["type"]) {
  switch (type) {
    case "preview_url":
    case "runtime_service":
      return Globe;
    case "pull_request":
      return GitPullRequest;
    case "branch":
    case "commit":
      return GitBranch;
    default:
      return FileText;
  }
}

function viewerOutputDetail(output: TaskOutput) {
  if (output.type === "pull_request") return output.status;
  if (output.type === "preview_url") return output.url;
  if (output.type === "branch") return output.provider;
  return output.reviewState === "none" ? output.status : output.reviewState.replace(/_/g, " ");
}

async function openTaskOutputFromViewer(
  output: TaskOutput,
  onOpenResolvedTab?: (tab: WorkspacePreviewTab) => void,
) {
  if (!onOpenResolvedTab) return;
  if ((output.type === "artifact" || output.type === "artifact_version") && output.artifactId) {
    const artifact = await artifactsApi.get(output.artifactId);
    const version =
      artifact.versions.find((item) => item.id === output.artifactVersionId) ??
      artifact.versions[0];
    if (!version) return;
    onOpenResolvedTab({
      id: `artifact:${artifact.id}:${version.id}`,
      kind: "artifact",
      title: artifact.title,
      artifact,
      version,
    });
    return;
  }
  if (output.type === "preview_url" && output.url) {
    onOpenResolvedTab({
      id: `browser:task-output:${output.id}`,
      kind: "browser",
      title: output.title,
      url: output.url,
      serviceId: output.runtimeServiceId,
      localTargetUrl: output.url,
    });
    return;
  }
  if (output.url) {
    window.open(output.url, "_blank", "noopener,noreferrer");
  }
}

function ViewerHomeSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

function ViewerHomeRow({
  icon: Icon,
  title,
  detail,
  testId,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  detail?: string | null;
  testId: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full min-w-0 items-center gap-2 rounded-md border border-border bg-background/40 px-2 py-2 text-left transition-colors hover:bg-accent/50 disabled:cursor-default disabled:hover:bg-background/40"
      onClick={onClick}
      disabled={!onClick}
      data-testid={testId}
    >
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">{title}</div>
        {detail && <div className="truncate text-[11px] text-muted-foreground">{detail}</div>}
      </div>
    </button>
  );
}

function ViewerHomeEmpty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-md border border-dashed border-border px-2 py-2 text-xs text-muted-foreground">{children}</div>;
}

function LogsTabView({ issueId }: { issueId: string }) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const { data: runs } = useQuery({
    queryKey: queryKeys.issues.runs(issueId),
    queryFn: () => activityApi.runsForIssue(issueId),
  });

  const latestRunId = selectedRunId ?? (runs && runs.length > 0 ? runs[0].runId : null);

  const { data: logData } = useQuery({
    queryKey: ["run-log", latestRunId],
    queryFn: () => heartbeatsApi.log(latestRunId!),
    enabled: !!latestRunId,
    refetchInterval: 5000,
  });

  return (
    <LogsView
      runs={runs ?? []}
      selectedRunId={latestRunId}
      onSelectRun={setSelectedRunId}
      logContent={logData?.content ?? null}
    />
  );
}

function OutputPreviewView({ output }: { output: DetectedOutputForUI }) {
  const viewer = resolveOutputViewer(output);
  const assetUrl = viewer.assetUrl;

  if (!assetUrl) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground" data-testid="preview-output-empty">
        This output was detected live but was not captured as a previewable asset.
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden" data-testid="preview-output-tab">
      <div className="flex min-w-0 shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{output.filename}</div>
          <div className="truncate text-[11px] text-muted-foreground">
            {viewer.label} · {output.contentType} · {formatBytes(output.byteSize)}
          </div>
        </div>
        {viewer.canOpenDirectly && (
          <Button asChild type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs">
            <a href={assetUrl ?? undefined} target="_blank" rel="noopener noreferrer">
              Open
            </a>
          </Button>
        )}
      </div>
      <WorkProductViewer viewer={viewer} filename={output.filename} />
    </div>
  );
}

function AssetPreviewView({ tab }: { tab: Extract<WorkspacePreviewTab, { kind: "asset" }> }) {
  const viewer = resolveOutputViewer({
    contentType: tab.contentType,
    filename: tab.filename,
    assetId: tab.assetId,
    assetUrl: `/api/assets/${tab.assetId}/content`,
  });

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden" data-testid="preview-asset-tab">
      <div className="flex min-w-0 shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{tab.filename}</div>
          <div className="truncate text-[11px] text-muted-foreground">
            {viewer.label}
            {tab.contentType ? ` · ${tab.contentType}` : ""}
            {typeof tab.byteSize === "number" ? ` · ${formatBytes(tab.byteSize)}` : ""}
          </div>
        </div>
        {viewer.canOpenDirectly && (
          <Button asChild type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs">
            <a href={viewer.assetUrl ?? undefined} target="_blank" rel="noopener noreferrer">
              Open
            </a>
          </Button>
        )}
      </div>
      <WorkProductViewer viewer={viewer} filename={tab.filename} />
    </div>
  );
}

function extensionFromName(value: string | null | undefined): string {
  const name = value?.split(/[?#]/, 1)[0]?.trim().toLowerCase() ?? "";
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1);
}

function ArtifactVersionPreviewView({
  artifact,
  version,
}: {
  artifact: ArtifactWithVersions;
  version: ArtifactVersion;
}) {
  const inlineContent = version.content ?? null;
  const filename = filenameForArtifactVersion(artifact, version);
  const contentType = contentTypeForArtifactVersion(artifact, version);
  const viewer = resolveOutputViewer({
    contentType,
    filename,
    assetId: version.assetId,
    assetUrl: assetUrlForArtifactVersion(version),
  });

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden" data-testid="preview-artifact-tab">
      <div className="flex min-w-0 shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{artifact.title}</div>
          <div className="truncate text-[11px] text-muted-foreground">
            {viewer.label} - v{version.versionNumber}
          </div>
        </div>
        {viewer.canOpenDirectly && (
          <Button asChild type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs">
            <a href={viewer.assetUrl ?? undefined} target="_blank" rel="noopener noreferrer">
              Open
            </a>
          </Button>
        )}
      </div>
      <WorkProductViewer viewer={viewer} filename={filename} inlineTextContent={inlineContent} />
    </div>
  );
}

/** Toolbar buttons rendered in the center panel header */
export function PreviewModeToolbar({
  activeMode,
  onModeChange,
}: {
  activeMode: PreviewMode | null;
  onModeChange: (mode: PreviewMode | null) => void;
}) {
  const modes: { key: PreviewMode; icon: typeof GitCompareArrows; label: string }[] = [
    { key: "changes", icon: GitCompareArrows, label: "Changes" },
    { key: "preview", icon: Eye, label: "Preview" },
    { key: "logs", icon: Terminal, label: "Logs" },
  ];

  return (
    <div className="flex items-center gap-1" data-testid="preview-mode-toolbar">
      {modes.map(({ key, icon: Icon, label }) => (
        <Button
          key={key}
          variant={activeMode === key ? "secondary" : "ghost"}
          size="sm"
          className={cn(
            "h-7 px-2 text-xs gap-1.5",
            activeMode === key && "bg-accent text-accent-foreground",
          )}
          onClick={() => onModeChange(activeMode === key ? null : key)}
          data-testid={`preview-mode-${key}`}
        >
          <Icon className="h-3.5 w-3.5" />
          {label}
        </Button>
      ))}
    </div>
  );
}

// ── Sub-views ──────────────────────────────────────────────────────────────────

function ChangesView({ issueId, functionType, selectedFile }: { issueId: string; functionType: string | null; selectedFile: string | null }) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const { data: runs } = useQuery({
    queryKey: queryKeys.issues.runs(issueId),
    queryFn: () => activityApi.runsForIssue(issueId),
  });

  if (functionType !== "software_development") {
    return (
      <div className="flex items-center justify-center h-48 text-sm text-muted-foreground" data-testid="changes-no-code">
        No code changes to display
      </div>
    );
  }

  if (!runs || runs.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-sm text-muted-foreground" data-testid="changes-no-runs">
        No runs yet
      </div>
    );
  }

  const activeRunId = selectedRunId ?? runs[0].runId;
  const activeRun = runs.find((r) => r.runId === activeRunId);
  const outputs: DetectedOutput[] = activeRun?.detectedOutputs ?? [];

  return (
    <div className="flex flex-col h-full" data-testid="changes-view">
      {runs.length > 1 && (
        <div className="flex items-center gap-1 px-3 py-2 border-b border-border overflow-x-auto">
          {runs.slice(0, 10).map((r) => (
            <Button
              key={r.runId}
              variant={activeRunId === r.runId ? "secondary" : "ghost"}
              size="sm"
              className="h-6 px-2 text-xs shrink-0"
              onClick={() => setSelectedRunId(r.runId)}
            >
              Run {r.runId.slice(0, 6)}
            </Button>
          ))}
        </div>
      )}

      {outputs.length === 0 ? (
        <div className="flex items-center justify-center h-48 text-sm text-muted-foreground" data-testid="changes-empty-run">
          No changes detected in this run
        </div>
      ) : selectedFile ? (
        // File detail card when a file is selected from the sidebar FileTree
        (() => {
          const output = outputs.find((o) => o.path === selectedFile);
          if (!output) return (
            <div className="p-4 text-sm text-muted-foreground">File not found in this run</div>
          );
          const Icon = fileIcon(output.contentType);
          const badge = sourceLabel(output.source);
          return (
            <div className="p-4 space-y-3" data-testid="changes-file-detail">
              <div className="flex items-center gap-2">
                <Icon className="h-5 w-5 text-muted-foreground shrink-0" />
                <span className="text-sm font-mono font-medium truncate">{output.filename}</span>
              </div>
              <div className="space-y-1.5 text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground w-20 shrink-0">Path</span>
                  <code className="font-mono text-[11px] truncate">{output.path}</code>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground w-20 shrink-0">Type</span>
                  <span>{output.contentType}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground w-20 shrink-0">Size</span>
                  <span>{formatBytes(output.byteSize)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground w-20 shrink-0">Source</span>
                  <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-medium", badge.className)}>
                    {badge.text}
                  </span>
                </div>
                {output.sha256 && (
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground w-20 shrink-0">SHA-256</span>
                    <code className="font-mono text-[10px] truncate">{output.sha256}</code>
                  </div>
                )}
                {output.status && (
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground w-20 shrink-0">Status</span>
                    <span>{output.status}</span>
                  </div>
                )}
              </div>
            </div>
          );
        })()
      ) : (
        // Summary view: flat file list (default when no file selected)
        <div className="flex flex-col">
          {outputs.map((output, idx) => {
            const Icon = fileIcon(output.contentType);
            const badge = sourceLabel(output.source);
            return (
              <div
                key={`${output.path}-${idx}`}
                className="flex items-center gap-2 px-3 py-2 border-b border-border last:border-b-0 hover:bg-muted/50"
                data-testid="changes-file-row"
                data-file-path={output.path}
              >
                <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="flex-1 text-xs font-mono truncate" title={output.path}>
                  {output.path}
                </span>
                <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-medium", badge.className)}>
                  {badge.text}
                </span>
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {formatBytes(output.byteSize)}
                </span>
              </div>
            );
          })}
          <div className="px-3 py-2 text-[10px] text-muted-foreground">
            {outputs.length} file{outputs.length !== 1 ? "s" : ""} changed in this run
          </div>
        </div>
      )}
    </div>
  );
}

function PreviewView({
  artifact,
  version: versionOverride,
  functionType,
  workspaceId,
  preferArtifact = false,
}: {
  artifact: ArtifactWithVersions | null;
  version: ArtifactVersion | null;
  functionType: string | null;
  workspaceId: string | null;
  preferArtifact?: boolean;
}) {
  const [iframeKey, setIframeKey] = useState(0);

  const { data: runtimeServices } = useQuery({
    queryKey: ["runtime-services", workspaceId],
    queryFn: () => executionWorkspacesApi.runtimeServices(workspaceId!),
    enabled: functionType === "software_development" && !!workspaceId,
    refetchInterval: 10000,
  });

  const runningService = runtimeServices?.find(
    (s) => s.status === "running" && s.healthStatus !== "unhealthy" && s.previewUrl,
  );

  // Dev server iframe for software departments
  if (!preferArtifact && functionType === "software_development" && workspaceId) {
    if (runningService?.previewUrl) {
      return (
        <div className="flex flex-col h-full" data-testid="preview-devserver">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
            <Globe className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="flex-1 text-xs font-mono text-muted-foreground truncate">
              {runningService.previewUrl}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setIframeKey((k) => k + 1)}
              title="Refresh preview"
              data-testid="preview-refresh"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
          <iframe
            key={iframeKey}
            src={toSafeBrowserUrl(runningService.previewUrl) || "about:blank"}
            className="flex-1 w-full border-0"
            title="Dev server preview"
            data-testid="preview-iframe"
          />
        </div>
      );
    }

    // No running dev server — show message, then fall through to artifact preview below
    if (!artifact) {
      return (
        <div className="flex flex-col items-center justify-center h-48 gap-2 text-sm text-muted-foreground" data-testid="preview-no-devserver">
          <Globe className="h-5 w-5" />
          <p>No dev server running</p>
          <p className="text-xs">Dev servers start automatically during agent runs.</p>
        </div>
      );
    }
  }

  // Existing artifact preview (unchanged from current code)
  if (!artifact) {
    return (
      <div className="flex items-center justify-center h-48 text-sm text-muted-foreground" data-testid="preview-empty">
        No artifacts linked to this task
      </div>
    );
  }

  const version = versionOverride ?? (artifact.versions.length > 0 ? artifact.versions[0] : null);

  if (!version) {
    return (
      <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">
        No versions available
      </div>
    );
  }

  // Route mode-preview through the SAME shared viewer the tabbed views use
  // (resolveOutputViewer -> WorkProductViewer -> SharedContentViewer), so an
  // artifact previews identically here and in a tab. Previously this branch
  // hand-rolled img/<pre>/download and diverged (markdown/csv/json/html/pdf/etc.
  // rendered richly in a tab but as raw <pre> or a bare link here).
  const inlineContent = version.content ?? null;
  const filename = filenameForArtifactVersion(artifact, version);
  const contentType = contentTypeForArtifactVersion(artifact, version);
  const viewer = resolveOutputViewer({
    contentType,
    filename,
    assetId: version.assetId,
    assetUrl: assetUrlForArtifactVersion(version),
  });

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden" data-testid="preview-artifact">
      <WorkProductViewer viewer={viewer} filename={filename} inlineTextContent={inlineContent} />
    </div>
  );
}

function LogsView({
  runs,
  selectedRunId,
  onSelectRun,
  logContent,
}: {
  runs: RunForIssue[];
  selectedRunId: string | null;
  onSelectRun: (id: string) => void;
  logContent: string | null;
}) {
  if (runs.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-sm text-muted-foreground" data-testid="logs-empty">
        No runs yet
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full" data-testid="logs-view">
      {runs.length > 1 && (
        <div className="flex items-center gap-1 px-3 py-2 border-b border-border overflow-x-auto">
          {runs.slice(0, 10).map((r) => (
            <Button
              key={r.runId}
              variant={selectedRunId === r.runId ? "secondary" : "ghost"}
              size="sm"
              className="h-6 px-2 text-xs shrink-0"
              onClick={() => onSelectRun(r.runId)}
            >
              Run {r.runId.slice(0, 6)}
            </Button>
          ))}
        </div>
      )}
      <pre className="flex-1 p-3 text-xs leading-relaxed whitespace-pre-wrap break-words font-mono overflow-auto" data-testid="logs-content">
        {logContent || "Loading logs..."}
      </pre>
    </div>
  );
}
