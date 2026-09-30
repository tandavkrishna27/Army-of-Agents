import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate, useBeforeUnload } from "@/lib/router";
import { useUnsavedChanges } from "@/hooks/useUnsavedChanges";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { companySkillsApi } from "../api/companySkills";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useSidebar } from "../context/SidebarContext";
import { queryKeys } from "../lib/queryKeys";
import { isUuidLike, type Agent } from "@armyofagents/shared";
import type { CompanySkillListItem } from "@armyofagents/shared";
import { AgentDetailCore } from "../components/agent-detail/AgentDetailCore";
import { AoaTriggersTab } from "../components/agent-detail/AoaTriggersTab";
import { AoaRunsPanel } from "../components/agent-detail/AoaRunsPanel";
import { AgentInstructionsTab } from "../components/AgentInstructionsTab";
import { AgentConfigForm } from "../components/AgentConfigForm";
import { AgentSaveWarnings } from "../components/AgentSaveWarnings";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusBadge } from "../components/StatusBadge";
import { roleLabels, adapterLabels } from "../components/agent-config-primitives";
import type { HeroKpi } from "../components/agent-detail/AgentHeroCard";
import { AgentSkillsTab } from "../components/agent-detail/AgentSkillsTab";
import { useToast } from "@/context/ToastContext";
import { ApiError } from "../api/client";
import { useTeamAccess } from "../hooks/useTeamAccess";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Settings, Pause, Play } from "lucide-react";
import { cn, relativeTime, formatDate } from "../lib/utils";

type AoaAgentView = "overview" | "instructions" | "runs" | "skills" | "configure" | "triggers";

function parseAoaView(value: string | null | undefined): AoaAgentView {
  if (value === "instructions") return value;
  if (value === "runs") return value;
  if (value === "skills") return value;
  if (value === "configure" || value === "configuration") return "configure";
  if (value === "triggers") return value;
  return "overview";
}

export function AoaAgentDetail() {
  const { companyPrefix, agentId, tab: urlTab } = useParams<{
    companyPrefix?: string;
    agentId: string;
    tab?: string;
  }>();

  const { companies, selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { isMobile } = useSidebar();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // Founder gate — mirrors TeamPage/CommanderTeamTab (useTeamAccess role === "founder").
  // Backend already founder-gates pause/resume/terminate; this is the UI parity.
  const { role: teamRole } = useTeamAccess(selectedCompanyId);
  const isFounder = teamRole === "founder";
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);

  const routeAgentRef = agentId ?? "";
  const routeCompanyId = useMemo(() => {
    if (!companyPrefix) return null;
    const requestedPrefix = companyPrefix.toUpperCase();
    return (
      companies.find((company) => company.issuePrefix.toUpperCase() === requestedPrefix)?.id ?? null
    );
  }, [companies, companyPrefix]);

  const lookupCompanyId = routeCompanyId ?? selectedCompanyId ?? undefined;
  const canFetchAgent =
    routeAgentRef.length > 0 &&
    (isUuidLike(routeAgentRef) || Boolean(lookupCompanyId));

  const activeView = parseAoaView(urlTab);

  // Dirty state for instructions + configure tabs
  const [configDirty, setConfigDirty] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const saveConfigActionRef = useRef<(() => void) | null>(null);
  const cancelConfigActionRef = useRef<(() => void) | null>(null);
  const [instrDirty, setInstrDirty] = useState(false);
  const [instrSaving, setInstrSaving] = useState(false);
  const saveInstrActionRef = useRef<(() => void) | null>(null);
  const cancelInstrActionRef = useRef<(() => void) | null>(null);

  const setSaveConfigAction = useCallback((fn: (() => void) | null) => {
    saveConfigActionRef.current = fn;
  }, []);
  const setCancelConfigAction = useCallback((fn: (() => void) | null) => {
    cancelConfigActionRef.current = fn;
  }, []);
  const setSaveInstrAction = useCallback((fn: (() => void) | null) => {
    saveInstrActionRef.current = fn;
  }, []);
  const setCancelInstrAction = useCallback((fn: (() => void) | null) => {
    cancelInstrActionRef.current = fn;
  }, []);

  const { data: agent, isLoading, error } = useQuery({
    queryKey: [...queryKeys.agents.detail(routeAgentRef), lookupCompanyId ?? null],
    queryFn: () => agentsApi.get(routeAgentRef, lookupCompanyId),
    enabled: canFetchAgent,
  });

  const resolvedCompanyId = agent?.companyId ?? selectedCompanyId;
  // AoA detail is UUID-routed and must NEVER slug-canonicalize: kind='aoa'
  // agents are deliberately excluded from the server's urlKey resolver
  // (resolveByReference is hardcoded eq(agents.kind,"org") — Plan-A M1 /
  // Decision #99). Resolving a name-slug for an aoa agent 404s; only the
  // by-id path resolves kind='aoa'. So every aoa route/tab URL stays
  // /team/aoa/<uuid>. (Worker AgentDetail keeps its slug pretty-URLs —
  // workers ARE in the urlKey resolver. Do not change that.)
  const aoaRouteRef = agent?.id ?? routeAgentRef;

  // Sync company if agent belongs to a different company
  useEffect(() => {
    if (!agent?.companyId || agent.companyId === selectedCompanyId) return;
    setSelectedCompanyId(agent.companyId, { source: "route_sync" });
  }, [agent?.companyId, selectedCompanyId, setSelectedCompanyId]);

  // Update breadcrumbs
  useEffect(() => {
    const agentName = agent?.name ?? routeAgentRef ?? "AoA Agent";
    const crumbs: { label: string; href?: string }[] = [
      { label: "Team", href: "/team" },
    ];
    if (activeView === "overview") {
      crumbs.push({ label: agentName });
    } else {
      crumbs.push({ label: agentName, href: `/team/aoa/${aoaRouteRef}` });
      if (activeView === "triggers") crumbs.push({ label: "Triggers" });
      else if (activeView === "runs") crumbs.push({ label: "Runs" });
      else if (activeView === "configure") crumbs.push({ label: "Configure" });
    }
    setBreadcrumbs(crumbs);
  }, [setBreadcrumbs, agent, routeAgentRef, aoaRouteRef, activeView]);

  useBeforeUnload(
    useCallback(
      (event) => {
        if (!configDirty && !instrDirty) return;
        event.preventDefault();
        event.returnValue = "";
      },
      [configDirty, instrDirty],
    ),
  );

  // Global cross-page guard (sidebar <Link> + browser Back/Forward + tab switch).
  // Tab-close/refresh stays covered by useBeforeUnload above (useBlocker can't).
  useUnsavedChanges(configDirty || instrDirty);

  // Update icon mutation
  const updateIcon = useMutation({
    mutationFn: (icon: string) =>
      agentsApi.update(routeAgentRef, { icon }, resolvedCompanyId ?? undefined),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(routeAgentRef) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(aoaRouteRef) });
      if (resolvedCompanyId) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(resolvedCompanyId) });
      }
    },
  });

  // Lifecycle control — mirrors org AgentDetail's agentAction mutation, minus
  // "invoke" and "terminate". Manually invoking a kind='aoa' agent routes
  // through the heartbeat runtime, which FX3 closed (enqueueWakeup refuses
  // kind='aoa'). Terminate is removed because AoA agents are reserved
  // framework agents and are non-deletable/non-terminable (FX-del). So this
  // is Pause / Resume only.
  const agentAction = useMutation({
    mutationFn: async (action: "pause" | "resume") => {
      switch (action) {
        case "pause":
          return agentsApi.pause(aoaRouteRef, resolvedCompanyId ?? undefined);
        case "resume":
          return agentsApi.resume(aoaRouteRef, resolvedCompanyId ?? undefined);
      }
    },
    onSuccess: () => {
      setLifecycleError(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(aoaRouteRef) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(routeAgentRef) });
      if (resolvedCompanyId) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(resolvedCompanyId) });
      }
    },
    onError: (err) => {
      setLifecycleError(err instanceof Error ? err.message : "Action failed");
    },
  });

  // Top-level AoA runs (shares AoaOverview's query key → deduped) for the hero "Total runs" KPI.
  const { data: aoaRunsForKpi } = useQuery({
    queryKey: ["aoa-runs", agent?.id ?? aoaRouteRef, resolvedCompanyId],
    queryFn: () => agentsApi.getAoaRuns(agent?.id ?? aoaRouteRef, resolvedCompanyId as string),
    enabled: Boolean(agent && resolvedCompanyId),
  });

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!agent) return null;

  const showActionBar =
    (activeView === "configure" && configDirty) ||
    (activeView === "instructions" && instrDirty);
  const activeSaving = activeView === "instructions" ? instrSaving : configSaving;
  const activeSaveRef =
    activeView === "instructions" ? saveInstrActionRef : saveConfigActionRef;
  const activeCancelRef =
    activeView === "instructions" ? cancelInstrActionRef : cancelConfigActionRef;

  const tabs = [
    { value: "overview", label: "Overview" },
    { value: "instructions", label: "Instructions" },
    { value: "runs", label: "Runs" },
    { value: "skills", label: "Skills" },
    { value: "configure", label: "Config" },
    { value: "triggers", label: "Triggers" },
  ];

  // Founder-gated lifecycle control (Pause/Resume toggle + StatusBadge).
  // No Invoke — see agentAction comment / FX3. No Terminate: AoA agents
  // (Commander + sub-agents) are reserved framework agents and are
  // non-deletable/non-terminable (FX-del); the backend hard-blocks
  // DELETE /agents/:id and /agents/:id/terminate for kind='aoa'.
  const headerActions = isFounder ? (
    <>
      {agent.status === "paused" ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => agentAction.mutate("resume")}
          disabled={agentAction.isPending}
        >
          <Play className="h-3.5 w-3.5 sm:mr-1" />
          <span className="hidden sm:inline">Resume</span>
        </Button>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => agentAction.mutate("pause")}
          disabled={agentAction.isPending}
        >
          <Pause className="h-3.5 w-3.5 sm:mr-1" />
          <span className="hidden sm:inline">Pause</span>
        </Button>
      )}
    </>
  ) : undefined;

  const heroBadges = {
    adapter: agent.adapterType,
    model:
      typeof (agent.adapterConfig as Record<string, unknown> | null)?.model === "string"
        ? ((agent.adapterConfig as Record<string, unknown>).model as string)
        : undefined,
  };
  // /aoa-runs now returns { runs, total } — `total` is the true count(*) over
  // all runs for this agent (not the capped page length), so the KPI shows the
  // real total-ever.
  const totalRunCount = aoaRunsForKpi?.total ?? 0;
  const heroKpis: HeroKpi[] = [
    { key: "role", label: "Role", value: roleLabels[agent.role] ?? agent.role },
    {
      key: "total-runs",
      label: "Total runs",
      value: totalRunCount,
    },
  ];

  return (
    <>
    <AgentDetailCore
      agent={agent}
      tabs={tabs}
      headerActions={headerActions}
      heroKpis={heroKpis}
      heroBadges={heroBadges}
      headerError={lifecycleError}
      activeView={activeView}
      onViewChange={(v) => {
        if (v === activeView) return; // parity with AgentDetail: no redundant same-path nav
        const target =
          v === "overview"
            ? `/team/aoa/${aoaRouteRef}`
            : `/team/aoa/${aoaRouteRef}/${v}`;
        navigate(target);
      }}
      actionBar={{
        show: showActionBar,
        saving: activeSaving,
        onSave: () => activeSaveRef.current?.(),
        onCancel: () => activeCancelRef.current?.(),
      }}
      isMobile={isMobile}
      onIconChange={(icon) => updateIcon.mutate(icon)}
      renderTab={(view) => {
        if (view === "overview") {
          return (
            <AoaOverview
              agent={agent}
              companyId={resolvedCompanyId ?? ""}
              agentRef={aoaRouteRef}
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
        if (view === "runs") {
          return resolvedCompanyId ? (
            <AoaRunsPanel agentId={agent.id} companyId={resolvedCompanyId} />
          ) : null;
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
        if (view === "configure") {
          return resolvedCompanyId ? (
            <AoaConfigurePage
              agent={agent}
              companyId={resolvedCompanyId}
              onDirtyChange={setConfigDirty}
              onSaveActionChange={setSaveConfigAction}
              onCancelActionChange={setCancelConfigAction}
              onSavingChange={setConfigSaving}
            />
          ) : null;
        }
        if (view === "triggers") {
          return resolvedCompanyId ? (
            <AoaTriggersTab agentId={agent.id} companyId={resolvedCompanyId} />
          ) : null;
        }
        return null;
      }}
    />
    </>
  );
}

/* ---- AoA Overview ---- */

function AoaOverview({
  agent,
  companyId,
  agentRef,
}: {
  agent: Agent;
  companyId: string;
  agentRef: string;
}) {
  const { data: runs } = useQuery({
    queryKey: ["aoa-runs", agent.id, companyId],
    queryFn: () => agentsApi.getAoaRuns(agent.id, companyId),
    enabled: Boolean(companyId),
  });

  const totalRuns = runs?.total ?? 0;
  const runList = (runs?.runs ?? []) as Array<{
    id: string;
    triggerType?: string;
    summary?: string | null;
    status: string;
    createdAt: string | Date;
    durationMs?: number | null;
  }>;

  const latestRun = runList[0] ?? null;
  const runtimeConfig = (agent as any).runtimeConfig as Record<string, unknown> | undefined;
  const aoaConfig = runtimeConfig?.aoa as Record<string, unknown> | undefined;

  return (
    <div className="space-y-8">
      {/* Quick stats */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <div className="border border-border rounded-lg p-4">
          <span className="text-xs text-muted-foreground block">Status</span>
          <div className="mt-1">
            <StatusBadge status={agent.status} />
          </div>
        </div>
        <div className="border border-border rounded-lg p-4">
          <span className="text-xs text-muted-foreground block">Role</span>
          <span className="text-sm font-medium block mt-1">
            {roleLabels[agent.role] ?? agent.role}
          </span>
        </div>
        <div className="border border-border rounded-lg p-4">
          <span className="text-xs text-muted-foreground block">Total runs</span>
          <span data-testid="aoa-overview-total-runs" className="text-2xl font-semibold block mt-1">{totalRuns}</span>
        </div>
      </div>

      {/* Last run */}
      {latestRun && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Latest Run</h3>
          <div className="border border-border rounded-lg p-4 space-y-1">
            <div className="flex items-center gap-2 text-xs">
              <StatusBadge status={latestRun.status} />
              <span className="text-muted-foreground">{relativeTime(latestRun.createdAt)}</span>
              {latestRun.triggerType && (
                <span className="font-mono text-muted-foreground">{latestRun.triggerType}</span>
              )}
            </div>
            {latestRun.summary && (
              <p className="text-xs text-muted-foreground line-clamp-2">{latestRun.summary}</p>
            )}
          </div>
        </div>
      )}

      {/* AoA Config summary */}
      {aoaConfig && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">AoA Configuration</h3>
            <Link
              to={`/team/aoa/${agentRef}/configure`}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors no-underline"
            >
              <Settings className="h-3 w-3" />
              Manage &rarr;
            </Link>
          </div>
          <div className="border border-border rounded-lg p-4">
            <pre className="text-xs text-muted-foreground overflow-x-auto whitespace-pre-wrap">
              {JSON.stringify(aoaConfig, null, 2)}
            </pre>
          </div>
        </div>
      )}

      {/* Instructions excerpt (if available in runtimeConfig or as any-typed field) */}
      {(agent as any).instructions && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Instructions excerpt</h3>
          <div className="border border-border rounded-lg p-4">
            <p className="text-xs text-muted-foreground line-clamp-5 whitespace-pre-wrap">
              {typeof (agent as any).instructions === "string"
                ? (agent as any).instructions
                : JSON.stringify((agent as any).instructions)}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---- AoA Configure Page ---- */

function AoaConfigurePage({
  agent,
  companyId,
  onDirtyChange,
  onSaveActionChange,
  onCancelActionChange,
  onSavingChange,
}: {
  agent: Agent;
  companyId: string;
  onDirtyChange: (dirty: boolean) => void;
  onSaveActionChange: (save: (() => void) | null) => void;
  onCancelActionChange: (cancel: (() => void) | null) => void;
  onSavingChange: (saving: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const { data: adapterModels } = useQuery({
    queryKey: queryKeys.agents.adapterModels(companyId, agent.adapterType),
    queryFn: () => agentsApi.adapterModels(companyId, agent.adapterType),
    enabled: Boolean(companyId),
  });

  const [saveWarnings, setSaveWarnings] = useState<string[]>([]);

  const updateAgent = useMutation({
    mutationFn: (data: Record<string, unknown>) => agentsApi.update(agent.id, data, companyId),
    onSuccess: (result) => {
      // Cache the saved row (incl. fresh updatedAt) synchronously so a quick
      // repeat save uses the up-to-date optimistic-concurrency token, not the
      // stale pre-save one (which would 409 the user against their own save).
      // The invalidate still refetches for eventual consistency. (Decision #104)
      queryClient.setQueryData(queryKeys.agents.detail(agent.id), result);
      if (agent.urlKey) queryClient.setQueryData(queryKeys.agents.detail(agent.urlKey), result);
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
      if (agent.urlKey) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) });
      }
      setSaveWarnings(result.warnings ?? []);
    },
    onError: (err) => {
      // Optimistic-concurrency conflict: someone else changed the agent. Refetch
      // the latest and tell the user to redo their edit. (Decision #104)
      if (err instanceof ApiError && err.status === 409) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) });
        if (agent.urlKey) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.urlKey) });
        }
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
    <div className="max-w-[1400px] space-y-6">
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
      />

      <AgentSaveWarnings warnings={saveWarnings} />
    </div>
  );
}

