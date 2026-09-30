import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Archive,
  Brain,
  FileBox,
  GitBranch,
  KeyRound,
  MoreVertical,
  PanelRight,
  PanelRightClose,
  Paperclip,
  Server,
  Settings,
  Workflow,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { agentsApi } from "../../api/agents";
import { activityApi } from "../../api/activity";
import { artifactsApi } from "../../api/artifacts";
import { dependenciesApi } from "../../api/dependencies";
import { executionWorkspacesApi, type GitFileEntry, type WorkspaceRuntimeService } from "../../api/execution-workspaces";
import { heartbeatsApi } from "../../api/heartbeats";
import { issuesApi } from "../../api/issues";
import { memoryRetrievalsApi } from "../../api/memoryRetrievals";
import { outputDetectionApi } from "../../api/output-detection";
import { taskOutputsApi } from "../../api/task-outputs";
import { queryKeys } from "../../lib/queryKeys";
import { ArtifactsSection } from "./sections/ArtifactsSection";
import { OutputsSection } from "./sections/OutputsSection";
import { ProcessSection } from "./sections/ProcessSection";
import { MemorySection } from "./sections/MemorySection";
import { ServicesSection } from "./sections/ServicesSection";
import { GitPanel } from "./tools/GitPanel";
import { CockpitSection } from "./cockpit/CockpitSection";
import type { PreviewMode } from "./WorkspacePreviewPanel";
import type { Agent, ArtifactWithVersions, ArtifactVersion, ExecutionWorkspace, DetectedOutputForUI } from "@armyofagents/shared";

function sectionKey(name: string) {
  return `aoa:workspace:cockpit:section:${name}`;
}

function loadExpanded(name: string): boolean {
  try {
    return localStorage.getItem(sectionKey(name)) === "true";
  } catch {
    return false;
  }
}

function saveExpanded(name: string, open: boolean) {
  try {
    localStorage.setItem(sectionKey(name), String(open));
  } catch {
    // Ignore storage failures.
  }
}

function limitExpandedSections(expanded: Record<string, boolean>): Record<string, boolean> {
  const openIds = WORKSPACE_COCKPIT_SECTIONS
    .map((section) => section.id)
    .filter((sectionId) => expanded[sectionId]);
  if (openIds.length <= MAX_EXPANDED_COCKPIT_SECTIONS) return expanded;

  const keepOpen = new Set(openIds.slice(-MAX_EXPANDED_COCKPIT_SECTIONS));
  const next = { ...expanded };
  for (const section of WORKSPACE_COCKPIT_SECTIONS) {
    next[section.id] = keepOpen.has(section.id);
  }
  return next;
}

interface WorkspaceRightPanelProps {
  issueId: string;
  companyId: string;
  companyPrefix: string;
  workspace: ExecutionWorkspace;
  functionType: string | null;
  previewMode: PreviewMode | null;
  selectedFile?: string | null;
  onSelectFile?: (path: string) => void;
  onPreviewArtifact?: (artifact: ArtifactWithVersions, version: ArtifactVersion) => void;
  onPreviewOutput?: (output: DetectedOutputForUI) => void;
  onOpenBrowser?: (service: WorkspaceRuntimeService) => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onExpandAndShowSection?: (sectionName: string) => void;
  openSection?: { section: string; nonce: number } | null;
  selectedIssueIdentifier?: string | null;
  onOpenSettings?: () => void;
  onOpenArchive?: () => void;
}

interface CockpitSectionDef {
  id: "process" | "git" | "services" | "outputs" | "artifacts" | "memory" | "context" | "access";
  title: string;
  icon: LucideIcon;
  softwareOnly?: boolean;
}

const WORKSPACE_COCKPIT_SECTIONS: CockpitSectionDef[] = [
  { id: "process", title: "Process", icon: Workflow },
  { id: "git", title: "Git", icon: GitBranch, softwareOnly: true },
  { id: "services", title: "Services", icon: Server, softwareOnly: true },
  { id: "outputs", title: "Outputs", icon: FileBox },
  { id: "artifacts", title: "Artifacts", icon: FileBox },
  { id: "memory", title: "Memory", icon: Brain },
  { id: "context", title: "Context", icon: Paperclip },
  { id: "access", title: "Access", icon: KeyRound },
];

const MAX_EXPANDED_COCKPIT_SECTIONS = 3;

type CockpitSummaryMap = Partial<Record<CockpitSectionDef["id"], string | null>>;

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function isUnavailablePreviewRuntimeService(service: WorkspaceRuntimeService): boolean {
  return (
    service.provider === "adapter_managed" &&
    !service.command &&
    !service.providerRef &&
    (service.status !== "running" || service.healthStatus === "unhealthy")
  );
}

function useCockpitSummaries({
  issueId,
  companyId,
  workspace,
  functionType,
}: {
  issueId: string;
  companyId: string;
  workspace: ExecutionWorkspace;
  functionType: string | null;
}): CockpitSummaryMap {
  const isSoftware = functionType === "software_development";

  const { data: issue } = useQuery({
    queryKey: queryKeys.issues.detail(issueId),
    queryFn: () => issuesApi.get(issueId),
    enabled: Boolean(issueId),
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: Boolean(companyId),
  });

  const { data: runs } = useQuery({
    queryKey: queryKeys.issues.runs(issueId),
    queryFn: () => activityApi.runsForIssue(issueId),
    enabled: Boolean(issueId),
  });

  const { data: activeRun } = useQuery({
    queryKey: queryKeys.issues.activeRun(issueId),
    queryFn: () => heartbeatsApi.activeRunForIssue(issueId),
    enabled: Boolean(issueId),
    refetchInterval: 5000,
  });

  const { data: deps } = useQuery({
    queryKey: queryKeys.issues.dependencies(issueId),
    queryFn: () => dependenciesApi.list(companyId, issueId),
    enabled: Boolean(companyId && issueId),
  });

  const { data: gitStatus } = useQuery({
    queryKey: ["workspace-git-status", workspace.id],
    queryFn: () => executionWorkspacesApi.getGitStatus(workspace.id),
    enabled: isSoftware && Boolean(workspace.cwd),
    refetchInterval: 10_000,
    staleTime: 8000,
  });

  const { data: services } = useQuery({
    queryKey: queryKeys.executionWorkspaces.runtimeServices(workspace.id),
    queryFn: () => executionWorkspacesApi.runtimeServices(workspace.id),
    enabled: isSoftware,
    refetchInterval: 3000,
    staleTime: 2500,
  });

  const { data: artifact } = useQuery({
    queryKey: queryKeys.artifacts.byIssue(issueId),
    queryFn: () => artifactsApi.getByIssueId(issueId),
    enabled: Boolean(issueId),
    staleTime: 5000,
  });

  const { data: detectedOutputs } = useQuery({
    queryKey: queryKeys.detectedOutputs.byIssue(issueId),
    queryFn: () => outputDetectionApi.listForIssue(issueId),
    enabled: Boolean(issueId),
    staleTime: 5000,
  });

  const { data: taskOutputs } = useQuery({
    queryKey: queryKeys.taskOutputs.byIssue(issueId),
    queryFn: () => taskOutputsApi.listForIssue(issueId),
    enabled: Boolean(issueId),
    staleTime: 5000,
  });

  const { data: memoryRetrievals } = useQuery({
    queryKey: queryKeys.memory.retrievalsForIssue(companyId, issueId),
    queryFn: () => memoryRetrievalsApi.listForIssue(companyId, issueId, { limit: 100 }),
    enabled: Boolean(companyId && issueId),
    staleTime: 5000,
  });

  const assignedAgent = agents?.find((agent: Agent) => agent.id === issue?.assigneeAgentId);
  const blockingTasks = (deps?.upstream ?? []).filter((d) => d.status !== "done" && d.status !== "completed");
  const processSummary = (() => {
    if (activeRun) return `Running · ${assignedAgent?.name ?? "agent"}`;
    if (issue?.status === "blocked") {
      return blockingTasks.length > 0 ? `Blocked · ${plural(blockingTasks.length, "blocker")}` : "Blocked";
    }
    const runCount = runs?.length ?? 0;
    if (runCount > 0) return `Idle · ${plural(runCount, "run")}`;
    if (assignedAgent) return `Idle · ${assignedAgent.name}`;
    return null;
  })();

  const gitSummary = (() => {
    if (!isSoftware || !workspace.cwd || !gitStatus) return null;
    if (!gitStatus.gitAvailable) return "Git unavailable";
    if (gitStatus.detachedHead) return "Detached HEAD";
    const files: GitFileEntry[] = gitStatus.files ?? [];
    const ahead = gitStatus.ahead ?? 0;
    const behind = gitStatus.behind ?? 0;
    const pr = (workspace.metadata as { pr?: { state?: string } } | null)?.pr;
    if (files.length > 0 && ahead > 0) return `${plural(files.length, "changed file")} · ${ahead} ahead`;
    if (files.length > 0) return plural(files.length, "changed file");
    if (ahead > 0 && behind > 0) return `Diverged · ${ahead} ahead`;
    if (behind > 0) return `${behind} behind`;
    if (ahead > 0) return `${ahead} ahead`;
    if (pr?.state) return `Clean · PR ${pr.state}`;
    if (!gitStatus.remote && !workspace.repoUrl) return "Local only";
    return gitStatus.clean ? "Clean" : null;
  })();

  const servicesSummary = (() => {
    if (!isSoftware || !services || services.length === 0) return null;
    const primaryServices = services.filter((service) => !isUnavailablePreviewRuntimeService(service));
    const running = primaryServices.filter((service) => service.status === "running");
    const failed = primaryServices.filter((service) => service.status === "failed");
    const starting = primaryServices.filter((service) => service.status === "starting");
    if (running.length === 1) return `1 running · ${running[0].serviceName}`;
    if (running.length > 1) return `${running.length} running`;
    if (starting.length > 0) return plural(starting.length, "starting service");
    if (failed.length > 0) return plural(failed.length, "failed service");
    if (primaryServices.length > 0) return plural(primaryServices.length, "stopped service");
    return "No running services";
  })();

  const artifactsSummary = (() => {
    const candidates = (detectedOutputs ?? []).filter((output) => output.status === "pending");
    const parts: string[] = [];
    if (artifact) parts.push("1 artifact");
    if (candidates.length > 0) parts.push(plural(candidates.length, "candidate"));
    return parts.length > 0 ? parts.join(" · ") : null;
  })();

  const outputsSummary = (() => {
    if (!taskOutputs || taskOutputs.length === 0) return null;
    const primary = taskOutputs.find((output) => output.isPrimary);
    if (primary) return `${plural(taskOutputs.length, "output")} · ${primary.title}`;
    return plural(taskOutputs.length, "output");
  })();

  const memorySummary = (() => {
    const total = memoryRetrievals?.length ?? 0;
    if (total === 0) return null;
    const filtered = (memoryRetrievals ?? []).filter((row) => !row.shownToAgent).length;
    if (filtered > 0) return `${plural(total, "retrieval")} · ${filtered} filtered`;
    return plural(total, "retrieval");
  })();

  return {
    process: processSummary,
    git: gitSummary,
    services: servicesSummary,
    outputs: outputsSummary,
    artifacts: artifactsSummary,
    memory: memorySummary,
    context: null,
    access: workspace.repoUrl ? "Repo connected" : null,
  };
}

export function WorkspaceRightPanel({
  issueId,
  companyId,
  companyPrefix,
  workspace,
  functionType,
  onPreviewArtifact,
  onPreviewOutput,
  onOpenBrowser,
  collapsed = false,
  onToggleCollapse,
  onExpandAndShowSection,
  openSection,
  selectedIssueIdentifier,
  onOpenSettings,
  onOpenArchive,
}: WorkspaceRightPanelProps) {
  const sections = WORKSPACE_COCKPIT_SECTIONS.filter(
    (section) => !section.softwareOnly || functionType === "software_development",
  );
  const summaries = useCockpitSummaries({ issueId, companyId, workspace, functionType });

  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const section of WORKSPACE_COCKPIT_SECTIONS) initial[section.id] = loadExpanded(section.id);
    return limitExpandedSections(initial);
  });

  const setSectionOpen = useCallback((id: string, open: boolean) => {
    setExpanded((prev) => {
      let next = { ...prev, [id]: open };

      if (open) {
        const openIds = WORKSPACE_COCKPIT_SECTIONS
          .map((section) => section.id)
          .filter((sectionId) => sectionId !== id && prev[sectionId]);
        const keepOpen = new Set([...openIds, id].slice(-MAX_EXPANDED_COCKPIT_SECTIONS));
        next = { ...prev };
        for (const section of WORKSPACE_COCKPIT_SECTIONS) {
          next[section.id] = keepOpen.has(section.id);
        }
      }

      for (const section of WORKSPACE_COCKPIT_SECTIONS) {
        if (prev[section.id] !== next[section.id]) {
          saveExpanded(section.id, Boolean(next[section.id]));
        }
      }

      return next;
    });
  }, []);

  useEffect(() => {
    if (!openSection || collapsed) return;
    setSectionOpen(openSection.section, true);
  }, [collapsed, openSection, setSectionOpen]);

  if (collapsed) {
    return (
      <div
        className="flex h-full flex-col items-center gap-1"
        data-testid="workspace-right-panel-collapsed"
      >
        <div className="flex h-[42px] w-full shrink-0 items-center justify-center border-b border-border" data-testid="workspace-cockpit-header">
          <button
            type="button"
            onClick={onToggleCollapse}
            title="Expand context"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            data-testid="workspace-right-panel-expand"
            aria-label="Expand context panel"
          >
            <PanelRight className="h-4 w-4" />
          </button>
        </div>
        <WorkspaceCockpitMenu
          workspace={workspace}
          onOpenSettings={onOpenSettings}
          onOpenArchive={onOpenArchive}
          triggerClassName="h-7 w-7"
        />
        <div className="my-1 h-px w-6 bg-border" />
        {sections.map((section) => {
          const Icon = section.icon;
          return (
            <button
              key={section.id}
              type="button"
              onClick={() => onExpandAndShowSection?.(section.id)}
              title={section.title}
              className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
              data-testid={`workspace-rail-section-${section.id}`}
              aria-label={section.title}
            >
              <Icon className="h-4 w-4" />
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden" data-testid="workspace-right-panel-expanded">
      <div
        className="flex h-[42px] shrink-0 items-center gap-1 overflow-hidden border-b border-border px-2"
        data-testid="workspace-cockpit-header"
      >
        {onToggleCollapse && (
          <button
            type="button"
            onClick={onToggleCollapse}
            title="Collapse context"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            data-testid="workspace-right-panel-collapse"
            aria-label="Collapse context panel"
          >
            <PanelRightClose className="h-4 w-4" />
          </button>
        )}
        <div
          className="min-w-0 flex-1 truncate pl-1 text-xs font-semibold text-foreground"
          data-testid="workspace-cockpit-title"
          title={selectedIssueIdentifier ? `Cockpit · ${selectedIssueIdentifier}` : "Cockpit"}
        >
          {selectedIssueIdentifier ? `Cockpit · ${selectedIssueIdentifier}` : "Cockpit"}
        </div>
        <WorkspaceCockpitMenu
          workspace={workspace}
          onOpenSettings={onOpenSettings}
          onOpenArchive={onOpenArchive}
          triggerClassName="h-7 w-7"
        />
      </div>
      <ScrollArea className="min-h-0 min-w-0 flex-1 overflow-hidden" data-testid="workspace-right-panel-scroll">
        <div className="w-full min-w-0 max-w-full space-y-2 overflow-hidden px-2 py-2" data-testid="workspace-right-sections">
          {sections.map((section) => {
            const isOpen = expanded[section.id] ?? false;
            return (
              <CockpitSection
                key={section.id}
                id={section.id}
                title={section.title}
                summary={summaries[section.id]}
                icon={section.icon}
                open={isOpen}
                onOpenChange={(open) => setSectionOpen(section.id, open)}
              >
                {section.id === "process" && (
                  <ProcessSection issueId={issueId} companyId={companyId} companyPrefix={companyPrefix} />
                )}
                {section.id === "context" && <ContextCockpitSection workspace={workspace} />}
                {section.id === "outputs" && (
                  <OutputsSection issueId={issueId} onPreviewArtifact={onPreviewArtifact} onOpenBrowser={onOpenBrowser} />
                )}
                {section.id === "artifacts" && (
                  <ArtifactsSection issueId={issueId} onPreviewArtifact={onPreviewArtifact} onPreviewOutput={onPreviewOutput} />
                )}
                {section.id === "git" && (
                  <GitPanel workspace={workspace} issueId={issueId} isExpanded />
                )}
                {section.id === "services" && <ServicesSection workspace={workspace} onOpenBrowser={onOpenBrowser} />}
                {section.id === "memory" && (
                  <MemorySection issueId={issueId} companyId={companyId} companyPrefix={companyPrefix} />
                )}
                {section.id === "access" && <AccessCockpitSection workspace={workspace} />}
              </CockpitSection>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}

function WorkspaceCockpitMenu({
  workspace,
  onOpenSettings,
  onOpenArchive,
  triggerClassName = "h-7 w-7",
}: {
  workspace: ExecutionWorkspace;
  onOpenSettings?: () => void;
  onOpenArchive?: () => void;
  triggerClassName?: string;
}) {
  if (!onOpenSettings && !onOpenArchive) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="Workspace actions"
          aria-label="Workspace actions"
          data-testid="workspace-cockpit-menu-trigger"
          className={`flex ${triggerClassName} items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground`}
        >
          <MoreVertical className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {onOpenSettings && (
          <DropdownMenuItem onClick={onOpenSettings} data-testid="workspace-cockpit-menu-settings">
            <Settings className="mr-2 h-4 w-4" />
            Settings
          </DropdownMenuItem>
        )}
        {onOpenArchive && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={onOpenArchive}
              disabled={workspace.status === "archived"}
              variant="destructive"
              data-testid="workspace-cockpit-menu-archive"
            >
              <Archive className="mr-2 h-4 w-4" />
              Archive
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ContextCockpitSection({ workspace }: { workspace: ExecutionWorkspace }) {
  return (
    <div className="min-w-0 max-w-full space-y-2 overflow-hidden text-xs" data-testid="context-cockpit-section">
      <div className="flex min-w-0 justify-between gap-2 overflow-hidden">
        <span className="shrink-0 text-muted-foreground">Workspace</span>
        <span className="min-w-0 truncate font-mono">{workspace.name}</span>
      </div>
      <div className="flex min-w-0 justify-between gap-2 overflow-hidden">
        <span className="shrink-0 text-muted-foreground">Mode</span>
        <span className="min-w-0 truncate">{workspace.mode}</span>
      </div>
    </div>
  );
}

function AccessCockpitSection({ workspace }: { workspace: ExecutionWorkspace }) {
  return (
    <div className="min-w-0 max-w-full space-y-2 overflow-hidden text-xs" data-testid="access-cockpit-section">
      <div className="flex min-w-0 justify-between gap-2 overflow-hidden">
        <span className="shrink-0 text-muted-foreground">Secrets</span>
        <span className="min-w-0 truncate">names only</span>
      </div>
      <div className="flex min-w-0 justify-between gap-2 overflow-hidden">
        <span className="shrink-0 text-muted-foreground">Repo</span>
        <span className="min-w-0 truncate">{workspace.repoUrl ? "configured" : "local only"}</span>
      </div>
      <div className="flex min-w-0 justify-between gap-2 overflow-hidden">
        <span className="shrink-0 text-muted-foreground">Deploy</span>
        <span className="min-w-0 truncate">approval gated</span>
      </div>
    </div>
  );
}
