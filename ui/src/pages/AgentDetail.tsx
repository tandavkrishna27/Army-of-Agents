import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { useParams, useNavigate, Link, useBeforeUnload } from "@/lib/router";
import { useUnsavedChanges } from "@/hooks/useUnsavedChanges";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { agentsApi, type AgentKey, type ClaudeLoginResult } from "../api/agents";
import { companySkillsApi } from "../api/companySkills";
import type { CompanySkillListItem } from "@armyofagents/shared";
import { heartbeatsApi } from "../api/heartbeats";
import { trustScoresApi } from "../api/trust-scores";
import { ApiError } from "../api/client";
import { ChartCard, RunActivityChart, PriorityChart, IssueStatusChart, SuccessRateChart } from "../components/ActivityCharts";
import { activityApi } from "../api/activity";
import { issuesApi } from "../api/issues";
import { useSidebar } from "../context/SidebarContext";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { AgentConfigForm } from "../components/AgentConfigForm";
import { AgentSaveWarnings } from "../components/AgentSaveWarnings";
import { AgentInstructionsTab } from "../components/AgentInstructionsTab";
import { roleLabels } from "../components/agent-config-primitives";
// Tabs and PageTabBar are now used via AgentDetailCore
import { getUIAdapter, buildTranscript } from "../adapters";
import type { TranscriptEntry } from "../adapters";
import { StatusBadge } from "../components/StatusBadge";
import { agentStatusDot, agentStatusDotDefault } from "../lib/status-colors";
import { MarkdownBody } from "../components/MarkdownBody";
import { CopyText } from "../components/CopyText";
import { EntityRow } from "../components/EntityRow";
import { Identity } from "../components/Identity";
import { PageSkeleton } from "../components/PageSkeleton";
import { formatCents, formatDate, relativeTime, formatTokens } from "../lib/utils";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  MoreHorizontal,
  Play,
  Pause,
  CheckCircle2,
  XCircle,
  Clock,
  Timer,
  Loader2,
  Slash,
  RotateCcw,
  Trash2,
  Plus,
  Key,
  Eye,
  EyeOff,
  Copy,
  ChevronRight,
  ChevronDown,
  ArrowLeft,
  Settings,
  Shield,
  History,
  Search,
  User,
  Plug,
  SlidersHorizontal,
  Heart,
  Brain,
  PanelLeftClose,
  PanelLeftOpen,
  type LucideIcon,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/context/ToastContext";
import { AgentIcon, AgentIconPicker } from "../components/AgentIconPicker";
import { AgentTrustScoreCard } from "../components/AgentTrustScoreCard";
import { isUuidLike, type Agent, type HeartbeatRun, type HeartbeatRunEvent, type AgentRuntimeState, type LiveEvent } from "@armyofagents/shared";
import { agentRouteRef } from "../lib/utils";
import { AgentDetailCore } from "../components/agent-detail/AgentDetailCore";
import { AgentSkillsTab } from "../components/agent-detail/AgentSkillsTab";
import { Group, Panel, Separator } from "react-resizable-panels";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { asRecord, usageNumber, runMetrics } from "../lib/run-metrics";
import { computeAgentKpis } from "../lib/agent-kpis";
import { formatTrustScorePercent, hasTrustScoreData } from "../lib/trust-score";
import type { HeroKpi } from "../components/agent-detail/AgentHeroCard";
import { formatEnvForDisplay } from "../lib/env-redaction";
import { formatDuration } from "../lib/run-status";
import { parseAgentDetailView, type AgentDetailView } from "../lib/agent-detail-view";

const runStatusIcons: Record<string, { icon: typeof CheckCircle2; color: string }> = {
  succeeded: { icon: CheckCircle2, color: "text-green-600 dark:text-green-400" },
  failed: { icon: XCircle, color: "text-red-600 dark:text-red-400" },
  running: { icon: Loader2, color: "text-cyan-600 dark:text-cyan-400" },
  queued: { icon: Clock, color: "text-yellow-600 dark:text-yellow-400" },
  timed_out: { icon: Timer, color: "text-orange-600 dark:text-orange-400" },
  cancelled: { icon: Slash, color: "text-neutral-500 dark:text-neutral-400" },
};

const sourceLabels: Record<string, string> = {
  timer: "Timer",
  assignment: "Assignment",
  on_demand: "On-demand",
  automation: "Automation",
};

const LIVE_SCROLL_BOTTOM_TOLERANCE_PX = 32;
type ScrollContainer = Window | HTMLElement;

function isWindowContainer(container: ScrollContainer): container is Window {
  return container === window;
}

function isElementScrollContainer(element: HTMLElement): boolean {
  const overflowY = window.getComputedStyle(element).overflowY;
  return overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
}

function findScrollContainer(anchor: HTMLElement | null): ScrollContainer {
  let parent = anchor?.parentElement ?? null;
  while (parent) {
    if (isElementScrollContainer(parent)) return parent;
    parent = parent.parentElement;
  }
  return window;
}

function readScrollMetrics(container: ScrollContainer): { scrollHeight: number; distanceFromBottom: number } {
  if (isWindowContainer(container)) {
    const pageHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight,
    );
    const viewportBottom = window.scrollY + window.innerHeight;
    return {
      scrollHeight: pageHeight,
      distanceFromBottom: Math.max(0, pageHeight - viewportBottom),
    };
  }

  const viewportBottom = container.scrollTop + container.clientHeight;
  return {
    scrollHeight: container.scrollHeight,
    distanceFromBottom: Math.max(0, container.scrollHeight - viewportBottom),
  };
}

function scrollToContainerBottom(container: ScrollContainer, behavior: ScrollBehavior = "auto") {
  if (isWindowContainer(container)) {
    const pageHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight,
    );
    window.scrollTo({ top: pageHeight, behavior });
    return;
  }

  container.scrollTo({ top: container.scrollHeight, behavior });
}

export function getAdapterResultOutput(
  run: Pick<HeartbeatRun, "resultJson" | "status">,
  adapterType: string,
): { stdout: string | null; stderr: string | null } | null {
  if (adapterType !== "process") return null;
  if (run.status === "failed" || run.status === "timed_out") return null;

  const result = asRecord(run.resultJson);
  if (!result) return null;

  const stdout = typeof result.stdout === "string" && result.stdout.trim() ? result.stdout : null;
  const stderr = typeof result.stderr === "string" && result.stderr.trim() ? result.stderr : null;
  if (!stdout && !stderr) return null;

  return { stdout, stderr };
}

type RunLogChunk = { ts: string; stream: "stdout" | "stderr" | "system"; chunk: string };

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Shared agent-detail data orchestration. Runs the six queries the detail page
 * needs (agent, runtimeState, heartbeats, all-issues, all-agents, trustScore)
 * and derives the assigned-issues / org / mobile-live-run views from them.
 *
 * Consumed by both the route page ({@link AgentDetail}, keyed on the URL param)
 * and the Inbox Hub tab host ({@link AgentDetailContainer}, keyed on a prop).
 * The hook itself reads no route state — the caller resolves `agentRef` +
 * `lookupCompanyId` from wherever it lives.
 */
export function useAgentDetailData({
  agentRef,
  lookupCompanyId,
  selectedCompanyId,
}: {
  agentRef: string;
  lookupCompanyId: string | undefined;
  selectedCompanyId: string | null;
}) {
  const canFetchAgent =
    agentRef.length > 0 && (isUuidLike(agentRef) || Boolean(lookupCompanyId));

  const { data: agent, isLoading, error } = useQuery({
    queryKey: [...queryKeys.agents.detail(agentRef), lookupCompanyId ?? null],
    queryFn: () => agentsApi.get(agentRef, lookupCompanyId),
    enabled: canFetchAgent,
  });
  const resolvedCompanyId = agent?.companyId ?? selectedCompanyId;
  const canonicalAgentRef = agent ? agentRouteRef(agent) : agentRef;
  const agentLookupRef = agent?.id ?? agentRef;
  const resolvedAgentId = agent?.id ?? null;

  const { data: runtimeState } = useQuery({
    queryKey: queryKeys.agents.runtimeState(resolvedAgentId ?? agentRef),
    queryFn: () => agentsApi.runtimeState(resolvedAgentId!, resolvedCompanyId ?? undefined),
    enabled: Boolean(resolvedAgentId),
  });

  const { data: heartbeats } = useQuery({
    queryKey: queryKeys.heartbeats(resolvedCompanyId!, agent?.id ?? undefined),
    queryFn: () => heartbeatsApi.list(resolvedCompanyId!, agent?.id ?? undefined),
    enabled: !!resolvedCompanyId && !!agent?.id,
  });

  const { data: allIssues } = useQuery({
    // A CREW agent's detail page must show its own crew tasks; the 'org'
    // default would make assignedIssues empty. Distinct cache key from the
    // org-default board list to avoid poisoning the main Tasks board.
    queryKey: [...queryKeys.issues.list(resolvedCompanyId!), "scope-all"],
    queryFn: () => issuesApi.list(resolvedCompanyId!, { taskScope: "all" }),
    enabled: !!resolvedCompanyId,
  });

  const { data: allAgents } = useQuery({
    queryKey: queryKeys.agents.list(resolvedCompanyId!),
    queryFn: () => agentsApi.list(resolvedCompanyId!),
    enabled: !!resolvedCompanyId,
  });

  const { data: trustScore } = useQuery({
    queryKey: resolvedCompanyId && resolvedAgentId ? queryKeys.trustScores.detail(resolvedCompanyId, resolvedAgentId) : ["trust-scores", "disabled"],
    queryFn: () => trustScoresApi.get(resolvedCompanyId!, resolvedAgentId!),
    enabled: !!resolvedCompanyId && !!resolvedAgentId,
  });

  const assignedIssues = (allIssues ?? [])
    .filter((i) => i.assigneeAgentId === agent?.id)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  const reportsToAgent = (allAgents ?? []).find((a) => a.id === agent?.reportsTo);
  const directReports = (allAgents ?? []).filter((a) => a.reportsTo === agent?.id && a.status !== "terminated");
  const mobileLiveRun = (heartbeats ?? []).find((r) => r.status === "running" || r.status === "queued") ?? null;

  return {
    agent,
    isLoading,
    error,
    resolvedCompanyId,
    canonicalAgentRef,
    agentLookupRef,
    resolvedAgentId,
    runtimeState,
    heartbeats,
    assignedIssues,
    reportsToAgent: reportsToAgent ?? null,
    directReports,
    trustScore,
    mobileLiveRun,
  };
}

export function AgentDetail() {
  const { companyPrefix, agentId, tab: urlTab, runId: urlRunId } = useParams<{
    companyPrefix?: string;
    agentId: string;
    tab?: string;
    runId?: string;
  }>();
  const { companies, selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { openNewIssue } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pushToast } = useToast();
  const [actionError, setActionError] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [terminateConfirmOpen, setTerminateConfirmOpen] = useState(false);
  // Pending in-app navigation held back by the unsaved-changes guard.
  const activeView = urlRunId ? "runs" as AgentDetailView : parseAgentDetailView(urlTab ?? null);
  const [configDirty, setConfigDirty] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const saveConfigActionRef = useRef<(() => void) | null>(null);
  const cancelConfigActionRef = useRef<(() => void) | null>(null);
  const [instrDirty, setInstrDirty] = useState(false);
  const [instrSaving, setInstrSaving] = useState(false);
  const saveInstrActionRef = useRef<(() => void) | null>(null);
  const cancelInstrActionRef = useRef<(() => void) | null>(null);
  const { isMobile } = useSidebar();
  const routeAgentRef = agentId ?? "";
  const routeCompanyId = useMemo(() => {
    if (!companyPrefix) return null;
    const requestedPrefix = companyPrefix.toUpperCase();
    return companies.find((company) => company.issuePrefix.toUpperCase() === requestedPrefix)?.id ?? null;
  }, [companies, companyPrefix]);
  const lookupCompanyId = routeCompanyId ?? selectedCompanyId ?? undefined;
  const setSaveConfigAction = useCallback((fn: (() => void) | null) => { saveConfigActionRef.current = fn; }, []);
  const setCancelConfigAction = useCallback((fn: (() => void) | null) => { cancelConfigActionRef.current = fn; }, []);
  const setSaveInstrAction = useCallback((fn: (() => void) | null) => { saveInstrActionRef.current = fn; }, []);
  const setCancelInstrAction = useCallback((fn: (() => void) | null) => { cancelInstrActionRef.current = fn; }, []);

  const {
    agent,
    isLoading,
    error,
    resolvedCompanyId,
    canonicalAgentRef,
    agentLookupRef,
    runtimeState,
    heartbeats,
    assignedIssues,
    reportsToAgent,
    directReports,
    trustScore,
    mobileLiveRun,
  } = useAgentDetailData({ agentRef: routeAgentRef, lookupCompanyId, selectedCompanyId });

  useEffect(() => {
    if (!agent) return;
    if (routeAgentRef === canonicalAgentRef) return;
    if (urlRunId) {
      navigate(`/agents/${canonicalAgentRef}/runs/${urlRunId}`, { replace: true });
      return;
    }
    if (urlTab) {
      navigate(`/agents/${canonicalAgentRef}/${urlTab}`, { replace: true });
      return;
    }
    navigate(`/agents/${canonicalAgentRef}`, { replace: true });
  }, [agent, routeAgentRef, canonicalAgentRef, urlRunId, urlTab, navigate]);

  useEffect(() => {
    if (!agent?.companyId || agent.companyId === selectedCompanyId) return;
    setSelectedCompanyId(agent.companyId, { source: "route_sync" });
  }, [agent?.companyId, selectedCompanyId, setSelectedCompanyId]);

  const agentAction = useMutation({
    mutationFn: async (action: "invoke" | "pause" | "resume" | "terminate") => {
      if (!agentLookupRef) return Promise.reject(new Error("No agent reference"));
      switch (action) {
        case "invoke": return agentsApi.invoke(agentLookupRef, resolvedCompanyId ?? undefined);
        case "pause": return agentsApi.pause(agentLookupRef, resolvedCompanyId ?? undefined);
        case "resume": return agentsApi.resume(agentLookupRef, resolvedCompanyId ?? undefined);
        case "terminate": return agentsApi.terminate(agentLookupRef, resolvedCompanyId ?? undefined);
      }
    },
    onSuccess: (data, action) => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(routeAgentRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentLookupRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.runtimeState(agentLookupRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.taskSessions(agentLookupRef) });
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(resolvedCompanyId) });
        if (agent?.id) {
          queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(resolvedCompanyId, agent.id) });
        }
      }
      if (action === "invoke" && data && typeof data === "object" && "id" in data) {
        navigate(`/agents/${canonicalAgentRef}/runs/${(data as HeartbeatRun).id}`);
      }
      if (action === "terminate") {
        pushToast({ title: `${agent?.name ?? "Agent"} terminated`, body: "The agent was stopped and removed from the roster.", tone: "success" });
        navigate("/agents");
      }
    },
    onError: (err, action) => {
      const message = err instanceof Error ? err.message : "Action failed";
      setActionError(message);
      if (action === "terminate") {
        pushToast({ title: "Failed to terminate agent", body: message, tone: "error" });
      }
    },
  });

  const updateIcon = useMutation({
    mutationFn: (icon: string) => agentsApi.update(agentLookupRef, { icon }, resolvedCompanyId ?? undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(routeAgentRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentLookupRef) });
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(resolvedCompanyId) });
      }
    },
  });

  const resetTaskSession = useMutation({
    mutationFn: (taskKey: string | null) =>
      agentsApi.resetSession(agentLookupRef, taskKey, resolvedCompanyId ?? undefined),
    onSuccess: () => {
      setActionError(null);
      pushToast({ title: "Agent session reset", body: "The next run starts a fresh session (no resumed context).", tone: "success" });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.runtimeState(agentLookupRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.taskSessions(agentLookupRef) });
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : "Failed to reset session";
      setActionError(message);
      pushToast({ title: "Failed to reset session", body: message, tone: "error" });
    },
  });

  const updatePermissions = useMutation({
    mutationFn: (canCreateAgents: boolean) =>
      agentsApi.updatePermissions(agentLookupRef, { canCreateAgents }, resolvedCompanyId ?? undefined),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(routeAgentRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentLookupRef) });
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(resolvedCompanyId) });
      }
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to update permissions");
    },
  });

  useEffect(() => {
    const crumbs: { label: string; href?: string }[] = [
      { label: "Agents", href: "/agents" },
    ];
    const agentName = agent?.name ?? routeAgentRef ?? "Agent";
    if (activeView === "overview" && !urlRunId) {
      crumbs.push({ label: agentName });
    } else {
      crumbs.push({ label: agentName, href: `/agents/${canonicalAgentRef}` });
      if (urlRunId) {
        crumbs.push({ label: "Runs", href: `/agents/${canonicalAgentRef}/runs` });
        crumbs.push({ label: `Run ${urlRunId.slice(0, 8)}` });
      } else if (activeView === "configure") {
        crumbs.push({ label: "Configure" });
      } else if (activeView === "runs") {
        crumbs.push({ label: "Runs" });
      }
    }
    setBreadcrumbs(crumbs);
  }, [setBreadcrumbs, agent, routeAgentRef, canonicalAgentRef, activeView, urlRunId]);

  useBeforeUnload(
    useCallback((event) => {
      if (!configDirty && !instrDirty) return;
      event.preventDefault();
      event.returnValue = "";
    }, [configDirty, instrDirty]),
  );

  // Global cross-page guard (sidebar <Link> + browser Back/Forward + any in-app
  // navigate). Tab-close/refresh stays covered by useBeforeUnload above
  // (useBlocker can't catch it).
  useUnsavedChanges(configDirty || instrDirty);

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!agent) return null;
  const isPendingApproval = agent.status === "pending_approval";
  const showActionBar = (activeView === "configure" && configDirty) || (activeView === "instructions" && instrDirty);

  // Tab navigation is a plain navigate now — a dirty cross-tab switch (each tab
  // is a distinct pathname) is intercepted by the global UnsavedChangesProvider.
  const viewPath = (v: string) =>
    v === "overview" ? `/agents/${canonicalAgentRef}` : `/agents/${canonicalAgentRef}/${v}`;
  const handleViewChange = (v: string) => {
    if (v === activeView) return;
    navigate(viewPath(v));
  };
  const activeSaving = activeView === "instructions" ? instrSaving : configSaving;
  const activeSaveRef = activeView === "instructions" ? saveInstrActionRef : saveConfigActionRef;
  const activeCancelRef = activeView === "instructions" ? cancelInstrActionRef : cancelConfigActionRef;

  const workerHeaderActions = (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => openNewIssue({ assigneeAgentId: agent.id })}
      >
        <Plus className="h-3.5 w-3.5 sm:mr-1" />
        <span className="hidden sm:inline">Assign Task</span>
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => agentAction.mutate("invoke")}
        disabled={agentAction.isPending || isPendingApproval}
      >
        <Play className="h-3.5 w-3.5 sm:mr-1" />
        <span className="hidden sm:inline">Invoke</span>
      </Button>
      {agent.status === "paused" ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => agentAction.mutate("resume")}
          disabled={agentAction.isPending || isPendingApproval}
        >
          <Play className="h-3.5 w-3.5 sm:mr-1" />
          <span className="hidden sm:inline">Resume</span>
        </Button>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => agentAction.mutate("pause")}
          disabled={agentAction.isPending || isPendingApproval}
        >
          <Pause className="h-3.5 w-3.5 sm:mr-1" />
          <span className="hidden sm:inline">Pause</span>
        </Button>
      )}
      {mobileLiveRun && (
        <Link
          to={`/agents/${canonicalAgentRef}/runs/${mobileLiveRun.id}`}
          className="sm:hidden flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-blue-500/10 hover:bg-blue-500/20 transition-colors no-underline"
        >
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
          </span>
          <span className="text-[11px] font-medium text-blue-600 dark:text-blue-400">Live</span>
        </Link>
      )}
      {/* Overflow menu */}
      <Popover open={moreOpen} onOpenChange={setMoreOpen}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon-xs">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-44 p-1" align="end">
          <button
            className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50"
            onClick={() => {
              setMoreOpen(false);
              handleViewChange("configure");
            }}
          >
            <Settings className="h-3 w-3" />
            Configure Agent
          </button>
          <button
            className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50"
            onClick={() => {
              navigator.clipboard.writeText(agent.id);
              pushToast({ title: "Agent ID copied", tone: "success" });
              setMoreOpen(false);
            }}
          >
            <Copy className="h-3 w-3" />
            Copy Agent ID
          </button>
          <button
            className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50"
            title="Clear the agent's saved runtime session so the next run starts fresh (no resumed context)."
            onClick={() => {
              resetTaskSession.mutate(null);
              setMoreOpen(false);
            }}
          >
            <RotateCcw className="h-3 w-3" />
            Reset Sessions
          </button>
          <button
            className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-destructive"
            title="Stop this agent and remove it from the roster."
            onClick={() => {
              setMoreOpen(false);
              setTerminateConfirmOpen(true);
            }}
          >
            <Trash2 className="h-3 w-3" />
            Terminate
          </button>
        </PopoverContent>
      </Popover>
    </>
  );

  // Hero KPI strip (mirrors Overview stats; Overview cards removed in Phase 3)
  const heroKpiStats = computeAgentKpis({ runs: heartbeats ?? [], assignedIssues });
  const latestHeroRun = [...(heartbeats ?? [])].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )[0];
  const heroModel =
    typeof (agent.adapterConfig as Record<string, unknown> | null)?.model === "string"
      ? ((agent.adapterConfig as Record<string, unknown>).model as string)
      : undefined;
  // AgentHeroCard renders KPI links with a plain Link (no company-prefix helper),
  // so prefix the deep-links here to match the rest of the app's routing.
  const heroLinkPrefix = companyPrefix ? `/${companyPrefix}` : "";
  const heroKpis: HeroKpi[] = [
    { key: "tasks", label: "Tasks (wk)", value: heroKpiStats.tasksCompleted, to: `${heroLinkPrefix}/issues?assignee=${agent.id}` },
    { key: "success", label: "Success", value: heroKpiStats.successRate !== null ? `${heroKpiStats.successRate}%` : "—" },
    { key: "cost", label: "Cost (wk)", value: `$${heroKpiStats.cost.toFixed(2)}` },
    {
      key: "trust",
      label: "Trust",
      value: trustScore && hasTrustScoreData(trustScore) ? formatTrustScorePercent(trustScore.currentScore) : "—",
    },
    {
      key: "last-run",
      label: "Last run",
      value: latestHeroRun ? relativeTime(latestHeroRun.createdAt) : "—",
      to: latestHeroRun ? `${heroLinkPrefix}/agents/${canonicalAgentRef}/runs/${latestHeroRun.id}` : undefined,
    },
    {
      key: "last-heartbeat",
      label: "Last heartbeat",
      value: agent.lastHeartbeatAt ? relativeTime(agent.lastHeartbeatAt) : "Never",
    },
  ];

  return (
    <>
      {isPendingApproval && (
        <p className="text-sm text-amber-500">
          This agent is pending board approval and cannot be invoked yet.
        </p>
      )}
      <AgentDetailCore
        agent={agent}
        tabs={[
          { value: "overview", label: "Overview" },
          { value: "instructions", label: "Instructions" },
          { value: "runs", label: "Runs" },
          { value: "skills", label: "Skills" },
          { value: "configure", label: "Config" },
        ]}
        activeView={activeView}
        onViewChange={handleViewChange}
        headerActions={workerHeaderActions}
        heroKpis={heroKpis}
        heroBadges={{ adapter: agent.adapterType, model: heroModel }}
        headerError={actionError}
        actionBar={{
          show: showActionBar,
          saving: activeSaving,
          onSave: () => activeSaveRef.current?.(),
          onCancel: () => activeCancelRef.current?.(),
        }}
        urlRunId={urlRunId}
        isMobile={isMobile}
        onIconChange={(icon) => updateIcon.mutate(icon)}
        renderTab={(view) => {
          if (view === "overview") {
            return (
              <AgentOverview
                agent={agent}
                runs={heartbeats ?? []}
                assignedIssues={assignedIssues}
                runtimeState={runtimeState}
                reportsToAgent={reportsToAgent ?? null}
                directReports={directReports}
                agentId={agent.id}
                agentRouteId={canonicalAgentRef}
                trustScore={trustScore}
              />
            );
          }
          if (view === "instructions") {
            return (
              <AgentInstructionsTab
                agent={agent}
                companyId={resolvedCompanyId ?? undefined}
                onDirtyChange={setInstrDirty}
                onSaveActionChange={setSaveInstrAction}
                onCancelActionChange={setCancelInstrAction}
                onSavingChange={setInstrSaving}
              />
            );
          }
          if (view === "configure") {
            return (
              <AgentConfigurePage
                agent={agent}
                agentId={agent.id}
                companyId={resolvedCompanyId ?? undefined}
                onDirtyChange={setConfigDirty}
                onSaveActionChange={setSaveConfigAction}
                onCancelActionChange={setCancelConfigAction}
                onSavingChange={setConfigSaving}
                updatePermissions={updatePermissions}
                isMobile={isMobile}
              />
            );
          }
          if (view === "runs") {
            return (
              <RunsTab
                runs={heartbeats ?? []}
                companyId={resolvedCompanyId!}
                agentId={agent.id}
                agentRouteId={canonicalAgentRef}
                selectedRunId={urlRunId ?? null}
                adapterType={agent.adapterType}
              />
            );
          }
          if (view === "skills" && resolvedCompanyId) {
            return (
              <AgentSkillsTab
                agentId={agent.id}
                companyId={resolvedCompanyId}
                skillKeys={(agent as any).skillKeys ?? []}
                expectedUpdatedAt={agent.updatedAt ? new Date(agent.updatedAt).toISOString() : undefined}
              />
            );
          }
          return null;
        }}
      />
      <ConfirmDialog
        open={terminateConfirmOpen}
        onOpenChange={setTerminateConfirmOpen}
        title={`Terminate ${agent.name}?`}
        description="This stops the agent, cancels any active runs, and removes it from the roster. This can't be undone from here."
        confirmLabel="Terminate"
        destructive
        onConfirm={() => {
          setTerminateConfirmOpen(false);
          agentAction.mutate("terminate");
        }}
      />
    </>
  );
}

/* ---- Helper components ---- */

function SummaryRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground text-xs">{label}</span>
      <div className="flex items-center gap-1">{children}</div>
    </div>
  );
}

/* ---- Agent Overview (main single-page view) ---- */

export function AgentOverview({
  agent,
  runs,
  assignedIssues,
  runtimeState,
  reportsToAgent,
  directReports,
  agentId,
  agentRouteId,
  trustScore,
}: {
  agent: Agent;
  runs: HeartbeatRun[];
  assignedIssues: { id: string; title: string; status: string; priority: string; identifier?: string | null; createdAt: Date }[];
  runtimeState?: AgentRuntimeState;
  reportsToAgent: Agent | null;
  directReports: Agent[];
  agentId: string;
  agentRouteId: string;
  trustScore?: import("@armyofagents/shared").AgentTrustScore | null;
}) {
  return (
    <div className="space-y-8">
      {/* Activity (per-run KPIs now live in the hero card) */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <ChartCard title="Run Activity" subtitle="Last 14 days">
          <RunActivityChart runs={runs} />
        </ChartCard>
        <ChartCard title="Tasks by Priority" subtitle="Last 14 days">
          <PriorityChart issues={assignedIssues} />
        </ChartCard>
        <ChartCard title="Tasks by Status" subtitle="Last 14 days">
          <IssueStatusChart issues={assignedIssues} />
        </ChartCard>
        <ChartCard title="Success Rate" subtitle="Last 14 days">
          <SuccessRateChart runs={runs} />
        </ChartCard>
      </div>

      {/* Recent Tasks */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Recent Tasks</h3>
          <Link to={`/issues?assignee=${agentId}`} className="text-xs text-muted-foreground hover:text-foreground transition-colors">
            See All &rarr;
          </Link>
        </div>
        {assignedIssues.length === 0 ? (
          <p className="text-sm text-muted-foreground">No assigned tasks.</p>
        ) : (
          <div className="border border-border rounded-lg">
            {assignedIssues.slice(0, 10).map((issue) => (
              <EntityRow
                key={issue.id}
                identifier={issue.identifier ?? issue.id.slice(0, 8)}
                title={issue.title}
                to={`/issues/${issue.identifier ?? issue.id}`}
                trailing={<StatusBadge status={issue.status} />}
              />
            ))}
            {assignedIssues.length > 10 && (
              <div className="px-3 py-2 text-xs text-muted-foreground text-center border-t border-border">
                +{assignedIssues.length - 10} more issues
              </div>
            )}
          </div>
        )}
      </div>

      {/* Budget */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium">Budget</h3>
        <CostsSection runtimeState={runtimeState} runs={runs} />
      </div>

      {/* Org & health (re-homed from the old Configuration summary; the rest lives in the Config tab) */}
      <OrgHealthCard
        agent={agent}
        reportsToAgent={reportsToAgent}
        directReports={directReports}
      />

      {/* Trust */}
      <AgentTrustScoreCard score={trustScore} />
    </div>
  );
}

/* Chart components imported from ../components/ActivityCharts */

/* ---- Org & health (re-homed from the old Configuration summary) ---- */

function OrgHealthCard({
  agent,
  reportsToAgent,
  directReports,
}: {
  agent: Agent;
  reportsToAgent: Agent | null;
  directReports: Agent[];
}) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium">Org &amp; health</h3>
      <div className="border border-border rounded-lg p-4 space-y-3">
        <div className="space-y-2 text-sm">
          <SummaryRow label="Reports to">
            {reportsToAgent ? (
              <Link
                to={`/agents/${agentRouteRef(reportsToAgent)}`}
                className="text-blue-600 hover:underline dark:text-blue-400"
              >
                <Identity name={reportsToAgent.name} size="sm" />
              </Link>
            ) : (
              <span className="text-muted-foreground">Nobody (top-level)</span>
            )}
          </SummaryRow>
          <SummaryRow label="Last heartbeat">
            {agent.lastHeartbeatAt ? (
              <span>{relativeTime(agent.lastHeartbeatAt)}</span>
            ) : (
              <span className="text-muted-foreground">Never</span>
            )}
          </SummaryRow>
        </div>
        {directReports.length > 0 && (
          <div className="pt-1">
            <span className="text-xs text-muted-foreground">Direct reports</span>
            <div className="mt-1 space-y-1">
              {directReports.map((r) => (
                <Link
                  key={r.id}
                  to={`/agents/${agentRouteRef(r)}`}
                  className="flex items-center gap-2 text-sm text-blue-600 hover:underline dark:text-blue-400"
                >
                  <span className="relative flex h-2 w-2">
                    <span className={`absolute inline-flex h-full w-full rounded-full ${agentStatusDot[r.status] ?? agentStatusDotDefault}`} />
                  </span>
                  {r.name}
                  <span className="text-muted-foreground text-xs">({roleLabels[r.role] ?? r.role})</span>
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---- Costs Section (inline) ---- */

function CostsSection({
  runtimeState,
  runs,
}: {
  runtimeState?: AgentRuntimeState;
  runs: HeartbeatRun[];
}) {
  const runsWithCost = runs
    .filter((r) => {
      const u = r.usageJson as Record<string, unknown> | null;
      return u && (u.cost_usd || u.total_cost_usd || u.input_tokens);
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return (
    <div className="space-y-4">
      {runtimeState && (
        <div className="border border-border rounded-lg p-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <span className="text-xs text-muted-foreground block">Input tokens</span>
              <span className="text-lg font-semibold">{formatTokens(runtimeState.totalInputTokens)}</span>
            </div>
            <div>
              <span className="text-xs text-muted-foreground block">Output tokens</span>
              <span className="text-lg font-semibold">{formatTokens(runtimeState.totalOutputTokens)}</span>
            </div>
            <div>
              <span className="text-xs text-muted-foreground block">Cached tokens</span>
              <span className="text-lg font-semibold">{formatTokens(runtimeState.totalCachedInputTokens)}</span>
            </div>
            <div>
              <span className="text-xs text-muted-foreground block">Total cost</span>
              <span className="text-lg font-semibold">{formatCents(runtimeState.totalCostCents)}</span>
            </div>
          </div>
        </div>
      )}
      {runsWithCost.length > 0 && (
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-accent/20">
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Date</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground">Run</th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground">Input</th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground">Output</th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground">Cost</th>
              </tr>
            </thead>
            <tbody>
              {runsWithCost.slice(0, 10).map((run) => {
                const u = run.usageJson as Record<string, unknown>;
                return (
                  <tr key={run.id} className="border-b border-border last:border-b-0">
                    <td className="px-3 py-2">{formatDate(run.createdAt)}</td>
                    <td className="px-3 py-2 font-mono">{run.id.slice(0, 8)}</td>
                    <td className="px-3 py-2 text-right">{formatTokens(Number(u.input_tokens ?? 0))}</td>
                    <td className="px-3 py-2 text-right">{formatTokens(Number(u.output_tokens ?? 0))}</td>
                    <td className="px-3 py-2 text-right">
                      {(u.cost_usd || u.total_cost_usd)
                        ? `$${Number(u.cost_usd ?? u.total_cost_usd ?? 0).toFixed(4)}`
                        : "-"
                      }
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ---- Agent Configure Page ---- */

export function AgentConfigurePage({
  agent,
  agentId,
  companyId,
  onDirtyChange,
  onSaveActionChange,
  onCancelActionChange,
  onSavingChange,
  updatePermissions,
  isMobile,
}: {
  agent: Agent;
  agentId: string;
  companyId?: string;
  onDirtyChange: (dirty: boolean) => void;
  onSaveActionChange: (save: (() => void) | null) => void;
  onCancelActionChange: (cancel: (() => void) | null) => void;
  onSavingChange: (saving: boolean) => void;
  updatePermissions: { mutate: (canCreate: boolean) => void; isPending: boolean };
  isMobile?: boolean;
}) {
  const queryClient = useQueryClient();
  const [revisionsOpen, setRevisionsOpen] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(false);
  const navPanelRef = useRef<PanelImperativeHandle>(null);
  // Track the form's effective (draft-aware) adapter type so the nav reflects an
  // unsaved adapter switch — otherwise switching e.g. process → claude_local would
  // hide "Permissions & config" until the change is saved.
  const [draftAdapterType, setDraftAdapterType] = useState<string>(agent.adapterType);
  const isLocal = ["claude_local", "codex_local", "opencode_local", "hermes_local", "gemini_local", "cursor"].includes(draftAdapterType);
  type FormKey = "identity" | "adapter" | "permissions" | "runPolicy" | "context";
  type NavKey = FormKey | "apikeys" | "perms" | "revisions";
  const formKeys: FormKey[] = ["identity", "adapter", "permissions", "runPolicy", "context"];
  const isFormKey = (k: NavKey): k is FormKey => (formKeys as string[]).includes(k);
  const [section, setSection] = useState<NavKey>("identity");
  const [formSection, setFormSection] = useState<FormKey>("identity");
  const selectNav = (k: NavKey) => {
    setSection(k);
    if (isFormKey(k)) setFormSection(k);
  };
  const navItems: { key: NavKey; label: string; icon: LucideIcon; lower?: boolean }[] = [
    { key: "identity", label: "Identity", icon: User },
    { key: "adapter", label: "Adapter & model", icon: Plug },
    ...(isLocal ? [{ key: "permissions" as NavKey, label: "Permissions & config", icon: SlidersHorizontal }] : []),
    { key: "runPolicy", label: "Run policy", icon: Heart },
    { key: "context", label: "Context", icon: Brain },
    { key: "apikeys", label: "API keys", icon: Key, lower: true },
    { key: "perms", label: "Permissions", icon: Shield, lower: true },
    { key: "revisions", label: "Revisions", icon: History, lower: true },
  ];

  const { data: configRevisions } = useQuery({
    queryKey: queryKeys.agents.configRevisions(agent.id),
    queryFn: () => agentsApi.listConfigRevisions(agent.id, companyId),
  });

  const rollbackConfig = useMutation({
    mutationFn: (revisionId: string) => agentsApi.rollbackConfigRevision(agent.id, revisionId, companyId),
    onSuccess: (data) => {
      // Rollback also bumps updatedAt — cache the returned row so a follow-up
      // save uses the fresh optimistic-concurrency token, not the pre-rollback
      // one (which would 409 the user against their own rollback). (Decision #104)
      queryClient.setQueryData(queryKeys.agents.detail(agent.id), data);
      queryClient.setQueryData(queryKeys.agents.detail(agent.urlKey), data);
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.configRevisions(agent.id) });
    },
  });

  return (
    <div className="space-y-6">
      {isMobile ? (
        <ConfigurationTab
          agent={agent}
          onDirtyChange={onDirtyChange}
          onSaveActionChange={onSaveActionChange}
          onCancelActionChange={onCancelActionChange}
          onSavingChange={onSavingChange}
          companyId={companyId}
          onAdapterTypeChange={setDraftAdapterType}
        />
      ) : (
      <div className="h-[calc(100vh-15rem)] min-h-[460px]">
        <Group orientation="horizontal" className="h-full gap-2">
          <Panel
            id="config-nav"
            defaultSize="22%"
            minSize="14%"
            maxSize="40%"
            collapsible
            collapsedSize="5%"
            panelRef={navPanelRef}
            onResize={(s) => setNavCollapsed(s.asPercentage <= 8)}
            className="h-full overflow-hidden min-w-0"
          >
            <div className="h-full overflow-hidden rounded-xl border border-border bg-background">
              {navCollapsed ? (
                <aside className="flex h-full w-full flex-col items-center bg-card">
                  <div className="flex h-[42px] w-full shrink-0 items-center justify-center border-b border-border">
                    <button
                      type="button"
                      onClick={() => navPanelRef.current?.expand()}
                      title="Expand"
                      aria-label="Expand config nav"
                      className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                    >
                      <PanelLeftOpen className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="flex flex-1 flex-col items-center gap-1 overflow-auto py-2">
                    {navItems.map((item, i) => {
                      const Icon = item.icon;
                      const active = section === item.key;
                      const showDivider = item.lower && !navItems[i - 1]?.lower;
                      return (
                        <div key={item.key} className="flex flex-col items-center gap-1">
                          {showDivider && <div className="my-1 h-px w-6 bg-border" />}
                          <button
                            type="button"
                            onClick={() => selectNav(item.key)}
                            title={item.label}
                            aria-label={item.label}
                            className={cn(
                              "relative flex size-10 items-center justify-center rounded-md transition-colors",
                              active
                                ? "bg-accent text-accent-foreground"
                                : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
                            )}
                          >
                            <Icon className="size-4" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </aside>
              ) : (
                <div className="h-full overflow-auto p-2 flex flex-col gap-0.5">
                  <button
                    type="button"
                    onClick={() => navPanelRef.current?.collapse()}
                    className="self-end p-1.5 rounded-md text-muted-foreground hover:bg-accent/40"
                    title="Collapse"
                    aria-label="Collapse config nav"
                  >
                    <PanelLeftClose className="h-4 w-4" />
                  </button>
                  {navItems.map((item, i) => {
                    const Icon = item.icon;
                    const active = section === item.key;
                    const showDivider = item.lower && !navItems[i - 1]?.lower;
                    return (
                      <div key={item.key}>
                        {showDivider && <div className="my-1 h-px bg-border/70" />}
                        <button
                          type="button"
                          onClick={() => selectNav(item.key)}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-left transition-colors",
                            active
                              ? "bg-accent text-accent-foreground font-medium"
                              : "text-muted-foreground hover:bg-accent/40",
                          )}
                        >
                          <Icon className="h-4 w-4 shrink-0" />
                          <span className="truncate">{item.label}</span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </Panel>
          <Separator className="w-1 shrink-0 cursor-col-resize rounded bg-transparent hover:bg-border/70 transition-colors" />
          <Panel className="h-full overflow-hidden min-w-0">
            <div className={cn("h-full overflow-auto rounded-xl border border-border bg-background p-4", !isFormKey(section) && "hidden")}>
              <ConfigurationTab
                agent={agent}
                onDirtyChange={onDirtyChange}
                onSaveActionChange={onSaveActionChange}
                onCancelActionChange={onCancelActionChange}
                onSavingChange={onSavingChange}
                companyId={companyId}
                activeSection={formSection}
                onAdapterTypeChange={setDraftAdapterType}
              />
            </div>
            {section === "apikeys" && (
              <div className="h-full overflow-auto rounded-xl border border-border bg-background p-4">
                <h3 className="text-sm font-medium mb-3">API keys</h3>
                <KeysTab agentId={agentId} companyId={companyId} />
              </div>
            )}
            {section === "perms" && (
              <div className="h-full overflow-auto rounded-xl border border-border bg-background p-4">
                <h3 className="text-sm font-medium mb-3">Permissions</h3>
                <div className="flex items-center justify-between text-sm max-w-xl">
                  <span>Can create new agents</span>
                  <Button
                    variant={agent.permissions?.canCreateAgents ? "default" : "outline"}
                    size="sm"
                    className="h-7 px-2.5 text-xs"
                    onClick={() => updatePermissions.mutate(!Boolean(agent.permissions?.canCreateAgents))}
                    disabled={updatePermissions.isPending}
                  >
                    {agent.permissions?.canCreateAgents ? "Enabled" : "Disabled"}
                  </Button>
                </div>
              </div>
            )}
            {section === "revisions" && (
              <div className="h-full overflow-auto rounded-xl border border-border bg-background p-4">
                <h3 className="text-sm font-medium mb-3">
                  Configuration revisions{" "}
                  <span className="text-xs font-normal text-muted-foreground">{configRevisions?.length ?? 0}</span>
                </h3>
                {(configRevisions ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">No configuration revisions yet.</p>
                ) : (
                  <div className="space-y-2">
                    {(configRevisions ?? []).slice(0, 10).map((revision) => (
                      <div key={revision.id} className="border border-border/70 rounded-md p-3 space-y-2">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-xs text-muted-foreground">
                            <span className="font-mono">{revision.id.slice(0, 8)}</span>
                            <span className="mx-1">·</span>
                            <span>{formatDate(revision.createdAt)}</span>
                            <span className="mx-1">·</span>
                            <span>{revision.source}</span>
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2.5 text-xs"
                            onClick={() => rollbackConfig.mutate(revision.id)}
                            disabled={rollbackConfig.isPending}
                          >
                            Restore
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Changed:{" "}
                          {revision.changedKeys.length > 0 ? revision.changedKeys.join(", ") : "no tracked changes"}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </Panel>
        </Group>
      </div>
      )}

      {isMobile && (
        <>
      <PermissionsAccordion agent={agent} updatePermissions={updatePermissions} />
      <ApiKeysAccordion agentId={agentId} companyId={companyId} />

      {/* Configuration Revisions — card accordion */}
      <div className="border border-border rounded-lg overflow-hidden">
        <button
          type="button"
          className="flex items-center gap-2 w-full px-4 py-3 text-sm font-medium hover:bg-accent/30 transition-colors"
          onClick={() => setRevisionsOpen((v) => !v)}
        >
          <History className="h-3 w-3" /> Configuration Revisions
          <span className="text-xs font-normal text-muted-foreground">{configRevisions?.length ?? 0}</span>
          <span className="ml-auto">{revisionsOpen
            ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          }</span>
        </button>
        {revisionsOpen && (
          <div className="px-4 pt-4 pb-4 border-t border-border">
            {(configRevisions ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No configuration revisions yet.</p>
            ) : (
              <div className="space-y-2">
                {(configRevisions ?? []).slice(0, 10).map((revision) => (
                  <div key={revision.id} className="border border-border/70 rounded-md p-3 space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-xs text-muted-foreground">
                        <span className="font-mono">{revision.id.slice(0, 8)}</span>
                        <span className="mx-1">·</span>
                        <span>{formatDate(revision.createdAt)}</span>
                        <span className="mx-1">·</span>
                        <span>{revision.source}</span>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2.5 text-xs"
                        onClick={() => rollbackConfig.mutate(revision.id)}
                        disabled={rollbackConfig.isPending}
                      >
                        Restore
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Changed:{" "}
                      {revision.changedKeys.length > 0 ? revision.changedKeys.join(", ") : "no tracked changes"}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
        </>
      )}
    </div>
  );
}

/* ---- Small card accordion helpers ---- */

function PermissionsAccordion({ agent, updatePermissions }: { agent: Agent; updatePermissions: { mutate: (canCreate: boolean) => void; isPending: boolean } }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button type="button" className="flex items-center gap-2 w-full px-4 py-3 text-sm font-medium hover:bg-accent/30 transition-colors" onClick={() => setOpen(!open)}>
        <Shield className="h-3 w-3" /> Permissions
        <span className="ml-auto">{open ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}</span>
      </button>
      {open && (
        <div className="px-4 pt-4 pb-4 border-t border-border">
          <div className="flex items-center justify-between text-sm">
            <span>Can create new agents</span>
            <Button
              variant={agent.permissions?.canCreateAgents ? "default" : "outline"}
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={() => updatePermissions.mutate(!Boolean(agent.permissions?.canCreateAgents))}
              disabled={updatePermissions.isPending}
            >
              {agent.permissions?.canCreateAgents ? "Enabled" : "Disabled"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ApiKeysAccordion({ agentId, companyId }: { agentId: string; companyId?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button type="button" className="flex items-center gap-2 w-full px-4 py-3 text-sm font-medium hover:bg-accent/30 transition-colors" onClick={() => setOpen(!open)}>
        <Key className="h-3 w-3" /> API Keys
        <span className="ml-auto">{open ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}</span>
      </button>
      {open && (
        <div className="px-4 pt-4 pb-4 border-t border-border">
          <KeysTab agentId={agentId} companyId={companyId} />
        </div>
      )}
    </div>
  );
}

/* ---- Configuration Tab ---- */

function ConfigurationTab({
  agent,
  companyId,
  onDirtyChange,
  onSaveActionChange,
  onCancelActionChange,
  onSavingChange,
  activeSection,
  onAdapterTypeChange,
}: {
  agent: Agent;
  companyId?: string;
  onDirtyChange: (dirty: boolean) => void;
  onSaveActionChange: (save: (() => void) | null) => void;
  onCancelActionChange: (cancel: (() => void) | null) => void;
  onSavingChange: (saving: boolean) => void;
  activeSection?: "identity" | "adapter" | "permissions" | "runPolicy" | "context";
  onAdapterTypeChange?: (adapterType: string) => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const { data: adapterModels } = useQuery({
    queryKey:
      companyId
        ? queryKeys.agents.adapterModels(companyId, agent.adapterType)
        : ["agents", "none", "adapter-models", agent.adapterType],
    queryFn: () => agentsApi.adapterModels(companyId!, agent.adapterType),
    enabled: Boolean(companyId),
  });

  const [saveWarnings, setSaveWarnings] = useState<string[]>([]);

  const updateAgent = useMutation({
    mutationFn: (data: Record<string, unknown>) => agentsApi.update(agent.id, data, companyId),
    onSuccess: (result) => {
      // Write the saved row (incl. its fresh updatedAt) into the cache
      // synchronously so a quick repeat save uses the up-to-date
      // optimistic-concurrency token, not the stale pre-save one (which would
      // 409 the user against their own just-completed save). The invalidate
      // below still refetches for eventual consistency. (Decision #104)
      queryClient.setQueryData(queryKeys.agents.detail(agent.id), result);
      queryClient.setQueryData(queryKeys.agents.detail(agent.urlKey), result);
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.configRevisions(agent.id) });
      setSaveWarnings(result.warnings ?? []);
    },
    onError: (err) => {
      // Optimistic-concurrency conflict: someone else changed the agent. Refetch
      // the latest and tell the user to redo their edit. (Decision #104)
      if (err instanceof ApiError && err.status === 409) {
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) });
        pushToast({
          title: "This agent changed elsewhere",
          body: "Reloaded the latest version — please redo your change.",
          tone: "error",
        });
      }
    },
  });

  useEffect(() => {
    onSavingChange(updateAgent.isPending);
  }, [onSavingChange, updateAgent.isPending]);

  return (
    <div className="space-y-6">
      <AgentConfigForm
        mode="edit"
        agent={agent}
        onSave={(patch) => { setSaveWarnings([]); updateAgent.mutate(patch); }}
        isSaving={updateAgent.isPending}
        adapterModels={adapterModels}
        onDirtyChange={onDirtyChange}
        onSaveActionChange={onSaveActionChange}
        onCancelActionChange={onCancelActionChange}
        hideInlineSave
        sectionLayout="cards"
        activeSection={activeSection}
        onAdapterTypeChange={onAdapterTypeChange}
      />

      <AgentSaveWarnings warnings={saveWarnings} />
    </div>
  );
}

/* ---- Runs Tab ---- */

function RunListItem({ run, isSelected, agentId }: { run: HeartbeatRun; isSelected: boolean; agentId: string }) {
  const statusInfo = runStatusIcons[run.status] ?? { icon: Clock, color: "text-neutral-400" };
  const StatusIcon = statusInfo.icon;
  const metrics = runMetrics(run);
  const summary = run.resultJson
    ? String((run.resultJson as Record<string, unknown>).summary ?? (run.resultJson as Record<string, unknown>).result ?? "")
    : run.error ?? "";

  return (
    <Link
      to={isSelected ? `/agents/${agentId}/runs` : `/agents/${agentId}/runs/${run.id}`}
      className={cn(
        "flex flex-col gap-1 w-full px-3 py-2.5 text-left border-b border-border last:border-b-0 transition-colors no-underline text-inherit",
        isSelected ? "bg-accent/40" : "hover:bg-accent/20",
      )}
    >
      <div className="flex items-center gap-2">
        <StatusIcon className={cn("h-3.5 w-3.5 shrink-0", statusInfo.color, run.status === "running" && "animate-spin")} />
        <span className="font-mono text-xs text-muted-foreground">
          {run.id.slice(0, 8)}
        </span>
        <span className={cn(
          "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium shrink-0",
          run.invocationSource === "timer" ? "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300"
            : run.invocationSource === "assignment" ? "bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300"
            : run.invocationSource === "on_demand" ? "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-300"
            : "bg-muted text-muted-foreground"
        )}>
          {sourceLabels[run.invocationSource] ?? run.invocationSource}
        </span>
        <span className="ml-auto text-[11px] text-muted-foreground shrink-0">
          {relativeTime(run.createdAt)}
        </span>
      </div>
      {summary && (
        <span className="text-xs text-muted-foreground truncate pl-5.5">
          {summary.slice(0, 60)}
        </span>
      )}
      {(metrics.totalTokens > 0 || metrics.cost > 0) && (
        <div className="flex items-center gap-2 pl-5.5 text-[11px] text-muted-foreground">
          {metrics.totalTokens > 0 && <span>{formatTokens(metrics.totalTokens)} tok</span>}
          {metrics.cost > 0 && <span>${metrics.cost.toFixed(3)}</span>}
        </div>
      )}
    </Link>
  );
}

export function RunsTab({
  runs,
  companyId,
  agentId,
  agentRouteId,
  selectedRunId,
  adapterType,
}: {
  runs: HeartbeatRun[];
  companyId: string;
  agentId: string;
  agentRouteId: string;
  selectedRunId: string | null;
  adapterType: string;
}) {
  const { isMobile } = useSidebar();
  const [listCollapsed, setListCollapsed] = useState(false);
  const runListPanelRef = useRef<PanelImperativeHandle>(null);

  if (runs.length === 0) {
    return (
      <div className="border border-border rounded-lg py-12 text-center">
        <p className="text-sm text-muted-foreground">No runs yet.</p>
        <p className="text-xs text-muted-foreground mt-1">
          Runs appear here once this agent is invoked or wakes on a task.
        </p>
      </div>
    );
  }

  // Sort by created descending
  const sorted = [...runs].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  // On mobile, don't auto-select so the list shows first; on desktop, auto-select latest
  const effectiveRunId = isMobile ? selectedRunId : (selectedRunId ?? sorted[0]?.id ?? null);
  const selectedRun = sorted.find((r) => r.id === effectiveRunId) ?? null;

  // Mobile: show either run list OR run detail with back button
  if (isMobile) {
    if (selectedRun) {
      return (
        <div className="space-y-3 min-w-0 overflow-x-hidden">
          <Link
            to={`/agents/${agentRouteId}/runs`}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors no-underline"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to runs
          </Link>
          <RunDetail key={selectedRun.id} run={selectedRun} agentRouteId={agentRouteId} adapterType={adapterType} />
        </div>
      );
    }
    return (
      <div className="border border-border rounded-lg overflow-x-hidden">
        {sorted.map((run) => (
          <RunListItem key={run.id} run={run} isSelected={false} agentId={agentRouteId} />
        ))}
      </div>
    );
  }

  // Desktop: resizable two-pane (run list | detail) with a collapsible list rail.
  return (
    <div className="h-[calc(100vh-16rem)] min-h-[460px]">
      <Group orientation="horizontal" className="h-full gap-2">
        <Panel
          id="runs-list"
          defaultSize="26%"
          minSize="16%"
          maxSize="44%"
          collapsible
          collapsedSize="5%"
          panelRef={runListPanelRef}
          onResize={(s) => setListCollapsed(s.asPercentage <= 8)}
          className="h-full overflow-hidden min-w-0"
        >
          <div className="h-full overflow-hidden rounded-xl border border-border bg-background">
            {listCollapsed ? (
              <aside className="flex h-full w-full flex-col items-center bg-card">
                <div className="flex h-[42px] w-full shrink-0 items-center justify-center border-b border-border">
                  <button
                    type="button"
                    onClick={() => runListPanelRef.current?.expand()}
                    title="Expand"
                    aria-label="Expand runs list"
                    className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                  >
                    <PanelLeftOpen className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="flex flex-1 flex-col items-center gap-1 overflow-auto py-2">
                  {sorted.map((run) => {
                    const info = runStatusIcons[run.status] ?? { icon: Clock, color: "text-neutral-400" };
                    const Icon = info.icon;
                    const active = run.id === effectiveRunId;
                    return (
                      <Link
                        key={run.id}
                        to={`/agents/${agentRouteId}/runs/${run.id}`}
                        title={`${run.id.slice(0, 8)} · ${relativeTime(run.createdAt)}`}
                        aria-label={`Run ${run.id.slice(0, 8)}`}
                        className={cn(
                          "flex size-10 items-center justify-center rounded-md no-underline transition-colors",
                          active
                            ? "bg-accent text-accent-foreground"
                            : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
                        )}
                      >
                        <Icon className={cn("size-4", info.color, run.status === "running" && "animate-spin")} />
                      </Link>
                    );
                  })}
                </div>
              </aside>
            ) : (
              <div className="flex h-full flex-col">
                <div className="flex h-[42px] shrink-0 items-center justify-between border-b border-border pl-3 pr-1.5">
                  <h4 className="text-sm font-medium">
                    Runs <span className="font-normal text-muted-foreground">· {sorted.length}</span>
                  </h4>
                  <button
                    type="button"
                    onClick={() => runListPanelRef.current?.collapse()}
                    title="Collapse"
                    aria-label="Collapse runs list"
                    className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
                  >
                    <PanelLeftClose className="h-4 w-4" />
                  </button>
                </div>
                <div className="flex-1 overflow-auto">
                  {sorted.map((run) => (
                    <RunListItem key={run.id} run={run} isSelected={run.id === effectiveRunId} agentId={agentRouteId} />
                  ))}
                </div>
              </div>
            )}
          </div>
        </Panel>
        <Separator className="w-1 shrink-0 cursor-col-resize rounded bg-transparent hover:bg-border/70 transition-colors" />
        <Panel className="h-full overflow-hidden min-w-0">
          <div className="h-full overflow-auto rounded-xl border border-border bg-background p-4">
            {selectedRun ? (
              <RunDetail key={selectedRun.id} run={selectedRun} agentRouteId={agentRouteId} adapterType={adapterType} />
            ) : (
              <p className="text-sm text-muted-foreground">Select a run to view its details.</p>
            )}
          </div>
        </Panel>
      </Group>
    </div>
  );
}

/* ---- Run Detail (expanded) ---- */

/**
 * Full run-detail panel (status, metrics, session, touched tasks, log viewer).
 * Exported so the Inbox Hub `run` tab (RunDetailContainer, D4b) can host it by
 * id — the route page's RunsTab still renders it inline. It reads
 * `run.companyId`/`run.agentId` internally; `agentRouteId` is used only for
 * resume/retry navigation, and `adapterType` selects the transcript parser.
 */
export function RunDetail({
  run,
  agentRouteId,
  adapterType,
  onOpenIssue,
}: {
  run: HeartbeatRun;
  agentRouteId: string;
  adapterType: string;
  onOpenIssue?: (issueId: string, title: string) => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const metrics = runMetrics(run);
  const adapterResultOutput = getAdapterResultOutput(run, adapterType);
  const [sessionOpen, setSessionOpen] = useState(false);
  const [claudeLoginResult, setClaudeLoginResult] = useState<ClaudeLoginResult | null>(null);
  const [clearSessionConfirmOpen, setClearSessionConfirmOpen] = useState(false);

  useEffect(() => {
    setClaudeLoginResult(null);
  }, [run.id]);

  const cancelRun = useMutation({
    mutationFn: () => heartbeatsApi.cancel(run.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(run.companyId, run.agentId) });
    },
  });
  const canResumeLostRun = run.errorCode === "process_lost" && run.status === "failed";
  const resumePayload = useMemo(() => {
    const payload: Record<string, unknown> = {
      resumeFromRunId: run.id,
    };
    const context = asRecord(run.contextSnapshot);
    if (!context) return payload;
    const issueId = asNonEmptyString(context.issueId);
    const taskId = asNonEmptyString(context.taskId);
    const taskKey = asNonEmptyString(context.taskKey);
    const commentId = asNonEmptyString(context.wakeCommentId) ?? asNonEmptyString(context.commentId);
    if (issueId) payload.issueId = issueId;
    if (taskId) payload.taskId = taskId;
    if (taskKey) payload.taskKey = taskKey;
    if (commentId) payload.commentId = commentId;
    return payload;
  }, [run.contextSnapshot, run.id]);
  const resumeRun = useMutation({
    mutationFn: async () => {
      const result = await agentsApi.wakeup(run.agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "resume_process_lost_run",
        payload: resumePayload,
      }, run.companyId);
      if (!("id" in result)) {
        throw new Error("Resume request was skipped because the agent is not currently invokable.");
      }
      return result;
    },
    onSuccess: (resumedRun) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(run.companyId, run.agentId) });
      navigate(`/agents/${agentRouteId}/runs/${resumedRun.id}`);
    },
  });

  const canRetryRun = run.status === "failed" || run.status === "timed_out";
  const retryPayload = useMemo(() => {
    const payload: Record<string, unknown> = {};
    const context = asRecord(run.contextSnapshot);
    if (!context) return payload;
    const issueId = asNonEmptyString(context.issueId);
    const taskId = asNonEmptyString(context.taskId);
    const taskKey = asNonEmptyString(context.taskKey);
    if (issueId) payload.issueId = issueId;
    if (taskId) payload.taskId = taskId;
    if (taskKey) payload.taskKey = taskKey;
    return payload;
  }, [run.contextSnapshot]);
  const retryRun = useMutation({
    mutationFn: async () => {
      const result = await agentsApi.wakeup(run.agentId, {
        source: "on_demand",
        triggerDetail: "manual",
        reason: "retry_failed_run",
        payload: retryPayload,
      }, run.companyId);
      if (!("id" in result)) {
        throw new Error("Retry was skipped because the agent is not currently invokable.");
      }
      return result;
    },
    onSuccess: (newRun) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.heartbeats(run.companyId, run.agentId) });
      navigate(`/agents/${agentRouteId}/runs/${newRun.id}`);
    },
  });

  const { data: touchedIssues } = useQuery({
    queryKey: queryKeys.runIssues(run.id),
    queryFn: () => activityApi.issuesForRun(run.id),
  });
  const touchedIssueIds = useMemo(
    () => Array.from(new Set((touchedIssues ?? []).map((issue) => issue.issueId))),
    [touchedIssues],
  );

  const clearSessionsForTouchedIssues = useMutation({
    mutationFn: async () => {
      if (touchedIssueIds.length === 0) return 0;
      await Promise.all(touchedIssueIds.map((issueId) => agentsApi.resetSession(run.agentId, issueId, run.companyId)));
      return touchedIssueIds.length;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.runtimeState(run.agentId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.taskSessions(run.agentId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.runIssues(run.id) });
    },
  });

  const runClaudeLogin = useMutation({
    mutationFn: () => agentsApi.loginWithClaude(run.agentId, run.companyId),
    onSuccess: (data) => {
      setClaudeLoginResult(data);
    },
  });

  const isRunning = run.status === "running" && !!run.startedAt && !run.finishedAt;
  const [elapsedSec, setElapsedSec] = useState<number>(() => {
    if (!run.startedAt) return 0;
    return Math.max(0, Math.round((Date.now() - new Date(run.startedAt).getTime()) / 1000));
  });

  useEffect(() => {
    if (!isRunning || !run.startedAt) return;
    const startMs = new Date(run.startedAt).getTime();
    setElapsedSec(Math.max(0, Math.round((Date.now() - startMs) / 1000)));
    const id = setInterval(() => {
      setElapsedSec(Math.max(0, Math.round((Date.now() - startMs) / 1000)));
    }, 1000);
    return () => clearInterval(id);
  }, [isRunning, run.startedAt]);

  const timeFormat: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false };
  const startTime = run.startedAt ? new Date(run.startedAt).toLocaleTimeString("en-US", timeFormat) : null;
  const endTime = run.finishedAt ? new Date(run.finishedAt).toLocaleTimeString("en-US", timeFormat) : null;
  const durationSec = run.startedAt && run.finishedAt
    ? Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)
    : null;
  const displayDurationSec = durationSec ?? (isRunning ? elapsedSec : null);
  const hasMetrics = metrics.input > 0 || metrics.output > 0 || metrics.cached > 0 || metrics.cost > 0;
  const hasSession = !!(run.sessionIdBefore || run.sessionIdAfter);
  const sessionChanged = run.sessionIdBefore && run.sessionIdAfter && run.sessionIdBefore !== run.sessionIdAfter;
  const sessionId = run.sessionIdAfter || run.sessionIdBefore;
  const hasNonZeroExit = run.exitCode !== null && run.exitCode !== 0;

  return (
    <div className="space-y-4 min-w-0">
      {/* Run summary card */}
      <div className="border border-border rounded-lg overflow-hidden">
        <div className="flex flex-col sm:flex-row">
          {/* Left column: status + timing */}
          <div className="flex-1 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <StatusBadge status={run.status} />
              {(run.status === "running" || run.status === "queued") && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive text-xs h-6 px-2"
                  onClick={() => cancelRun.mutate()}
                  disabled={cancelRun.isPending}
                >
                  {cancelRun.isPending ? "Cancelling…" : "Cancel"}
                </Button>
              )}
              {canResumeLostRun && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs h-6 px-2"
                  onClick={() => resumeRun.mutate()}
                  disabled={resumeRun.isPending}
                >
                  <RotateCcw className="h-3.5 w-3.5 mr-1" />
                  {resumeRun.isPending ? "Resuming…" : "Resume"}
                </Button>
              )}
              {canRetryRun && !canResumeLostRun && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs h-6 px-2"
                  onClick={() => retryRun.mutate()}
                  disabled={retryRun.isPending}
                >
                  <RotateCcw className="h-3.5 w-3.5 mr-1" />
                  {retryRun.isPending ? "Retrying…" : "Retry"}
                </Button>
              )}
            </div>
            {resumeRun.isError && (
              <div className="text-xs text-destructive">
                {resumeRun.error instanceof Error ? resumeRun.error.message : "Failed to resume run"}
              </div>
            )}
            {retryRun.isError && (
              <div className="text-xs text-destructive">
                {retryRun.error instanceof Error ? retryRun.error.message : "Failed to retry run"}
              </div>
            )}
            {startTime && (
              <div className="space-y-0.5">
                <div className="text-sm font-mono">
                  {startTime}
                  {endTime && <span className="text-muted-foreground"> &rarr; </span>}
                  {endTime}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {relativeTime(run.startedAt!)}
                  {run.finishedAt && <> &rarr; {relativeTime(run.finishedAt)}</>}
                </div>
                {displayDurationSec !== null && (
                  <div className="text-xs text-muted-foreground">
                    Duration: {displayDurationSec >= 60 ? `${Math.floor(displayDurationSec / 60)}m ${displayDurationSec % 60}s` : `${displayDurationSec}s`}
                  </div>
                )}
                {run.totalWallClockMs > 0 && (
                  <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Run time accounting">
                    <dt>Total elapsed</dt>
                    <dd>{formatDuration(run.totalWallClockMs)}</dd>
                    <dt>Provider active</dt>
                    <dd>{formatDuration(run.activeExecutionMs)}</dd>
                    {run.humanQuestionWaitMs > 0 && <><dt>Waiting on human</dt><dd>{formatDuration(run.humanQuestionWaitMs)}</dd></>}
                    {run.runtimePermissionWaitMs > 0 && <><dt>Waiting for permission</dt><dd>{formatDuration(run.runtimePermissionWaitMs)}</dd></>}
                  </dl>
                )}
              </div>
            )}
            {run.error && (
              <div className="text-xs">
                <span className="text-red-600 dark:text-red-400">{run.error}</span>
                {run.errorCode && <span className="text-muted-foreground ml-1">({run.errorCode})</span>}
              </div>
            )}
            {run.errorCode === "claude_auth_required" && adapterType === "claude_local" && (
              <div className="space-y-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => runClaudeLogin.mutate()}
                  disabled={runClaudeLogin.isPending}
                >
                  {runClaudeLogin.isPending
                    ? "Running claude auth login..."
                    : "Login to Claude Code"}
                </Button>
                {runClaudeLogin.isError && (
                  <p className="text-xs text-destructive">
                    {runClaudeLogin.error instanceof Error
                      ? runClaudeLogin.error.message
                      : "Failed to run Claude login"}
                  </p>
                )}
                {claudeLoginResult?.loginUrl && (
                  <p className="text-xs">
                    Login URL:
                    <a
                      href={claudeLoginResult.loginUrl}
                      className="text-blue-600 underline underline-offset-2 ml-1 break-all dark:text-blue-400"
                      target="_blank"
                      rel="noreferrer"
                    >
                      {claudeLoginResult.loginUrl}
                    </a>
                  </p>
                )}
                {claudeLoginResult && (
                  <>
                    {!!claudeLoginResult.stdout && (
                      <pre className="bg-neutral-100 dark:bg-neutral-950 rounded-md p-3 text-xs font-mono text-foreground overflow-x-auto whitespace-pre-wrap">
                        {claudeLoginResult.stdout}
                      </pre>
                    )}
                    {!!claudeLoginResult.stderr && (
                      <pre className="bg-neutral-100 dark:bg-neutral-950 rounded-md p-3 text-xs font-mono text-red-700 dark:text-red-300 overflow-x-auto whitespace-pre-wrap">
                        {claudeLoginResult.stderr}
                      </pre>
                    )}
                  </>
                )}
              </div>
            )}
            {hasNonZeroExit && (
              <div className="text-xs text-red-600 dark:text-red-400">
                Exit code {run.exitCode}
                {run.signal && <span className="text-muted-foreground ml-1">(signal: {run.signal})</span>}
              </div>
            )}
          </div>

          {/* Right column: metrics */}
          {hasMetrics && (
            <div className="border-t sm:border-t-0 sm:border-l border-border p-4 grid grid-cols-2 gap-x-4 sm:gap-x-8 gap-y-3 content-center">
              <div>
                <div className="text-xs text-muted-foreground">Input</div>
                <div className="text-sm font-medium font-mono">{formatTokens(metrics.input)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Output</div>
                <div className="text-sm font-medium font-mono">{formatTokens(metrics.output)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Cached</div>
                <div className="text-sm font-medium font-mono">{formatTokens(metrics.cached)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Cost</div>
                <div className="text-sm font-medium font-mono">{metrics.cost > 0 ? `$${metrics.cost.toFixed(4)}` : "-"}</div>
              </div>
            </div>
          )}
        </div>

        {/* Collapsible session row */}
        {hasSession && (
          <div className="border-t border-border">
            <button
              className="flex items-center gap-1.5 w-full px-4 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setSessionOpen((v) => !v)}
            >
              <ChevronRight className={cn("h-3 w-3 transition-transform", sessionOpen && "rotate-90")} />
              Session
              {sessionChanged && <span className="text-yellow-400 ml-1">(changed)</span>}
            </button>
            {sessionOpen && (
              <div className="px-4 pb-3 space-y-1 text-xs">
                {run.sessionIdBefore && (
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground w-12">{sessionChanged ? "Before" : "ID"}</span>
                    <CopyText text={run.sessionIdBefore} className="font-mono" />
                  </div>
                )}
                {sessionChanged && run.sessionIdAfter && (
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground w-12">After</span>
                    <CopyText text={run.sessionIdAfter} className="font-mono" />
                  </div>
                )}
                {touchedIssueIds.length > 0 && (
                  <div className="pt-1">
                    <button
                      type="button"
                      className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-60"
                      disabled={clearSessionsForTouchedIssues.isPending}
                      onClick={() => setClearSessionConfirmOpen(true)}
                    >
                      {clearSessionsForTouchedIssues.isPending
                        ? "clearing session..."
                        : "clear session for these tasks"}
                    </button>
                    {clearSessionsForTouchedIssues.isError && (
                      <p className="text-[11px] text-destructive mt-1">
                        {clearSessionsForTouchedIssues.error instanceof Error
                          ? clearSessionsForTouchedIssues.error.message
                          : "Failed to clear sessions"}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Issues touched by this run */}
      {touchedIssues && touchedIssues.length > 0 && (
        <div className="space-y-2">
          <span className="text-xs font-medium text-muted-foreground">Tasks Touched ({touchedIssues.length})</span>
          <div className="border border-border rounded-lg divide-y divide-border">
            {touchedIssues.map((issue) => {
              const content = (
                <>
                  <div className="flex items-center gap-2 min-w-0">
                    <StatusBadge status={issue.status} />
                    <span className="truncate">{issue.title}</span>
                  </div>
                  <span className="font-mono text-muted-foreground shrink-0 ml-2">{issue.identifier ?? issue.issueId.slice(0, 8)}</span>
                </>
              );
              const className = "flex items-center justify-between w-full px-3 py-2 text-xs hover:bg-accent/20 transition-colors text-left no-underline text-inherit";

              return onOpenIssue ? (
                <button
                  key={issue.issueId}
                  type="button"
                  className={className}
                  onClick={() => onOpenIssue(issue.issueId, issue.title)}
                >
                  {content}
                </button>
              ) : (
                <Link
                  key={issue.issueId}
                  to={`/issues/${issue.identifier ?? issue.issueId}`}
                  className={className}
                >
                  {content}
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {/* stderr excerpt for failed runs */}
      {run.stderrExcerpt && (
        <div className="space-y-1">
          <span className="text-xs font-medium text-red-600 dark:text-red-400">stderr</span>
          <pre className="bg-neutral-100 dark:bg-neutral-950 rounded-md p-3 text-xs font-mono text-red-700 dark:text-red-300 overflow-x-auto whitespace-pre-wrap">{run.stderrExcerpt}</pre>
        </div>
      )}

      {/* stdout excerpt when no log is available */}
      {run.stdoutExcerpt && !run.logRef && (
        <div className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">stdout</span>
          <pre className="bg-neutral-100 dark:bg-neutral-950 rounded-md p-3 text-xs font-mono text-foreground overflow-x-auto whitespace-pre-wrap">{run.stdoutExcerpt}</pre>
        </div>
      )}

      {adapterResultOutput && (
        <div className="space-y-2 rounded-lg border border-border bg-card p-3">
          <div className="text-xs font-medium text-muted-foreground">Adapter output</div>
          {adapterResultOutput.stdout && (
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">stdout</span>
              <pre className="bg-neutral-100 dark:bg-neutral-950 rounded-md p-3 text-xs font-mono text-foreground overflow-x-auto whitespace-pre-wrap">{adapterResultOutput.stdout}</pre>
            </div>
          )}
          {adapterResultOutput.stderr && (
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">stderr</span>
              <pre className="bg-neutral-100 dark:bg-neutral-950 rounded-md p-3 text-xs font-mono text-red-700 dark:text-red-300 overflow-x-auto whitespace-pre-wrap">{adapterResultOutput.stderr}</pre>
            </div>
          )}
        </div>
      )}

      {/* Log viewer */}
      <LogViewer run={run} adapterType={adapterType} />

      <ConfirmDialog
        open={clearSessionConfirmOpen}
        onOpenChange={setClearSessionConfirmOpen}
        title={`Clear session for ${touchedIssueIds.length} task${touchedIssueIds.length === 1 ? "" : "s"} touched by this run?`}
        description="Any in-progress work by those tasks' agents will be discarded on next run."
        confirmLabel="Clear session"
        onConfirm={() => {
          clearSessionsForTouchedIssues.mutate();
          setClearSessionConfirmOpen(false);
        }}
      />
    </div>
  );
}

/* ---- Log Viewer ---- */

function LogViewer({ run, adapterType }: { run: HeartbeatRun; adapterType: string }) {
  const [events, setEvents] = useState<HeartbeatRunEvent[]>([]);
  const [logLines, setLogLines] = useState<Array<{ ts: string; stream: "stdout" | "stderr" | "system"; chunk: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [logLoading, setLogLoading] = useState(!!run.logRef);
  const [logError, setLogError] = useState<string | null>(null);
  const [logOffset, setLogOffset] = useState(0);
  const [isFollowing, setIsFollowing] = useState(false);
  const [isStreamingConnected, setIsStreamingConnected] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);
  const pendingLogLineRef = useRef("");
  const scrollContainerRef = useRef<ScrollContainer | null>(null);
  const isFollowingRef = useRef(false);
  const lastMetricsRef = useRef<{ scrollHeight: number; distanceFromBottom: number }>({
    scrollHeight: 0,
    distanceFromBottom: Number.POSITIVE_INFINITY,
  });
  const isLive = run.status === "running" || run.status === "queued";

  function isRunLogUnavailable(err: unknown): boolean {
    return err instanceof ApiError && err.status === 404;
  }

  function appendLogContent(content: string, finalize = false) {
    if (!content && !finalize) return;
    const combined = `${pendingLogLineRef.current}${content}`;
    const split = combined.split("\n");
    pendingLogLineRef.current = split.pop() ?? "";
    if (finalize && pendingLogLineRef.current) {
      split.push(pendingLogLineRef.current);
      pendingLogLineRef.current = "";
    }

    const parsed: Array<{ ts: string; stream: "stdout" | "stderr" | "system"; chunk: string }> = [];
    for (const line of split) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const raw = JSON.parse(trimmed) as { ts?: unknown; stream?: unknown; chunk?: unknown };
        const stream =
          raw.stream === "stderr" || raw.stream === "system" ? raw.stream : "stdout";
        const chunk = typeof raw.chunk === "string" ? raw.chunk : "";
        const ts = typeof raw.ts === "string" ? raw.ts : new Date().toISOString();
        if (!chunk) continue;
        parsed.push({ ts, stream, chunk });
      } catch {
        // ignore malformed lines
      }
    }

    if (parsed.length > 0) {
      setLogLines((prev) => [...prev, ...parsed]);
    }
  }

  // Fetch events
  const { data: initialEvents } = useQuery({
    queryKey: ["run-events", run.id],
    queryFn: () => heartbeatsApi.events(run.id, 0, 200),
  });

  useEffect(() => {
    if (initialEvents) {
      setEvents(initialEvents);
      setLoading(false);
    }
  }, [initialEvents]);

  const getScrollContainer = useCallback((): ScrollContainer => {
    if (scrollContainerRef.current) return scrollContainerRef.current;
    const container = findScrollContainer(logEndRef.current);
    scrollContainerRef.current = container;
    return container;
  }, []);

  const updateFollowingState = useCallback(() => {
    const container = getScrollContainer();
    const metrics = readScrollMetrics(container);
    lastMetricsRef.current = metrics;
    const nearBottom = metrics.distanceFromBottom <= LIVE_SCROLL_BOTTOM_TOLERANCE_PX;
    isFollowingRef.current = nearBottom;
    setIsFollowing((prev) => (prev === nearBottom ? prev : nearBottom));
  }, [getScrollContainer]);

  useEffect(() => {
    scrollContainerRef.current = null;
    lastMetricsRef.current = {
      scrollHeight: 0,
      distanceFromBottom: Number.POSITIVE_INFINITY,
    };

    if (!isLive) {
      isFollowingRef.current = false;
      setIsFollowing(false);
      return;
    }

    updateFollowingState();
  }, [isLive, run.id, updateFollowingState]);

  useEffect(() => {
    if (!isLive) return;
    const container = getScrollContainer();
    updateFollowingState();

    if (container === window) {
      window.addEventListener("scroll", updateFollowingState, { passive: true });
    } else {
      container.addEventListener("scroll", updateFollowingState, { passive: true });
    }
    window.addEventListener("resize", updateFollowingState);
    return () => {
      if (container === window) {
        window.removeEventListener("scroll", updateFollowingState);
      } else {
        container.removeEventListener("scroll", updateFollowingState);
      }
      window.removeEventListener("resize", updateFollowingState);
    };
  }, [isLive, run.id, getScrollContainer, updateFollowingState]);

  // Auto-scroll only for live runs when following
  useEffect(() => {
    if (!isLive || !isFollowingRef.current) return;

    const container = getScrollContainer();
    const previous = lastMetricsRef.current;
    const current = readScrollMetrics(container);
    const growth = Math.max(0, current.scrollHeight - previous.scrollHeight);
    const expectedDistance = previous.distanceFromBottom + growth;
    const movedAwayBy = current.distanceFromBottom - expectedDistance;

    // If user moved away from bottom between updates, release auto-follow immediately.
    if (movedAwayBy > LIVE_SCROLL_BOTTOM_TOLERANCE_PX) {
      isFollowingRef.current = false;
      setIsFollowing(false);
      lastMetricsRef.current = current;
      return;
    }

    scrollToContainerBottom(container, "auto");
    const after = readScrollMetrics(container);
    lastMetricsRef.current = after;
    if (!isFollowingRef.current) {
      isFollowingRef.current = true;
    }
    setIsFollowing((prev) => (prev ? prev : true));
  }, [events.length, logLines.length, isLive, getScrollContainer]);

  // Fetch persisted shell log
  useEffect(() => {
    let cancelled = false;
    pendingLogLineRef.current = "";
    setLogLines([]);
    setLogOffset(0);
    setLogError(null);

    if (!run.logRef && !isLive) {
      setLogLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setLogLoading(true);
    const firstLimit =
      typeof run.logBytes === "number" && run.logBytes > 0
        ? Math.min(Math.max(run.logBytes + 1024, 256_000), 2_000_000)
        : 256_000;

    const load = async () => {
      try {
        let offset = 0;
        let first = true;
        while (!cancelled) {
          const result = await heartbeatsApi.log(run.id, offset, first ? firstLimit : 256_000);
          if (cancelled) break;
          appendLogContent(result.content, result.nextOffset === undefined);
          const next = result.nextOffset ?? offset + result.content.length;
          setLogOffset(next);
          offset = next;
          first = false;
          if (result.nextOffset === undefined || isLive) break;
        }
      } catch (err) {
        if (!cancelled) {
          if (isLive && isRunLogUnavailable(err)) {
            setLogLoading(false);
            return;
          }
          setLogError(err instanceof Error ? err.message : "Failed to load run log");
        }
      } finally {
        if (!cancelled) setLogLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [run.id, run.logRef, run.logBytes, isLive]);

  // Poll for live updates
  useEffect(() => {
    if (!isLive || isStreamingConnected) return;
    const interval = setInterval(async () => {
      const maxSeq = events.length > 0 ? Math.max(...events.map((e) => e.seq)) : 0;
      try {
        const newEvents = await heartbeatsApi.events(run.id, maxSeq, 100);
        if (newEvents.length > 0) {
          setEvents((prev) => [...prev, ...newEvents]);
        }
      } catch {
        // ignore polling errors
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [run.id, isLive, isStreamingConnected, events]);

  // Poll shell log for running runs
  useEffect(() => {
    if (!isLive || isStreamingConnected) return;
    const interval = setInterval(async () => {
      try {
        const result = await heartbeatsApi.log(run.id, logOffset, 256_000);
        if (result.content) {
          appendLogContent(result.content, result.nextOffset === undefined);
        }
        if (result.nextOffset !== undefined) {
          setLogOffset(result.nextOffset);
        } else if (result.content.length > 0) {
          setLogOffset((prev) => prev + result.content.length);
        }
      } catch (err) {
        if (isRunLogUnavailable(err)) return;
        // ignore polling errors
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [run.id, isLive, isStreamingConnected, logOffset]);

  // Stream live updates from websocket (primary path for running runs).
  useEffect(() => {
    if (!isLive) return;

    let closed = false;
    let reconnectTimer: number | null = null;
    let socket: WebSocket | null = null;

    const scheduleReconnect = () => {
      if (closed) return;
      reconnectTimer = window.setTimeout(connect, 1500);
    };

    const connect = () => {
      if (closed) return;
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const url = `${protocol}://${window.location.host}/api/companies/${encodeURIComponent(run.companyId)}/events/ws`;
      socket = new WebSocket(url);

      socket.onopen = () => {
        setIsStreamingConnected(true);
      };

      socket.onmessage = (message) => {
        const rawMessage = typeof message.data === "string" ? message.data : "";
        if (!rawMessage) return;

        let event: LiveEvent;
        try {
          event = JSON.parse(rawMessage) as LiveEvent;
        } catch {
          return;
        }

        if (event.companyId !== run.companyId) return;
        const payload = asRecord(event.payload);
        const eventRunId = asNonEmptyString(payload?.runId);
        if (!payload || eventRunId !== run.id) return;

        if (event.type === "heartbeat.run.log") {
          const chunk = typeof payload.chunk === "string" ? payload.chunk : "";
          if (!chunk) return;
          const streamRaw = asNonEmptyString(payload.stream);
          const stream = streamRaw === "stderr" || streamRaw === "system" ? streamRaw : "stdout";
          const ts = asNonEmptyString((payload as Record<string, unknown>).ts) ?? event.createdAt;
          setLogLines((prev) => [...prev, { ts, stream, chunk }]);
          return;
        }

        if (event.type !== "heartbeat.run.event") return;

        const seq = typeof payload.seq === "number" ? payload.seq : null;
        if (seq === null || !Number.isFinite(seq)) return;

        const streamRaw = asNonEmptyString(payload.stream);
        const stream =
          streamRaw === "stdout" || streamRaw === "stderr" || streamRaw === "system"
            ? streamRaw
            : null;
        const levelRaw = asNonEmptyString(payload.level);
        const level =
          levelRaw === "info" || levelRaw === "warn" || levelRaw === "error"
            ? levelRaw
            : null;

        const liveEvent: HeartbeatRunEvent = {
          id: seq,
          companyId: run.companyId,
          runId: run.id,
          agentId: run.agentId,
          seq,
          eventType: asNonEmptyString(payload.eventType) ?? "event",
          stream,
          level,
          color: asNonEmptyString(payload.color),
          message: asNonEmptyString(payload.message),
          payload: asRecord(payload.payload),
          createdAt: new Date(event.createdAt),
        };

        setEvents((prev) => {
          if (prev.some((existing) => existing.seq === seq)) return prev;
          return [...prev, liveEvent];
        });
      };

      socket.onerror = () => {
        socket?.close();
      };

      socket.onclose = () => {
        setIsStreamingConnected(false);
        scheduleReconnect();
      };
    };

    connect();

    return () => {
      closed = true;
      setIsStreamingConnected(false);
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close(1000, "run_detail_unmount");
      }
    };
  }, [isLive, run.companyId, run.id, run.agentId]);

  const adapterInvokePayload = useMemo(() => {
    const evt = events.find((e) => e.eventType === "adapter.invoke");
    return asRecord(evt?.payload ?? null);
  }, [events]);

  const adapter = useMemo(() => getUIAdapter(adapterType), [adapterType]);
  const transcript = useMemo(() => buildTranscript(logLines, adapter.parseStdoutLine), [logLines, adapter]);

  if (loading && logLoading) {
    return <p className="text-xs text-muted-foreground">Loading run logs...</p>;
  }

  if (events.length === 0 && logLines.length === 0 && !logError) {
    return <p className="text-xs text-muted-foreground">No log events.</p>;
  }

  const levelColors: Record<string, string> = {
    info: "text-foreground",
    warn: "text-yellow-600 dark:text-yellow-400",
    error: "text-red-600 dark:text-red-400",
  };

  const streamColors: Record<string, string> = {
    stdout: "text-foreground",
    stderr: "text-red-600 dark:text-red-300",
    system: "text-blue-600 dark:text-blue-300",
  };

  return (
    <div className="space-y-3">
      {adapterInvokePayload && (
        <div className="rounded-lg border border-border bg-background/60 p-3 space-y-2">
          <div className="text-xs font-medium text-muted-foreground">Invocation</div>
          {typeof adapterInvokePayload.adapterType === "string" && (
            <div className="text-xs"><span className="text-muted-foreground">Adapter: </span>{adapterInvokePayload.adapterType}</div>
          )}
          {typeof adapterInvokePayload.cwd === "string" && (
            <div className="text-xs break-all"><span className="text-muted-foreground">Working dir: </span><span className="font-mono">{adapterInvokePayload.cwd}</span></div>
          )}
          {typeof adapterInvokePayload.command === "string" && (
            <div className="text-xs break-all">
              <span className="text-muted-foreground">Command: </span>
              <span className="font-mono">
                {[
                  adapterInvokePayload.command,
                  ...(Array.isArray(adapterInvokePayload.commandArgs)
                    ? adapterInvokePayload.commandArgs.filter((v): v is string => typeof v === "string")
                    : []),
                ].join(" ")}
              </span>
            </div>
          )}
          {Array.isArray(adapterInvokePayload.commandNotes) && adapterInvokePayload.commandNotes.length > 0 && (
            <div>
              <div className="text-xs text-muted-foreground mb-1">Command notes</div>
              <ul className="list-disc pl-5 space-y-1">
                {adapterInvokePayload.commandNotes
                  .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
                  .map((note, idx) => (
                    <li key={`${idx}-${note}`} className="text-xs break-all font-mono">
                      {note}
                    </li>
                  ))}
              </ul>
            </div>
          )}
          {adapterInvokePayload.prompt !== undefined && (
            <div>
              <div className="text-xs text-muted-foreground mb-1">Prompt</div>
              <pre className="bg-neutral-100 dark:bg-neutral-950 rounded-md p-2 text-xs overflow-x-auto whitespace-pre-wrap">
                {typeof adapterInvokePayload.prompt === "string"
                  ? adapterInvokePayload.prompt
                  : JSON.stringify(adapterInvokePayload.prompt, null, 2)}
              </pre>
            </div>
          )}
          {adapterInvokePayload.context !== undefined && (
            <div>
              <div className="text-xs text-muted-foreground mb-1">Context</div>
              <pre className="bg-neutral-100 dark:bg-neutral-950 rounded-md p-2 text-xs overflow-x-auto whitespace-pre-wrap">
                {JSON.stringify(adapterInvokePayload.context, null, 2)}
              </pre>
            </div>
          )}
          {adapterInvokePayload.env !== undefined && (
            <div>
              <div className="text-xs text-muted-foreground mb-1">Environment</div>
              <pre className="bg-neutral-100 dark:bg-neutral-950 rounded-md p-2 text-xs overflow-x-auto whitespace-pre-wrap font-mono">
                {formatEnvForDisplay(adapterInvokePayload.env)}
              </pre>
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          Transcript ({transcript.length})
        </span>
        <div className="flex items-center gap-2">
          {isLive && !isFollowing && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                const container = getScrollContainer();
                isFollowingRef.current = true;
                setIsFollowing(true);
                scrollToContainerBottom(container, "auto");
                lastMetricsRef.current = readScrollMetrics(container);
              }}
            >
              Jump to live
            </Button>
          )}
          {isLive && (
            <span className="flex items-center gap-1 text-xs text-cyan-400">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-400" />
              </span>
              Live
            </span>
          )}
        </div>
      </div>
      <div className="bg-neutral-100 dark:bg-neutral-950 rounded-lg p-3 font-mono text-xs space-y-0.5 overflow-x-hidden">
        {transcript.length === 0 && !run.logRef && (
          <div className="text-neutral-500">No persisted transcript for this run.</div>
        )}
        {transcript.map((entry, idx) => {
          const time = new Date(entry.ts).toLocaleTimeString("en-US", { hour12: false });
          const grid = "grid grid-cols-[auto_auto_1fr] gap-x-2 sm:gap-x-3 items-baseline";
          const tsCell = "text-neutral-400 dark:text-neutral-600 select-none w-12 sm:w-16 text-[10px] sm:text-xs";
          const lblCell = "w-14 sm:w-20 text-[10px] sm:text-xs";
          const contentCell = "min-w-0 whitespace-pre-wrap break-words overflow-hidden";
          const expandCell = "col-span-full md:col-start-3 md:col-span-1";

          if (entry.kind === "assistant") {
            return (
              <div key={`${entry.ts}-assistant-${idx}`} className={cn(grid, "py-0.5")}>
                <span className={tsCell}>{time}</span>
                <span className={cn(lblCell, "text-green-700 dark:text-green-300")}>assistant</span>
                <span className={cn(contentCell, "text-green-900 dark:text-green-100")}>{entry.text}</span>
              </div>
            );
          }

          if (entry.kind === "thinking") {
            return (
              <div key={`${entry.ts}-thinking-${idx}`} className={cn(grid, "py-0.5")}>
                <span className={tsCell}>{time}</span>
                <span className={cn(lblCell, "text-green-600/60 dark:text-green-300/60")}>thinking</span>
                <span className={cn(contentCell, "text-green-800/60 dark:text-green-100/60 italic")}>{entry.text}</span>
              </div>
            );
          }

          if (entry.kind === "user") {
            return (
              <div key={`${entry.ts}-user-${idx}`} className={cn(grid, "py-0.5")}>
                <span className={tsCell}>{time}</span>
                <span className={cn(lblCell, "text-neutral-500 dark:text-neutral-400")}>user</span>
                <span className={cn(contentCell, "text-neutral-700 dark:text-neutral-300")}>{entry.text}</span>
              </div>
            );
          }

          if (entry.kind === "tool_call") {
            return (
              <div key={`${entry.ts}-tool-${idx}`} className={cn(grid, "gap-y-1 py-0.5")}>
                <span className={tsCell}>{time}</span>
                <span className={cn(lblCell, "text-yellow-700 dark:text-yellow-300")}>tool_call</span>
                <span className="text-yellow-900 dark:text-yellow-100 min-w-0">{entry.name}</span>
                <pre className={cn(expandCell, "bg-neutral-200 dark:bg-neutral-900 rounded p-2 text-[11px] overflow-x-auto whitespace-pre-wrap text-neutral-800 dark:text-neutral-200")}>
                  {JSON.stringify(entry.input, null, 2)}
                </pre>
              </div>
            );
          }

          if (entry.kind === "tool_result") {
            return (
              <div key={`${entry.ts}-toolres-${idx}`} className={cn(grid, "gap-y-1 py-0.5")}>
                <span className={tsCell}>{time}</span>
                <span className={cn(lblCell, entry.isError ? "text-red-600 dark:text-red-300" : "text-purple-600 dark:text-purple-300")}>tool_result</span>
                {entry.isError ? <span className="text-red-600 dark:text-red-400 min-w-0">error</span> : <span />}
                <pre className={cn(expandCell, "bg-neutral-100 dark:bg-neutral-900 rounded p-2 text-[11px] overflow-x-auto whitespace-pre-wrap text-neutral-700 dark:text-neutral-300 max-h-60 overflow-y-auto")}>
                  {(() => { try { return JSON.stringify(JSON.parse(entry.content), null, 2); } catch { return entry.content; } })()}
                </pre>
              </div>
            );
          }

          if (entry.kind === "init") {
            return (
              <div key={`${entry.ts}-init-${idx}`} className={grid}>
                <span className={tsCell}>{time}</span>
                <span className={cn(lblCell, "text-blue-700 dark:text-blue-300")}>init</span>
                <span className={cn(contentCell, "text-blue-900 dark:text-blue-100")}>model: {entry.model}{entry.sessionId ? `, session: ${entry.sessionId}` : ""}</span>
              </div>
            );
          }

          if (entry.kind === "result") {
            return (
              <div key={`${entry.ts}-result-${idx}`} className={cn(grid, "gap-y-1 py-0.5")}>
                <span className={tsCell}>{time}</span>
                <span className={cn(lblCell, "text-cyan-700 dark:text-cyan-300")}>result</span>
                <span className={cn(contentCell, "text-cyan-900 dark:text-cyan-100")}>
                  tokens in={formatTokens(entry.inputTokens)} out={formatTokens(entry.outputTokens)} cached={formatTokens(entry.cachedTokens)} cost=${entry.costUsd.toFixed(6)}
                </span>
                {(entry.subtype || entry.isError || entry.errors.length > 0) && (
                  <div className={cn(expandCell, "text-red-600 dark:text-red-300 whitespace-pre-wrap break-words")}>
                    subtype={entry.subtype || "unknown"} is_error={entry.isError ? "true" : "false"}
                    {entry.errors.length > 0 ? ` errors=${entry.errors.join(" | ")}` : ""}
                  </div>
                )}
                {entry.text && (
                  <div className={cn(expandCell, "whitespace-pre-wrap break-words text-neutral-800 dark:text-neutral-100")}>{entry.text}</div>
                )}
              </div>
            );
          }

          const rawText = entry.text;
          const label =
            entry.kind === "stderr" ? "stderr" :
            entry.kind === "system" ? "system" :
            "stdout";
          const color =
            entry.kind === "stderr" ? "text-red-600 dark:text-red-300" :
            entry.kind === "system" ? "text-blue-600 dark:text-blue-300" :
            "text-neutral-500";
          return (
            <div key={`${entry.ts}-raw-${idx}`} className={grid}>
              <span className={tsCell}>{time}</span>
              <span className={cn(lblCell, color)}>{label}</span>
              <span className={cn(contentCell, color)}>{rawText}</span>
            </div>
          )
        })}
        {logError && <div className="text-red-600 dark:text-red-300">{logError}</div>}
        <div ref={logEndRef} />
      </div>

      {(run.status === "failed" || run.status === "timed_out") && (
        <div className="rounded-lg border border-red-300 dark:border-red-500/30 bg-red-50 dark:bg-red-950/20 p-3 space-y-2">
          <div className="text-xs font-medium text-red-700 dark:text-red-300">Failure details</div>
          {run.error && (
            <div className="text-xs text-red-600 dark:text-red-200">
              <span className="text-red-700 dark:text-red-300">Error: </span>
              {run.error}
            </div>
          )}
          {run.stderrExcerpt && run.stderrExcerpt.trim() && (
            <div>
              <div className="text-xs text-red-700 dark:text-red-300 mb-1">stderr excerpt</div>
              <pre className="bg-red-50 dark:bg-neutral-950 rounded-md p-2 text-xs overflow-x-auto whitespace-pre-wrap text-red-800 dark:text-red-100">
                {run.stderrExcerpt}
              </pre>
            </div>
          )}
          {run.resultJson && (
            <div>
              <div className="text-xs text-red-700 dark:text-red-300 mb-1">adapter result JSON</div>
              <pre className="bg-red-50 dark:bg-neutral-950 rounded-md p-2 text-xs overflow-x-auto whitespace-pre-wrap text-red-800 dark:text-red-100">
                {JSON.stringify(run.resultJson, null, 2)}
              </pre>
            </div>
          )}
          {run.stdoutExcerpt && run.stdoutExcerpt.trim() && !run.resultJson && (
            <div>
              <div className="text-xs text-red-700 dark:text-red-300 mb-1">stdout excerpt</div>
              <pre className="bg-red-50 dark:bg-neutral-950 rounded-md p-2 text-xs overflow-x-auto whitespace-pre-wrap text-red-800 dark:text-red-100">
                {run.stdoutExcerpt}
              </pre>
            </div>
          )}
        </div>
      )}

      {events.length > 0 && (
        <div>
          <div className="mb-2 text-xs font-medium text-muted-foreground">Events ({events.length})</div>
          <div className="bg-neutral-100 dark:bg-neutral-950 rounded-lg p-3 font-mono text-xs space-y-0.5">
            {events.map((evt) => {
              const color = evt.color
                ?? (evt.level ? levelColors[evt.level] : null)
                ?? (evt.stream ? streamColors[evt.stream] : null)
                ?? "text-foreground";

              return (
                <div key={evt.id} className="flex gap-2">
                  <span className="text-neutral-400 dark:text-neutral-600 shrink-0 select-none w-16">
                    {new Date(evt.createdAt).toLocaleTimeString("en-US", { hour12: false })}
                  </span>
                  <span className={cn("shrink-0 w-14", evt.stream ? (streamColors[evt.stream] ?? "text-neutral-500") : "text-neutral-500")}>
                    {evt.stream ? `[${evt.stream}]` : ""}
                  </span>
                  <span className={cn("break-all", color)}>
                    {evt.message ?? (evt.payload ? JSON.stringify(evt.payload) : "")}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---- Keys Tab ---- */

function KeysTab({ agentId, companyId }: { agentId: string; companyId?: string }) {
  const queryClient = useQueryClient();
  const [newKeyName, setNewKeyName] = useState("");
  const [newToken, setNewToken] = useState<string | null>(null);
  const [tokenVisible, setTokenVisible] = useState(false);
  const [copied, setCopied] = useState(false);

  const { data: keys, isLoading } = useQuery({
    queryKey: queryKeys.agents.keys(agentId),
    queryFn: () => agentsApi.listKeys(agentId, companyId),
  });

  const createKey = useMutation({
    mutationFn: () => agentsApi.createKey(agentId, newKeyName.trim() || "Default", companyId),
    onSuccess: (data) => {
      setNewToken(data.token);
      setTokenVisible(true);
      setNewKeyName("");
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.keys(agentId) });
    },
  });

  const revokeKey = useMutation({
    mutationFn: (keyId: string) => agentsApi.revokeKey(agentId, keyId, companyId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.keys(agentId) });
    },
  });

  function copyToken() {
    if (!newToken) return;
    navigator.clipboard.writeText(newToken);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const activeKeys = (keys ?? []).filter((k: AgentKey) => !k.revokedAt);
  const revokedKeys = (keys ?? []).filter((k: AgentKey) => k.revokedAt);

  return (
    <div className="space-y-6">
      {/* New token banner */}
      {newToken && (
        <div className="border border-yellow-300 dark:border-yellow-600/40 bg-yellow-50 dark:bg-yellow-500/5 rounded-lg p-4 space-y-2">
          <p className="text-sm font-medium text-yellow-700 dark:text-yellow-400">
            API key created — copy it now, it will not be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-neutral-100 dark:bg-neutral-950 rounded px-3 py-1.5 text-xs font-mono text-green-700 dark:text-green-300 truncate">
              {tokenVisible ? newToken : newToken.replace(/./g, "•")}
            </code>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setTokenVisible((v) => !v)}
              title={tokenVisible ? "Hide" : "Show"}
            >
              {tokenVisible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={copyToken}
              title="Copy"
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
            {copied && <span className="text-xs text-green-400">Copied!</span>}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground text-xs"
            onClick={() => setNewToken(null)}
          >
            Dismiss
          </Button>
        </div>
      )}

      {/* Create new key */}
      <div className="border border-border rounded-lg p-4 space-y-3">
        <h3 className="text-xs font-medium text-muted-foreground flex items-center gap-2">
          <Key className="h-3.5 w-3.5" />
          Create API Key
        </h3>
        <p className="text-xs text-muted-foreground">
          API keys allow this agent to authenticate calls to the AoA server.
        </p>
        <div className="flex items-center gap-2">
          <Input
            placeholder="Key name (e.g. production)"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            className="h-8 text-sm"
            onKeyDown={(e) => {
              if (e.key === "Enter") createKey.mutate();
            }}
          />
          <Button
            size="sm"
            onClick={() => createKey.mutate()}
            disabled={createKey.isPending}
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            Create
          </Button>
        </div>
      </div>

      {/* Active keys */}
      {isLoading && <p className="text-sm text-muted-foreground">Loading keys...</p>}

      {!isLoading && activeKeys.length === 0 && !newToken && (
        <p className="text-sm text-muted-foreground">No active API keys.</p>
      )}

      {activeKeys.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-muted-foreground mb-2">
            Active Keys
          </h3>
          <div className="border border-border rounded-lg divide-y divide-border">
            {activeKeys.map((key: AgentKey) => (
              <div key={key.id} className="flex items-center justify-between px-4 py-2.5">
                <div>
                  <span className="text-sm font-medium">{key.name}</span>
                  <span className="text-xs text-muted-foreground ml-3">
                    Created {formatDate(key.createdAt)}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive text-xs"
                  onClick={() => revokeKey.mutate(key.id)}
                  disabled={revokeKey.isPending}
                >
                  Revoke
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Revoked keys */}
      {revokedKeys.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-muted-foreground mb-2">
            Revoked Keys
          </h3>
          <div className="border border-border rounded-lg divide-y divide-border opacity-50">
            {revokedKeys.map((key: AgentKey) => (
              <div key={key.id} className="flex items-center justify-between px-4 py-2.5">
                <div>
                  <span className="text-sm line-through">{key.name}</span>
                  <span className="text-xs text-muted-foreground ml-3">
                    Revoked {key.revokedAt ? formatDate(key.revokedAt) : ""}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* AgentSkillsTab now lives in ../components/agent-detail/AgentSkillsTab (shared with AoA). */
