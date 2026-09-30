import { useCallback, useEffect, useState, type ComponentType } from "react";
import { useSearchParams } from "react-router-dom";
import { useNavigate } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Sparkles,
  UserRound,
  Users,
} from "lucide-react";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { teamApi } from "../api/team";
import { trustScoresApi } from "../api/trust-scores";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgentsTab } from "../components/team/AgentsTab";
import {
  AOA_TEAM_SUB_TABS,
  CommanderTeamTab,
  type AoaTeamSubTab,
} from "../components/team/CommanderTeamTab";
import { HumansTab } from "../components/team/HumansTab";
import { OrgTreeTab, type OrgNodeAction } from "../components/team/OrgTreeTab";
import { TasksTab } from "../components/team/TasksTab";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { useTeamAccess } from "../hooks/useTeamAccess";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { TeamsListPage } from "./TeamsListPage";
import { TooltipProvider } from "@/components/ui/tooltip";

const VALID_TABS = ["org", "agents", "humans", "teams", "aoa", "commander", "tasks"] as const;
type TeamTab = (typeof VALID_TABS)[number];
type TeamSection = "org" | "agents" | "humans" | "teams" | "aoa";

const SECTION_ITEMS: Array<{ id: TeamSection; label: string; icon: ComponentType<{ className?: string }> }> = [
  { id: "org", label: "Organization", icon: Network },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "humans", label: "Humans", icon: UserRound },
  { id: "teams", label: "Teams", icon: Users },
  { id: "aoa", label: "AoA Team", icon: Sparkles },
];

const SECTION_LABELS: Record<TeamSection, string> = {
  org: "Organization",
  agents: "Agents",
  humans: "Humans",
  teams: "Teams",
  aoa: "AoA Team",
};

function isValidTab(value: string | null): value is TeamTab {
  return VALID_TABS.includes(value as TeamTab);
}

function normalizeTeamRoute(rawTab: string | null): {
  section: TeamSection;
  aoaSubTab: AoaTeamSubTab;
} {
  switch (rawTab) {
    case "agents":
    case "humans":
    case "teams":
      return { section: rawTab, aoaSubTab: "roster" };
    case "commander":
    case "aoa":
      return { section: "aoa", aoaSubTab: "roster" };
    case "tasks":
      return { section: "aoa", aoaSubTab: "tasks" };
    case "org":
    default:
      return { section: "org", aoaSubTab: "roster" };
  }
}

function normalizeAoaSubTab(value: string | null, fallback: AoaTeamSubTab): AoaTeamSubTab {
  return value === "tasks" || value === "kanban" || value === "governance" || value === "roster"
    ? value
    : fallback;
}

export function TeamPage() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const rawTab = searchParams.get("tab");
  const normalizedRoute = normalizeTeamRoute(isValidTab(rawTab) ? rawTab : null);
  const activeSection = normalizedRoute.section;
  const activeAoaSubTab = normalizeAoaSubTab(searchParams.get("aoaTab"), normalizedRoute.aoaSubTab);
  const highlightId = searchParams.get("highlight");

  const navigate = useNavigate();
  const { pushToast } = useToast();
  const {
    summary: teamSummary,
    permissions,
    role,
    isLoading: isTeamLoading,
  } = useTeamAccess(selectedCompanyId);

  const orgTreeQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.org.tree(selectedCompanyId) : ["org", "none", "tree"],
    queryFn: () => agentsApi.org(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const agentsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.agents.list(selectedCompanyId) : ["agents", "none"],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const commanderAgentsQuery = useQuery({
    queryKey: selectedCompanyId ? ["aoa-agents", selectedCompanyId] : ["aoa-agents", "none"],
    queryFn: () => agentsApi.listAoa(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const commanderTrustQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.trustScores.list(selectedCompanyId)
      : ["trust-scores", "none"],
    queryFn: () => trustScoresApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const commanderLiveRunsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.liveRuns(selectedCompanyId) : ["live-runs", "none"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId) && activeSection === "aoa" && activeAoaSubTab === "kanban",
    refetchInterval: 10_000,
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Team" }]);
  }, [setBreadcrumbs]);

  const setTeamSection = useCallback(
    (section: TeamSection) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("tab", section === "aoa" ? "aoa" : section);
        next.delete("aoaTab");
        next.delete("highlight");
        return next;
      });
    },
    [setSearchParams],
  );

  const setAoaSubTab = useCallback(
    (tab: AoaTeamSubTab) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("tab", "aoa");
        next.set("aoaTab", tab);
        next.delete("highlight");
        return next;
      });
    },
    [setSearchParams],
  );

  const handleNodeClick = useCallback(
    (id: string, nodeType: "agent" | "user") => {
      const next = new URLSearchParams();
      next.set("tab", nodeType === "agent" ? "agents" : "humans");
      next.set("highlight", id);
      setSearchParams(next, { replace: true });
    },
    [setSearchParams],
  );

  const invalidateAll = useCallback(() => {
    if (!selectedCompanyId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.org.tree(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.team.summary(selectedCompanyId) });
  }, [queryClient, selectedCompanyId]);

  const resendInviteMutation = useMutation({
    mutationFn: (inviteId: string) => teamApi.resendInvite(selectedCompanyId!, inviteId),
    onSuccess: () => {
      invalidateAll();
      pushToast({ title: "Invite resent", tone: "success" });
    },
    onError: (err: Error) => pushToast({ title: "Failed", body: err.message, tone: "error" }),
  });

  const revokeInviteMutation = useMutation({
    mutationFn: (inviteId: string) => teamApi.revokeInvite(selectedCompanyId!, inviteId),
    onSuccess: () => {
      invalidateAll();
      pushToast({ title: "Invite revoked", tone: "success" });
    },
    onError: (err: Error) => pushToast({ title: "Failed", body: err.message, tone: "error" }),
  });

  const handleNodeAction = useCallback(
    (action: OrgNodeAction) => {
      switch (action.type) {
        case "view-profile":
          navigate(`/team/${action.userId}`);
          break;
        case "view-agent":
          navigate(`/agents/${action.agentId}`);
          break;
        case "change-role":
          setSearchParams({ tab: "humans", highlight: action.userId });
          break;
        case "change-reports-to":
          setSearchParams({ tab: "agents", highlight: action.agentId });
          break;
        case "remove":
          setSearchParams({ tab: "humans", highlight: action.userId });
          break;
        case "resend-invite":
          resendInviteMutation.mutate(action.inviteId);
          break;
        case "revoke-invite":
          revokeInviteMutation.mutate(action.inviteId);
          break;
      }
    },
    [navigate, setSearchParams, resendInviteMutation, revokeInviteMutation],
  );

  if (!selectedCompanyId) {
    return <EmptyState icon={Users} message="Select a company to view team." />;
  }

  const isLoading =
    (activeSection === "org" && orgTreeQuery.isLoading) ||
    (activeSection === "agents" && agentsQuery.isLoading) ||
    (activeSection === "humans" && isTeamLoading) ||
    (activeSection === "aoa" &&
      activeAoaSubTab !== "tasks" &&
      (commanderAgentsQuery.isLoading ||
        commanderTrustQuery.isLoading ||
        commanderLiveRunsQuery.isLoading));

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col">
        <div className="flex min-h-0 flex-1 gap-2 overflow-hidden bg-muted/30 p-2">
          <aside
            data-testid="team-section-sidebar"
            className={cn(
              "flex shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-sm transition-[width] duration-200",
              sidebarCollapsed ? "w-[48px]" : "w-[220px]",
            )}
          >
            <div className="flex h-[42px] shrink-0 items-center border-b border-border px-1">
              {!sidebarCollapsed && (
                <span className="flex-1 px-2 text-xs font-medium text-muted-foreground">
                  Team
                </span>
              )}
              <button
                type="button"
                onClick={() => setSidebarCollapsed((value) => !value)}
                className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              >
                {sidebarCollapsed ? (
                  <PanelLeftOpen className="size-4" />
                ) : (
                  <PanelLeftClose className="size-4" />
                )}
              </button>
            </div>
            <nav className="min-h-0 flex-1 overflow-y-auto py-1" aria-label="Team sections">
              {SECTION_ITEMS.map((section, index) => (
                <div key={section.id}>
                  {section.id === "aoa" && index > 0 && (
                    <div
                      className={cn("my-2 border-t border-border", sidebarCollapsed && "mx-auto w-5")}
                      aria-hidden
                    />
                  )}
                  <button
                    type="button"
                    aria-label={sidebarCollapsed ? section.label : undefined}
                    aria-current={activeSection === section.id ? "page" : undefined}
                    title={sidebarCollapsed ? section.label : undefined}
                    onClick={() => setTeamSection(section.id)}
                    className={cn(
                      "relative flex min-h-8 w-full items-center gap-2 text-left text-[12.5px] transition-colors",
                      "text-foreground/85 hover:bg-accent hover:text-accent-foreground",
                      activeSection === section.id && "bg-accent text-accent-foreground",
                      sidebarCollapsed ? "justify-center px-0 py-1.5" : "px-3 py-1.5",
                    )}
                  >
                    <section.icon className="size-4 shrink-0" aria-hidden />
                    {!sidebarCollapsed && (
                      <span className="min-w-0 flex-1 truncate">{section.label}</span>
                    )}
                    {activeSection === section.id && !sidebarCollapsed && (
                      <span
                        className="absolute left-0 top-1.5 h-5 w-0.5 rounded-full bg-brand"
                        aria-hidden
                      />
                    )}
                  </button>
                </div>
              ))}
            </nav>
          </aside>

          <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-sm">
            <header className="flex h-[42px] shrink-0 items-center gap-3 border-b border-border px-4">
              <span className="shrink-0 text-sm font-semibold text-foreground">
                {SECTION_LABELS[activeSection]}
              </span>
              {activeSection === "aoa" && (
                <div
                  className="ml-auto flex h-full min-w-0 items-center overflow-x-auto"
                  data-testid="aoa-team-header-tabs"
                >
                  {AOA_TEAM_SUB_TABS.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setAoaSubTab(tab.id)}
                      data-testid={`aoa-header-subtab-${tab.id}`}
                      data-active={activeAoaSubTab === tab.id ? "true" : undefined}
                      className={cn(
                        "flex h-full items-center border-b-2 px-3 text-xs font-medium transition-colors",
                        activeAoaSubTab === tab.id
                          ? "border-brand text-foreground"
                          : "border-transparent text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              )}
            </header>
            <div className="flex-1 overflow-y-auto">
              {isLoading && <PageSkeleton variant={activeSection === "org" ? "org-chart" : "list"} />}

              {!isLoading && activeSection === "org" && (
                <OrgTreeTab
                  orgTree={orgTreeQuery.data ?? []}
                  pendingInvites={teamSummary?.pendingInvites}
                  onNodeClick={handleNodeClick}
                  onNodeAction={handleNodeAction}
                />
              )}

              {!isLoading && activeSection === "agents" && (
                <AgentsTab
                  agents={agentsQuery.data ?? []}
                  orgTree={orgTreeQuery.data ?? []}
                  highlightId={highlightId}
                  permissions={{ isFounder: role === "founder" }}
                  onMutationSuccess={invalidateAll}
                />
              )}

              {!isLoading && activeSection === "humans" && teamSummary && (
                <HumansTab
                  teamSummary={teamSummary}
                  highlightId={highlightId}
                  permissions={permissions}
                  isSystemAdmin={teamSummary.currentUser?.isSystemAdmin ?? false}
                  onMutationSuccess={invalidateAll}
                />
              )}

              {!isLoading && activeSection === "teams" && <TeamsListPage />}

              {!isLoading && activeSection === "aoa" && (
                <CommanderTeamTab
                  agents={commanderAgentsQuery.data ?? []}
                  trustScores={commanderTrustQuery.data ?? []}
                  liveRuns={commanderLiveRunsQuery.data ?? []}
                  permissions={{ isFounder: role === "founder" }}
                  onMutationSuccess={invalidateAll}
                  activeSubTab={activeAoaSubTab}
                  onSubTabChange={setAoaSubTab}
                  showSubTabs={false}
                  tasksContent={
                    <TasksTab
                      companyId={selectedCompanyId}
                      crewAgents={commanderAgentsQuery.data ?? agentsQuery.data ?? []}
                    />
                  }
                />
              )}
            </div>
          </section>
        </div>
      </div>
    </TooltipProvider>
  );
}
