import { useCallback, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../../context/CompanyContext";
import { useSidebar } from "../../context/SidebarContext";
import { queryKeys } from "../../lib/queryKeys";
import { agentsApi } from "../../api/agents";
import { relativeTime } from "../../lib/utils";
import { computeAgentKpis } from "../../lib/agent-kpis";
import { formatTrustScorePercent, hasTrustScoreData } from "../../lib/trust-score";
import { AgentInstructionsTab } from "../AgentInstructionsTab";
import { PageSkeleton } from "../PageSkeleton";
import { AgentDetailCore } from "./AgentDetailCore";
import { AgentSkillsTab } from "./AgentSkillsTab";
import type { HeroKpi } from "./AgentHeroCard";
import {
  useAgentDetailData,
  AgentOverview,
  AgentConfigurePage,
  RunsTab,
} from "../../pages/AgentDetail";

/**
 * AgentDetailContainer — hosts the agent-detail chrome for the Inbox Hub `agent`
 * tab (D4a). It replicates the route page's data orchestration via the shared
 * {@link useAgentDetailData} hook, keyed on the `agentId` PROP (no `useParams`),
 * then renders the same {@link AgentDetailCore} the route page feeds.
 *
 * Route-only chrome is intentionally omitted: no breadcrumbs, no URL/navigate
 * tab routing (tab selection is local component state here), no unsaved-changes
 * cross-page guard, and no run master-detail deep-linking (the Runs tab lists
 * runs; a specific run opens as its own hub `run` tab — see RunDetailContainer).
 */
export function AgentDetailContainer({
  agentId,
  companyId,
}: {
  agentId: string;
  companyId?: string;
}) {
  const { selectedCompanyId } = useCompany();
  const { isMobile } = useSidebar();
  const queryClient = useQueryClient();

  const lookupCompanyId = companyId ?? selectedCompanyId ?? undefined;

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
  } = useAgentDetailData({
    agentRef: agentId,
    lookupCompanyId,
    selectedCompanyId,
  });

  // Local (non-URL) tab state — the hub tab host owns the outer routing.
  const [activeView, setActiveView] = useState<string>("overview");

  // Dirty/save plumbing for the instructions + configure tabs (same shape the
  // route page wires, but scoped to this container instead of the URL).
  const [configDirty, setConfigDirty] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const saveConfigActionRef = useRef<(() => void) | null>(null);
  const cancelConfigActionRef = useRef<(() => void) | null>(null);
  const [instrDirty, setInstrDirty] = useState(false);
  const [instrSaving, setInstrSaving] = useState(false);
  const saveInstrActionRef = useRef<(() => void) | null>(null);
  const cancelInstrActionRef = useRef<(() => void) | null>(null);

  const setSaveConfigAction = useCallback((fn: (() => void) | null) => { saveConfigActionRef.current = fn; }, []);
  const setCancelConfigAction = useCallback((fn: (() => void) | null) => { cancelConfigActionRef.current = fn; }, []);
  const setSaveInstrAction = useCallback((fn: (() => void) | null) => { saveInstrActionRef.current = fn; }, []);
  const setCancelInstrAction = useCallback((fn: (() => void) | null) => { cancelInstrActionRef.current = fn; }, []);

  const updateIcon = useMutation({
    mutationFn: (icon: string) => agentsApi.update(agentLookupRef, { icon }, resolvedCompanyId ?? undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentLookupRef) });
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(resolvedCompanyId) });
      }
    },
  });

  const updatePermissions = useMutation({
    mutationFn: (canCreateAgents: boolean) =>
      agentsApi.updatePermissions(agentLookupRef, { canCreateAgents }, resolvedCompanyId ?? undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentLookupRef) });
      if (resolvedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(resolvedCompanyId) });
      }
    },
  });

  const heroModel = useMemo(
    () =>
      typeof (agent?.adapterConfig as Record<string, unknown> | null)?.model === "string"
        ? ((agent!.adapterConfig as Record<string, unknown>).model as string)
        : undefined,
    [agent],
  );

  const heroKpis: HeroKpi[] = useMemo(() => {
    if (!agent) return [];
    const heroKpiStats = computeAgentKpis({ runs: heartbeats ?? [], assignedIssues });
    const latestHeroRun = [...(heartbeats ?? [])].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )[0];
    return [
      { key: "tasks", label: "Tasks (wk)", value: heroKpiStats.tasksCompleted },
      { key: "success", label: "Success", value: heroKpiStats.successRate !== null ? `${heroKpiStats.successRate}%` : "—" },
      { key: "cost", label: "Cost (wk)", value: `$${heroKpiStats.cost.toFixed(2)}` },
      {
        key: "trust",
        label: "Trust",
        value: trustScore && hasTrustScoreData(trustScore) ? formatTrustScorePercent(trustScore.currentScore) : "—",
      },
      { key: "last-run", label: "Last run", value: latestHeroRun ? relativeTime(latestHeroRun.createdAt) : "—" },
      { key: "last-heartbeat", label: "Last heartbeat", value: agent.lastHeartbeatAt ? relativeTime(agent.lastHeartbeatAt) : "Never" },
    ];
  }, [agent, heartbeats, assignedIssues, trustScore]);

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!agent) return null;

  const isPendingApproval = agent.status === "pending_approval";
  const showActionBar =
    (activeView === "configure" && configDirty) || (activeView === "instructions" && instrDirty);
  const activeSaving = activeView === "instructions" ? instrSaving : configSaving;
  const activeSaveRef = activeView === "instructions" ? saveInstrActionRef : saveConfigActionRef;
  const activeCancelRef = activeView === "instructions" ? cancelInstrActionRef : cancelConfigActionRef;

  return (
    <div className="h-full w-full overflow-auto p-5" data-testid="hub-agent-detail-container">
      {isPendingApproval && (
        <p className="mb-3 text-sm text-amber-500">
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
        onViewChange={setActiveView}
        heroKpis={heroKpis}
        heroBadges={{ adapter: agent.adapterType, model: heroModel }}
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
              <AgentOverview
                agent={agent}
                runs={heartbeats ?? []}
                assignedIssues={assignedIssues}
                runtimeState={runtimeState}
                reportsToAgent={reportsToAgent}
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
          if (view === "runs" && resolvedCompanyId) {
            return (
              <RunsTab
                runs={heartbeats ?? []}
                companyId={resolvedCompanyId}
                agentId={agent.id}
                agentRouteId={canonicalAgentRef}
                selectedRunId={null}
                adapterType={agent.adapterType}
              />
            );
          }
          if (view === "skills" && resolvedCompanyId) {
            return (
              <AgentSkillsTab
                agentId={agent.id}
                companyId={resolvedCompanyId}
                skillKeys={(agent as { skillKeys?: string[] }).skillKeys ?? []}
                expectedUpdatedAt={agent.updatedAt ? new Date(agent.updatedAt).toISOString() : undefined}
              />
            );
          }
          return null;
        }}
      />
    </div>
  );
}
