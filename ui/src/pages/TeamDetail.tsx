import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Star, MoreHorizontal, Trash2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs } from "@/components/ui/tabs";
import { PageHeader } from "../components/PageHeader";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { teamsApi, type Team, type TeamMember } from "../api/teams";
import { marketplaceApi, type TeamUninstallResult } from "../api/marketplace";
import { CrewUninstallResultDialog } from "../components/team/CrewUninstallResultDialog";
import { projectsApi } from "../api/projects";
import { agentsApi } from "../api/agents";
import type { Agent } from "@armyofagents/shared";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { PageSkeleton } from "../components/PageSkeleton";
import { EmptyState } from "../components/EmptyState";
import { PageTabBar } from "../components/PageTabBar";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { CoordinationEditor } from "../components/team/CoordinationEditor";
import { ManifestEditor } from "../components/team/ManifestEditor";
import { TeamAgentSlideOver } from "../components/team/TeamAgentSlideOver";

const VALID_TABS = ["overview", "coordination", "manifest", "activity"] as const;
type TeamDetailTab = (typeof VALID_TABS)[number];

function isValidTab(value: string | null): value is TeamDetailTab {
  return VALID_TABS.includes(value as TeamDetailTab);
}

const TAB_ITEMS = [
  { value: "overview", label: "Overview" },
  { value: "coordination", label: "Coordination" },
  { value: "manifest", label: "Manifest" },
  { value: "activity", label: "Activity" },
];

export function TeamDetail() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get("tab");
  const activeTab: TeamDetailTab = isValidTab(rawTab) ? rawTab : "overview";
  const [dismantleConfirmOpen, setDismantleConfirmOpen] = useState(false);
  const [uninstallConfirmOpen, setUninstallConfirmOpen] = useState(false);
  const [uninstallResult, setUninstallResult] = useState<TeamUninstallResult | null>(null);

  // Fetch teams list and find by slug.
  // Backend doesn't expose getBySlug; we filter client-side. Acceptable v1.
  const teamQuery = useQuery({
    queryKey:
      selectedCompanyId && slug
        ? queryKeys.teams.detailBySlug(selectedCompanyId, slug)
        : ["team", "by-slug", "none"],
    queryFn: async () => {
      const list = await teamsApi.list(selectedCompanyId!);
      const team = list.items.find((t) => t.slug === slug);
      if (!team) throw new Error(`Team ${slug} not found`);
      return team;
    },
    enabled: Boolean(selectedCompanyId && slug),
  });

  const membersQuery = useQuery({
    queryKey:
      teamQuery.data && selectedCompanyId
        ? queryKeys.teams.members(selectedCompanyId, teamQuery.data.id)
        : ["members", "none"],
    queryFn: () => teamsApi.listMembers(teamQuery.data!.id),
    enabled: Boolean(teamQuery.data && selectedCompanyId),
  });

  // Look up the parent project (department) name to display the dept badge.
  const projectsQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.projects.list(selectedCompanyId)
      : ["projects", "none"],
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  // Resolve agent IDs in the member list to their human-readable names.
  // Company-wide list (rather than dept-scoped) keeps a single shared cache
  // that the rest of the app already populates — and the count is small
  // enough that the cost of fetching dept-scoped vs company-wide is a wash.
  const agentsQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.agents.list(selectedCompanyId)
      : ["agents", "none"],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const agentMap = useMemo(() => {
    const m = new Map<string, Agent>();
    for (const a of agentsQuery.data ?? []) m.set(a.id, a);
    return m;
  }, [agentsQuery.data]);

  // A company-wide team (D21) has `parentProjectId === null`, which no project
  // row can match, so this already yields null and every consumer below already
  // handles null. That is correct BY ACCIDENT, not by design — don't "fix" the
  // find() into a non-null assertion.
  const parentProjectName = useMemo(() => {
    if (!teamQuery.data || !projectsQuery.data) return null;
    return (
      projectsQuery.data.find((p) => p.id === teamQuery.data!.parentProjectId)
        ?.name ?? null
    );
  }, [teamQuery.data, projectsQuery.data]);

  useEffect(() => {
    if (teamQuery.data) {
      setBreadcrumbs([
        { label: "Team", href: "/team" },
        { label: teamQuery.data.name },
      ]);
    }
  }, [teamQuery.data, setBreadcrumbs]);

  const handleTabChange = (next: string) => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("tab", next);
    setSearchParams(nextParams);
  };

  // Hard-delete the team. Schema cascades remove team_members +
  // team_coordinations rows; agents survive. The dropdown item below is
  // disabled until `team` is loaded, so the non-null assertion in mutationFn
  // is safe (mutate() only fires after the user clicks).
  const dismantleMut = useMutation({
    mutationFn: () => teamsApi.dismantle(teamQuery.data!.id),
    onSuccess: () => {
      pushToast({
        title: "Team dismantled",
        body: teamQuery.data?.name,
        tone: "success",
      });
      if (selectedCompanyId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.teams.list(selectedCompanyId),
        });
      }
      navigate("/team");
    },
    onError: (err) => {
      pushToast({
        title: "Dismantle failed",
        body: (err as Error).message,
        tone: "error",
      });
    },
  });

  // Marketplace uninstall (crew only). Unlike dismantle, this DESTROYS the
  // team's member agents — except protected ones (Commander, Steward), which are
  // detached and kept. The result surfaces those retained agents so the founder
  // sees which survived and why (task #33). Navigation happens only when the
  // result dialog is dismissed, so the retained list isn't lost to an unmount.
  const uninstallMut = useMutation({
    mutationFn: () => marketplaceApi.uninstallTeam(selectedCompanyId!, teamQuery.data!.id),
    onSuccess: (result) => {
      setUninstallConfirmOpen(false);
      setUninstallResult(result);
      if (selectedCompanyId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.teams.list(selectedCompanyId),
        });
      }
    },
    onError: (err) => {
      pushToast({
        title: "Uninstall failed",
        body: (err as Error).message,
        tone: "error",
      });
    },
  });

  if (teamQuery.isLoading) return <PageSkeleton variant="detail" />;
  if (teamQuery.isError)
    return <EmptyState icon={Users} message="Team not found." />;
  if (!teamQuery.data) return null;

  const team = teamQuery.data;
  const members = membersQuery.data?.items ?? [];
  const lead = members.find((m) => m.role === "lead");

  function handleExport() {
    // Top-level navigation triggers the browser's native download flow.
    // The auth cookie is included automatically; the server's
    // Content-Disposition: attachment header makes the browser save the file.
    // Server route is `GET /teams/:id/export` (no `/companies/:companyId` prefix
    // because the team UUID is globally unique across companies).
    window.location.href = `/api/teams/${team.id}/export`;
  }

  function handleDismantle() {
    setDismantleConfirmOpen(true);
  }

  const leadName = lead ? (agentMap.get(lead.agentId)?.name ?? "Unknown agent") : "No lead";

  return (
    <>
      <PageHeader
        breadcrumb={parentProjectName ?? "Team"}
        title={team.name}
        subtitle={
          <span className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1">
              <Star className="h-3 w-3 text-amber-500" aria-hidden="true" />
              {leadName}
            </span>
            <span className="opacity-40">·</span>
            <span>{members.length} member{members.length === 1 ? "" : "s"}</span>
            <Badge variant="outline" className="text-[10px] capitalize">{team.status}</Badge>
          </span>
        }
        primaryAction={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="outline" aria-label="More options">
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={handleExport}>
                <Download className="mr-2 h-3.5 w-3.5" />
                Export as .team.yaml
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={handleDismantle}
                className="text-destructive"
                disabled={dismantleMut.isPending}
              >
                <Trash2 className="mr-2 h-3.5 w-3.5" />
                {dismantleMut.isPending ? "Dismantling..." : "Dismantle team"}
              </DropdownMenuItem>
              {team.templateOrigin && (
                <DropdownMenuItem
                  onClick={() => setUninstallConfirmOpen(true)}
                  className="text-destructive"
                  disabled={uninstallMut.isPending}
                >
                  <Trash2 className="mr-2 h-3.5 w-3.5" />
                  {uninstallMut.isPending ? "Uninstalling..." : "Uninstall crew"}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />

      <div className="p-5">
        <Tabs value={activeTab} onValueChange={handleTabChange}>
          <PageTabBar
            items={TAB_ITEMS}
            value={activeTab}
            onValueChange={handleTabChange}
          />

          <div className="mt-4">
            {activeTab === "overview" && (
              <OverviewTab team={team} members={members} agentMap={agentMap} />
            )}
            {activeTab === "coordination" && (
              <CoordinationEditor teamId={team.id} teamName={team.name} />
            )}
            {activeTab === "manifest" && (
              <ManifestEditor teamId={team.id} initialManifest={team.manifest} />
            )}
            {activeTab === "activity" && (
              <p className="text-sm text-muted-foreground">Activity tab — future slice.</p>
            )}
          </div>
        </Tabs>
      </div>

      <ConfirmDialog
        open={dismantleConfirmOpen}
        onOpenChange={setDismantleConfirmOpen}
        title={`Dismantle "${team.name}"?`}
        description={`This deletes the team and its coordination but keeps the ${members.length} agent${members.length === 1 ? "" : "s"} in their department. This cannot be undone.`}
        confirmLabel="Dismantle"
        destructive
        onConfirm={() => dismantleMut.mutate()}
        disabled={dismantleMut.isPending}
      />

      <ConfirmDialog
        open={uninstallConfirmOpen}
        onOpenChange={setUninstallConfirmOpen}
        title={`Uninstall "${team.name}"?`}
        description="This permanently deletes the crew's agents and removes the team. Protected agents (Commander, Steward) are kept and detached. This cannot be undone."
        confirmLabel="Uninstall"
        destructive
        onConfirm={() => uninstallMut.mutate()}
        disabled={uninstallMut.isPending}
      />

      <CrewUninstallResultDialog
        result={uninstallResult}
        open={uninstallResult !== null}
        onClose={() => {
          setUninstallResult(null);
          navigate("/team");
        }}
      />
    </>
  );
}

interface OverviewProps {
  team: Team;
  members: TeamMember[];
  agentMap: Map<string, Agent>;
}

function OverviewTab({ team, members, agentMap }: OverviewProps) {
  const [slideOverAgentId, setSlideOverAgentId] = useState<string | null>(null);
  const selectedAgent = slideOverAgentId ? (agentMap.get(slideOverAgentId) ?? null) : null;
  const selectedMember = slideOverAgentId ? (members.find((m) => m.agentId === slideOverAgentId) ?? null) : null;

  return (
    <div className="grid grid-cols-3 gap-4">
      <section className="col-span-2 rounded-lg border bg-card p-4">
        <h2 className="mb-3 text-sm font-bold">Members ({members.length})</h2>
        {members.length === 0 ? (
          <p className="text-xs text-muted-foreground">No members yet.</p>
        ) : (
          members.map((m) => {
            const agent = agentMap.get(m.agentId);
            const displayName = agent?.name ?? "Unknown agent";
            const avatarLetter = agent?.name?.charAt(0).toUpperCase() ?? "?";
            return (
              <button
                key={m.id}
                type="button"
                className={`mb-2 flex w-full items-center gap-3 rounded-md p-2.5 text-left transition-colors hover:bg-accent/60 ${
                  m.role === "lead"
                    ? "border-l-[3px] border-l-indigo-500 bg-indigo-50/30 dark:bg-indigo-950/10"
                    : "bg-muted/30"
                }`}
                onClick={() => setSlideOverAgentId(m.agentId)}
              >
                <div className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-sm">
                  <span aria-hidden="true">{avatarLetter}</span>
                </div>
                <div className="flex-1">
                  <span className="text-xs font-bold">{displayName}</span>
                  {m.role === "lead" && (
                    <span className="ml-2 inline-flex items-center gap-1 text-[9px] font-bold text-indigo-600">
                      <Star className="h-2.5 w-2.5" aria-hidden="true" />
                      LEAD
                    </span>
                  )}
                </div>
              </button>
            );
          })
        )}
      </section>

      <aside className="space-y-3">
        <div className="rounded-lg border bg-card p-3">
          <h3 className="mb-1 text-xs font-bold">Coordination</h3>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Auto-generated contract describing how this team handles work and routes between members.
          </p>
        </div>
        <div className="rounded-lg border bg-card p-3">
          <h3 className="mb-2 text-xs font-bold">Quick stats</h3>
          <div className="space-y-1 text-[11px] text-muted-foreground">
            <div>{members.length} agents</div>
            <div>0 active tasks</div>
            <div>0 runs today</div>
            <div>$0.00 spent</div>
          </div>
        </div>
      </aside>

      <TeamAgentSlideOver
        open={Boolean(slideOverAgentId)}
        onOpenChange={(open) => { if (!open) setSlideOverAgentId(null); }}
        agent={selectedAgent}
        teamId={team.id}
        teamMember={selectedMember}
      />
    </div>
  );
}
