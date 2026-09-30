import { useCallback, useEffect, useMemo, useState } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ExecutionWorkspace } from "@armyofagents/shared";
import type { Project } from "@armyofagents/shared";
import type { ArtifactWithVersions, ArtifactVersion, DetectedOutputForUI, IssueAttachment } from "@armyofagents/shared";
import { WorkspaceTaskNav } from "./WorkspaceTaskNav";
import { DependencyChain } from "./DependencyChain";
import { WorkspaceTimeline } from "./WorkspaceTimeline";
import { WorkspacePreviewPanel, type PreviewMode, type PreviewTabKind, type WorkspacePreviewTab } from "./WorkspacePreviewPanel";
import { WorkspaceRightPanel } from "./WorkspaceRightPanel";
import { WorkspaceErrorBoundary } from "./WorkspaceErrorBoundary";
import { ExecutionWorkspaceCloseDialog } from "./ExecutionWorkspaceCloseDialog";
import { WorkspaceSettingsSheet } from "./WorkspaceSettingsSheet";
import { useSidebar } from "../../context/SidebarContext";
import { useSidebarCollapsed } from "./useSidebarCollapsed";
import { executionWorkspacesApi, type WorkspaceRuntimeService } from "../../api/execution-workspaces";
import { queryKeys } from "../../lib/queryKeys";
import { ListTodo, MessageSquare, Eye, Layers, AlertTriangle, PanelRight, PanelRightClose } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

const MOBILE_TABS = [
  { key: "tasks" as const, label: "Tasks", icon: ListTodo },
  { key: "timeline" as const, label: "Timeline", icon: MessageSquare },
  { key: "preview" as const, label: "Preview", icon: Eye },
  { key: "context" as const, label: "Context", icon: Layers },
];

type PreviewFocusSource = "center" | "right-panel";

interface WorkspaceLayoutProps {
  workspace: ExecutionWorkspace;
  project: Project | null;
  selectedIssueId: string | null;
  onSelectIssue: (issueId: string, executionWorkspaceId?: string | null) => void;
  companyId: string;
  companyPrefix: string;
  onBack: () => void;
  selectedIssueIdentifier?: string | null;
}

export function WorkspaceLayout({
  workspace,
  project,
  selectedIssueId,
  onSelectIssue,
  companyId,
  companyPrefix,
  onBack,
  selectedIssueIdentifier,
}: WorkspaceLayoutProps) {
  const { isMobile } = useSidebar();
  const [mobileTab, setMobileTab] = useState<"tasks" | "timeline" | "preview" | "context">("timeline");

  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: `aoa:workspace:panel-sizes:${workspace.id}`,
    storage: localStorage,
    panelIds: ["center-left", "center-right"],
  });

  const [previewTabs, setPreviewTabs] = useState<WorkspacePreviewTab[]>([]);
  const [activePreviewTabId, setActivePreviewTabId] = useState<string | null>(null);
  const [previewVisible, setPreviewVisible] = useState(false);
  const activePreviewTab = useMemo(
    () => previewTabs.find((tab) => tab.id === activePreviewTabId) ?? previewTabs[0] ?? null,
    [activePreviewTabId, previewTabs],
  );
  const previewMode: PreviewMode | null =
    !previewVisible
      ? null
      : activePreviewTab?.kind === "changes" || activePreviewTab?.kind === "logs"
      ? activePreviewTab.kind
      : activePreviewTab?.kind === "artifact" || activePreviewTab?.kind === "browser"
        ? "preview"
        : null;
  const selectedFile = activePreviewTab?.kind === "file" ? activePreviewTab.path : null;

  // Workspace actions are triggered from the cockpit header and rendered here.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [closeReportOpen, setCloseReportOpen] = useState(false);

  const queryClient = useQueryClient();

  const invalidateWorkspace = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.detail(workspace.id) });
    if (workspace.projectId) {
      queryClient.invalidateQueries({
        queryKey: queryKeys.executionWorkspaces.listForProject(workspace.companyId, workspace.projectId),
      });
    }
  }, [queryClient, workspace.id, workspace.companyId, workspace.projectId]);

  const unarchiveMutation = useMutation({
    mutationFn: () => executionWorkspacesApi.update(workspace.id, { status: "active" }),
    onSuccess: invalidateWorkspace,
  });

  const closeReportQuery = useQuery({
    queryKey: ["close-readiness", workspace.id, "report"],
    queryFn: () => executionWorkspacesApi.getCloseReadiness(workspace.id),
    enabled: closeReportOpen,
  });

  // Sidebar collapse state (desktop only; persisted per workspace)
  const [leftCollapsed, setLeftCollapsed] = useSidebarCollapsed(workspace.id, "left");
  const [rightCollapsed, setRightCollapsed] = useSidebarCollapsed(workspace.id, "right");
  const [scrollToGroup, setScrollToGroup] = useState<{ group: string; nonce: number } | null>(null);
  const [openSectionRequest, setOpenSectionRequest] = useState<{ section: string; nonce: number } | null>(null);

  const handleExpandAndShowGroup = useCallback(
    (group: string) => {
      setLeftCollapsed(false);
      setScrollToGroup({ group, nonce: Date.now() });
    },
    [setLeftCollapsed],
  );

  const handleExpandAndShowSection = useCallback(
    (section: string) => {
      setRightCollapsed(false);
      setOpenSectionRequest({ section, nonce: Date.now() });
    },
    [setRightCollapsed],
  );

  const applyPreviewFocus = useCallback(
    (source: PreviewFocusSource) => {
      if (isMobile) return;
      setLeftCollapsed(true);
      if (source === "center") {
        setRightCollapsed(true);
      }
    },
    [isMobile, setLeftCollapsed, setRightCollapsed],
  );

  const openPreviewTab = useCallback((tab: WorkspacePreviewTab, source: PreviewFocusSource = "center") => {
    setPreviewTabs((current) => {
      if (current.some((existing) => existing.id === tab.id)) {
        return current;
      }
      return [...current, tab];
    });
    setActivePreviewTabId(tab.id);
    setPreviewVisible(true);
    applyPreviewFocus(source);
  }, [applyPreviewFocus]);

  const handlePreviewArtifact = useCallback(
    (artifact: ArtifactWithVersions, version: ArtifactVersion) => {
      openPreviewTab({
        id: `artifact:${artifact.id}:${version.id}`,
        kind: "artifact",
        title: artifact.title,
        artifact,
        version,
      }, "right-panel");
    },
    [openPreviewTab],
  );

  const handlePreviewOutput = useCallback(
    (output: DetectedOutputForUI) => {
      openPreviewTab({
        id: `output:${output.runId}:${output.outputIndex}`,
        kind: "output",
        title: output.filename,
        output,
      }, "right-panel");
    },
    [openPreviewTab],
  );

  const handleSelectFile = useCallback((path: string) => {
    if (!selectedIssueId) return;
    openPreviewTab({
      id: `file:${selectedIssueId}:${path}`,
      kind: "file",
      title: path.split("/").pop() ?? path,
      issueId: selectedIssueId,
      path,
    }, "right-panel");
  }, [openPreviewTab, selectedIssueId]);

  const handleOpenAttachment = useCallback((att: IssueAttachment) => {
    openPreviewTab(
      {
        id: `asset:${att.assetId}`,
        kind: "asset",
        title: att.originalFilename ?? "Attachment",
        assetId: att.assetId,
        contentType: att.contentType ?? null,
        filename: att.originalFilename ?? "file",
        byteSize: att.byteSize ?? null,
      },
      "center",
    );
    setMobileTab("preview");
  }, [openPreviewTab, setMobileTab]);

  const handleOpenBrowser = useCallback((service: WorkspaceRuntimeService) => {
    if (!service.previewUrl) return;
    openPreviewTab({
      id: `browser:${service.id}`,
      kind: "browser",
      title: service.serviceName || "Browser",
      url: service.previewUrl,
      serviceId: service.id,
      localTargetUrl: service.localTargetUrl ?? null,
    }, "right-panel");
  }, [openPreviewTab]);

  const handleOpenGenericTab = useCallback((kind: PreviewTabKind) => {
    if (!selectedIssueId) return;
    if (kind === "home") {
      openPreviewTab({
        id: `home:${selectedIssueId}`,
        kind: "home",
        title: "Viewer",
        issueId: selectedIssueId,
      });
    } else if (kind === "logs") {
      openPreviewTab({
        id: `logs:${selectedIssueId}`,
        kind: "logs",
        title: "Logs",
        issueId: selectedIssueId,
      });
    } else if (kind === "browser") {
      openPreviewTab({
        id: `browser:manual:${workspace.id}:${Date.now()}`,
        kind: "browser",
        title: "Browser",
        url: "about:blank",
      });
    }
  }, [openPreviewTab, selectedIssueId, workspace.id]);

  const handleClosePreviewTab = useCallback((tabId: string) => {
    setPreviewTabs((current) => {
      const next = current.filter((tab) => tab.id !== tabId);
      if (next.length === 0) {
        setPreviewVisible(false);
      }
      setActivePreviewTabId((activeId) => {
        if (activeId !== tabId) return activeId;
        const closingIndex = current.findIndex((tab) => tab.id === tabId);
        return next[Math.max(0, closingIndex - 1)]?.id ?? next[0]?.id ?? null;
      });
      return next;
    });
  }, []);

  const handleTogglePreviewPanel = useCallback(() => {
    if (previewVisible) {
      setPreviewVisible(false);
      return;
    }
    if (previewTabs.length > 0) {
      setPreviewVisible(true);
      if (!activePreviewTabId) setActivePreviewTabId(previewTabs[0].id);
      applyPreviewFocus("center");
      return;
    }
    handleOpenGenericTab("home");
  }, [activePreviewTabId, applyPreviewFocus, handleOpenGenericTab, previewTabs, previewVisible]);

  useEffect(() => {
    setPreviewTabs((current) => {
      const next = current.filter((tab) => !("issueId" in tab) || tab.issueId === selectedIssueId);
      if (next.length === 0) setPreviewVisible(false);
      return next;
    });
    setActivePreviewTabId((activeId) => {
      const tab = previewTabs.find((candidate) => candidate.id === activeId);
      if (tab && "issueId" in tab && tab.issueId !== selectedIssueId) return null;
      return activeId;
    });
  // previewTabs is intentionally omitted so task changes perform one cleanup pass.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIssueId]);

  return (
    <div className="flex flex-col h-full overflow-hidden" data-testid="workspace-layout">
      {/* Archived banner */}
      {workspace.status === "archived" && (
        <div
          className="flex items-center justify-between gap-2 px-4 py-2 text-sm bg-amber-50 border-b border-amber-200 text-amber-800 dark:bg-amber-950/30 dark:border-amber-900 dark:text-amber-300 shrink-0"
          data-testid="workspace-archived-banner"
        >
          <div className="flex items-center gap-2 min-w-0">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>This workspace is archived</span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCloseReportOpen(true)}
              data-testid="workspace-view-close-report"
            >
              View close report
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => unarchiveMutation.mutate()}
              disabled={unarchiveMutation.isPending}
              data-testid="workspace-unarchive"
            >
              {unarchiveMutation.isPending ? "Unarchiving..." : "Unarchive"}
            </Button>
          </div>
        </div>
      )}

      {/* Header chrome — workspace title + actions kebab. Menu items are disabled pending later Phase I tasks. */}
      <WorkspaceErrorBoundary resetKey={`${workspace.id}:${selectedIssueId ?? "none"}:${isMobile ? "mobile" : "desktop"}`}>
        {isMobile ? (
          <>
          {/* Mobile tab bar */}
          <div className="flex border-b border-border shrink-0" data-testid="workspace-mobile-tabs">
            {MOBILE_TABS.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => setMobileTab(key)}
                className={cn(
                  "flex-1 flex items-center justify-center gap-1.5 px-2 py-2.5 text-xs font-medium transition-colors",
                  mobileTab === key
                    ? "text-primary border-b-2 border-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
                data-testid={`mobile-tab-${key}`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>

          {/* Mobile panels — all rendered, only active visible via CSS */}
          <div className="flex-1 min-h-0 relative">
            <div className={cn("absolute inset-0 overflow-auto", mobileTab !== "tasks" && "hidden")} data-testid="mobile-panel-tasks">
              <WorkspaceTaskNav
                companyId={companyId}
                companyPrefix={companyPrefix}
                projectId={workspace.projectId}
                selectedIssueId={selectedIssueId}
                onSelectIssue={onSelectIssue}
                onBack={onBack}
                departmentName={project?.name ?? "Department"}
              />
            </div>

            <div className={cn("absolute inset-0 overflow-hidden flex flex-col", mobileTab !== "timeline" && "hidden")} data-testid="mobile-panel-timeline">
              {selectedIssueId ? (
                <>
                  <div className="shrink-0 border-b border-border">
                    <DependencyChain
                      issueId={selectedIssueId}
                      companyId={companyId}
                      selectedIssueId={selectedIssueId}
                      onSelectIssue={onSelectIssue}
                    />
                  </div>
                  <div className="flex-1 min-h-0">
                    <WorkspaceTimeline issueId={selectedIssueId} onOpenAttachment={handleOpenAttachment} />
                  </div>
                </>
              ) : (
                <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                  Select a task to view its timeline
                </div>
              )}
            </div>

            <div className={cn("absolute inset-0 overflow-hidden", mobileTab !== "preview" && "hidden")} data-testid="mobile-panel-preview">
              {selectedIssueId ? (
                previewTabs.length > 0 ? (
                  <WorkspacePreviewPanel
                    companyId={companyId}
                    tabs={previewTabs}
                    activeTabId={activePreviewTab?.id ?? null}
                    onSelectTab={setActivePreviewTabId}
                    onCloseTab={handleClosePreviewTab}
                    onOpenTab={handleOpenGenericTab}
                    onOpenResolvedTab={openPreviewTab}
                    functionType={project?.functionType ?? null}
                    workspaceId={workspace.id}
                  />
                ) : (
                  <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                    Open a service, artifact, file, or log tab to preview it
                  </div>
                )
              ) : (
                <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                  Select a task to preview
                </div>
              )}
            </div>

            <div className={cn("absolute inset-0 overflow-auto", mobileTab !== "context" && "hidden")} data-testid="mobile-panel-context">
              {selectedIssueId ? (
                <WorkspaceRightPanel
                  issueId={selectedIssueId}
                  companyId={companyId}
                  companyPrefix={companyPrefix}
                  workspace={workspace}
                  functionType={project?.functionType ?? null}
                  previewMode={previewMode}
                  selectedFile={selectedFile}
                  onSelectFile={handleSelectFile}
                  onPreviewArtifact={handlePreviewArtifact}
                  onPreviewOutput={handlePreviewOutput}
                  onOpenBrowser={handleOpenBrowser}
                  selectedIssueIdentifier={selectedIssueIdentifier}
                  onOpenSettings={() => setSettingsOpen(true)}
                  onOpenArchive={() => setArchiveOpen(true)}
                />
              ) : (
                <div className="flex items-center justify-center h-full text-sm text-muted-foreground p-4 text-center">
                  Select a task to view context
                </div>
              )}
            </div>
          </div>
          </>
        ) : (
        /* Desktop layout — existing code */
        <div className="flex flex-1 min-h-0 gap-2 overflow-hidden bg-muted/30 p-2">
          {/* Left panel */}
          <div
            className={cn(
              "shrink-0 h-full overflow-hidden rounded-xl border border-border bg-background shadow-sm transition-[width] duration-200",
              leftCollapsed ? "w-[48px]" : "w-[250px]",
            )}
            data-testid="workspace-left-panel"
            data-collapsed={leftCollapsed ? "true" : "false"}
          >
            <WorkspaceTaskNav
              companyId={companyId}
              companyPrefix={companyPrefix}
              projectId={workspace.projectId}
              selectedIssueId={selectedIssueId}
              onSelectIssue={onSelectIssue}
              onBack={onBack}
              departmentName={project?.name ?? "Department"}
              collapsed={leftCollapsed}
              onToggleCollapse={() => setLeftCollapsed(!leftCollapsed)}
              onExpandAndShowGroup={handleExpandAndShowGroup}
              scrollToGroup={scrollToGroup}
            />
          </div>

          {/* Center */}
          <Group
            orientation="horizontal"
            className="h-full min-w-0 flex-1 overflow-hidden rounded-lg border border-border bg-background shadow-sm"
            defaultLayout={defaultLayout}
            onLayoutChanged={onLayoutChanged}
            data-testid="workspace-center-group"
          >
            <Panel
              id="center-left"
              minSize="20%"
              className="min-w-0 h-full overflow-hidden flex flex-col"
              data-testid="workspace-center-panel"
            >
              {selectedIssueId && (
                <div className="flex h-[42px] items-center gap-2 border-b border-border px-3 shrink-0" data-testid="workspace-center-header">
                  <div className="min-w-0 flex-1">
                    <DependencyChain
                      issueId={selectedIssueId}
                      companyId={companyId}
                      selectedIssueId={selectedIssueId}
                      onSelectIssue={onSelectIssue}
                    />
                  </div>
                  <div className="ml-auto shrink-0">
                    <PreviewPanelToggle
                      open={previewVisible && previewTabs.length > 0}
                      onToggle={handleTogglePreviewPanel}
                    />
                  </div>
                </div>
              )}

              {selectedIssueId ? (
                <WorkspaceTimeline issueId={selectedIssueId} onOpenAttachment={handleOpenAttachment} />
              ) : (
                <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                  Select a task to view its timeline
                </div>
              )}
            </Panel>

            {previewVisible && previewTabs.length > 0 && (
              <>
                <Separator
                  id="center-separator"
                  className="w-2 bg-muted/40 transition-colors hover:bg-brand/50 cursor-col-resize"
                  data-testid="workspace-resizable-handle"
                />
                <Panel
                  id="center-right"
                  minSize="20%"
                  className="min-w-0 h-full overflow-hidden bg-card"
                  data-testid="workspace-preview-panel"
                >
                  {selectedIssueId && (
                    <WorkspacePreviewPanel
                      companyId={companyId}
                      tabs={previewTabs}
                      activeTabId={activePreviewTab?.id ?? null}
                      onSelectTab={setActivePreviewTabId}
                      onCloseTab={handleClosePreviewTab}
                      onOpenTab={handleOpenGenericTab}
                      onOpenResolvedTab={openPreviewTab}
                      functionType={project?.functionType ?? null}
                      workspaceId={workspace.id}
                    />
                  )}
                </Panel>
              </>
            )}
          </Group>

          {/* Right panel */}
          <div
            className={cn(
              "shrink-0 h-full overflow-hidden rounded-xl border border-border bg-background shadow-sm transition-[width] duration-200",
              rightCollapsed ? "w-[48px]" : "w-[280px]",
            )}
            data-testid="workspace-right-panel"
            data-collapsed={rightCollapsed ? "true" : "false"}
          >
            {selectedIssueId ? (
              <WorkspaceRightPanel
                issueId={selectedIssueId}
                companyId={companyId}
                companyPrefix={companyPrefix}
                workspace={workspace}
                functionType={project?.functionType ?? null}
                previewMode={previewMode}
                selectedFile={selectedFile}
                onSelectFile={handleSelectFile}
                onPreviewArtifact={handlePreviewArtifact}
                onPreviewOutput={handlePreviewOutput}
                onOpenBrowser={handleOpenBrowser}
                collapsed={rightCollapsed}
                onToggleCollapse={() => setRightCollapsed(!rightCollapsed)}
                onExpandAndShowSection={handleExpandAndShowSection}
                openSection={openSectionRequest}
                selectedIssueIdentifier={selectedIssueIdentifier}
                onOpenSettings={() => setSettingsOpen(true)}
                onOpenArchive={() => setArchiveOpen(true)}
              />
            ) : (
              <div className="flex items-center justify-center h-full text-sm text-muted-foreground p-4 text-center">
                Select a task to view context
              </div>
            )}
          </div>
        </div>
        )}
      </WorkspaceErrorBoundary>

      {/* Archive / close flow dialog — opens from kebab. Only mounted when open
          to avoid unnecessary portal/query work on every WorkspaceLayout render. */}
      {archiveOpen && (
        <ExecutionWorkspaceCloseDialog
          workspaceId={workspace.id}
          open={archiveOpen}
          onOpenChange={setArchiveOpen}
          onArchived={invalidateWorkspace}
        />
      )}

      {/* Close report — read-only view of readiness data for archived workspaces.
          Conditional mount so test environments without portal polyfills stay quiet. */}
      <Sheet open={closeReportOpen} onOpenChange={setCloseReportOpen}>
        {closeReportOpen && (
        <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto" data-testid="workspace-close-report">
          <SheetHeader>
            <SheetTitle>Close report</SheetTitle>
            <SheetDescription>
              What happened (or would happen) when this workspace is archived.
            </SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-4 space-y-4">
            {closeReportQuery.isLoading && (
              <p className="text-sm text-muted-foreground">Loading report...</p>
            )}
            {closeReportQuery.data && (
              <>
                <div>
                  <div className="text-xs font-medium text-muted-foreground mb-1">State</div>
                  <Badge variant={closeReportQuery.data.state === "blocked" ? "destructive" : "secondary"}>
                    {closeReportQuery.data.state}
                  </Badge>
                </div>
                {closeReportQuery.data.warnings.length > 0 && (
                  <div>
                    <div className="text-xs font-medium text-muted-foreground mb-1">Warnings</div>
                    <ul className="text-sm space-y-1">
                      {closeReportQuery.data.warnings.map((w, i) => (
                        <li key={i}>• {w}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {closeReportQuery.data.plannedActions.length > 0 && (
                  <div>
                    <div className="text-xs font-medium text-muted-foreground mb-1">Planned actions</div>
                    <ol className="space-y-2 list-decimal ml-4">
                      {closeReportQuery.data.plannedActions.map((action, i) => (
                        <li key={i}>
                          <div className="text-sm font-medium">{action.label}</div>
                          <div className="text-xs text-muted-foreground">{action.description}</div>
                          {action.command && (
                            <code className="mt-1 block px-2 py-1 bg-muted rounded text-xs font-mono break-all">
                              {action.command}
                            </code>
                          )}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
              </>
            )}
          </div>
        </SheetContent>
        )}
      </Sheet>

      {settingsOpen && (
        <WorkspaceSettingsSheet
          workspaceId={workspace.id}
          companyId={workspace.companyId}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
        />
      )}
    </div>
  );
}

function PreviewPanelToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const Icon = open ? PanelRightClose : PanelRight;
  const label = open ? "Close preview" : "Open preview";

  return (
    <Button
      type="button"
      variant={open ? "secondary" : "ghost"}
      size="icon"
      className="h-7 w-7 shrink-0"
      title={label}
      aria-label={label}
      aria-pressed={open}
      data-testid="workspace-preview-toggle"
      onClick={onToggle}
    >
      <Icon className="h-3.5 w-3.5" />
    </Button>
  );
}
