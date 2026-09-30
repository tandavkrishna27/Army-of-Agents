import { lazy, Suspense, useEffect, useRef } from "react";
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Layout } from "./components/Layout";
import { authApi } from "./api/auth";
import { healthApi } from "./api/health";
import { fetchJourney } from "./api/onboarding";
import { writePendingTenant } from "./onboarding/pendingTenant";
import { Dashboard } from "./pages/Dashboard";
import { Lobby } from "./pages/Lobby";
import { LobbyLayout } from "./components/LobbyLayout";
import { InstanceSettingsPage } from "./pages/InstanceSettingsPage";
import { InstanceAccessPage } from "./pages/InstanceAccessPage";
import { Companies } from "./pages/Companies";
import { Agents } from "./pages/Agents";
import { Projects } from "./pages/Projects";
import { Goals } from "./pages/Goals";
import { GoalDetail } from "./pages/GoalDetail";
import { Approvals } from "./pages/Approvals";
import { ApprovalDetail } from "./pages/ApprovalDetail";
import { InboxHub } from "./pages/InboxHub";
import { SettingsPage } from "./pages/SettingsPage";
import { VisionMission } from "./pages/VisionMission";
import { Objectives } from "./pages/Objectives";
import { Commander } from "./pages/Commander";
import { TeamPage } from "./pages/TeamPage";
import { TeamDetail } from "./pages/TeamDetail";
import { HumanDetail } from "./pages/HumanDetail";
import { ActiveAgents } from "./pages/ActiveAgents";
import { DiscussionCaptureModal } from "./components/DiscussionCaptureModal";
import { NewThreadDialog } from "./components/NewThreadDialog";
import { MemoryQuickSwitcher } from "./components/memory/MemoryQuickSwitcher";
import { Discussions } from "./pages/Discussions";
import { ThreadsWorkspace } from "./pages/ThreadsWorkspace";
import { WorkspacesList } from "./pages/WorkspacesList";
import { AuthPage } from "./pages/Auth";
import { OnboardingFlowPage } from "./pages/OnboardingFlow";
import { Me } from "./pages/Me";
import { CompanyExport } from "./pages/CompanyExport";
import { CompanyImport } from "./pages/CompanyImport";
import { BoardClaimPage } from "./pages/BoardClaim";
import { CliAuthPage } from "./pages/CliAuth";
import { InviteLandingPage } from "./pages/InviteLanding";
import { PluginPage } from "./pages/PluginPage";
import { PluginSettings } from "./pages/PluginSettings";
import Marketplace from "./pages/Marketplace";
import { Navigate as RawNavigate, useParams as useRawParams } from "react-router-dom";
import MarketplaceDetail from "./pages/MarketplaceDetail";
import MarketplaceSearch from "./pages/MarketplaceSearch";
import MarketplaceUpdates from "./pages/MarketplaceUpdates";
import MarketplacePackageDetail from "./pages/MarketplacePackageDetail";
import MarketplaceConnectors from "./pages/MarketplaceConnectors";
import { DefaultCrewRosterRedirect } from "./components/marketplace/DefaultCrewRosterRedirect";
import { queryKeys } from "./lib/queryKeys";
import { useCompany } from "./context/CompanyContext";
import { useDialog } from "./context/DialogContext";
import { requiresBoardSession } from "./lib/authGate";
import {
  AOA_DEFAULT_CREW_MARKETPLACE_ROUTE,
  MARKETPLACE_TEAM_DETAIL_ROUTE,
} from "./lib/marketplace-constants";

const AgentDetail = lazy(() => import("./pages/AgentDetail").then((m) => ({ default: m.AgentDetail })));
const AoaAgentDetail = lazy(() => import("./pages/AoaAgentDetail").then((m) => ({ default: m.AoaAgentDetail })));
const DesignGuide = lazy(() => import("./pages/DesignGuide").then((m) => ({ default: m.DesignGuide })));
const Issues = lazy(() => import("./pages/Issues").then((m) => ({ default: m.Issues })));
const Memory = lazy(() => import("./pages/Memory").then((m) => ({ default: m.Memory })));
const MemoryExplorer = lazy(() => import("./pages/MemoryExplorer").then((m) => ({ default: m.MemoryExplorer })));
const ProjectDetail = lazy(() => import("./pages/ProjectDetail").then((m) => ({ default: m.ProjectDetail })));
const RoutineDetail = lazy(() => import("./pages/RoutineDetail").then((m) => ({ default: m.RoutineDetail })));
const Routines = lazy(() => import("./pages/Routines").then((m) => ({ default: m.Routines })));
const Skills = lazy(() => import("./pages/Skills").then((m) => ({ default: m.Skills })));
const WorkspaceView = lazy(() => import("./pages/WorkspaceView").then((m) => ({ default: m.WorkspaceView })));

function RouteFallback() {
  return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Loading...</div>;
}

function CloudAccessGate() {
  const location = useLocation();
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });

  const requiresSession = requiresBoardSession(healthQuery.data);
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: requiresSession,
    retry: false,
  });

  if (healthQuery.isLoading || (requiresSession && sessionQuery.isLoading)) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Loading...</div>;
  }

  if (healthQuery.error) {
    return (
      <div className="mx-auto max-w-xl py-10 text-sm text-destructive">
        {healthQuery.error instanceof Error ? healthQuery.error.message : "Failed to load app state"}
      </div>
    );
  }

  // A fresh instance with no admin is NOT a dead end anymore: the first Google
  // user to sign in becomes the instance admin (RB3). So a session-less user —
  // including on a brand-new instance (bootstrapStatus "bootstrap_pending") — is
  // sent to the Google login rather than the retired CLI-bootstrap page.
  if (requiresSession && !sessionQuery.data) {
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`/auth?next=${next}`} replace />;
  }

  return <Outlet />;
}

function boardRoutes() {
  return (
    <>
      <Route index element={<Navigate to="home" replace />} />
      <Route path="home" element={<Dashboard />} />
      <Route path="companies" element={<Companies />} />
      <Route path="vision" element={<VisionMission />} />
      <Route path="objectives" element={<Objectives />} />
      <Route path="commander" element={<Commander />} />
      <Route path="settings" element={<SettingsPage />} />
      <Route path="secrets" element={<Navigate to="../settings?tab=secrets" replace />} />
      <Route path="settings/commander" element={<Navigate to="../settings?tab=commander" replace />} />
      <Route path="settings/internal-agent" element={<Navigate to="../settings?tab=commander" replace />} />
      <Route path="company/settings" element={<Navigate to="../settings" replace />} />
      <Route path="team" element={<TeamPage />} />
      <Route path="org" element={<Navigate to="../team" replace />} />
      <Route path="team/teams/:slug" element={<TeamDetail />} />
      <Route path="team/aoa/:agentId" element={<AoaAgentDetail />} />
      <Route path="team/aoa/:agentId/:tab" element={<AoaAgentDetail />} />
      <Route path="team/:userId" element={<HumanDetail />} />
      <Route path="team/:userId/:tab" element={<HumanDetail />} />
      <Route path="agents" element={<Navigate to="/agents/all" replace />} />
      <Route path="agents/all" element={<Agents />} />
      <Route path="agents/active" element={<Agents />} />
      <Route path="agents/paused" element={<Agents />} />
      <Route path="agents/error" element={<Agents />} />
      <Route path="agents/:agentId" element={<AgentDetail />} />
      <Route path="agents/:agentId/:tab" element={<AgentDetail />} />
      <Route path="agents/:agentId/runs/:runId" element={<AgentDetail />} />
      <Route path="projects" element={<Projects />} />
      <Route path="projects/:projectId" element={<ProjectDetail />} />
      <Route path="projects/:projectId/overview" element={<ProjectDetail />} />
      <Route path="projects/:projectId/goals" element={<ProjectDetail />} />
      <Route path="projects/:projectId/issues" element={<ProjectDetail />} />
      <Route path="projects/:projectId/issues/:filter" element={<ProjectDetail />} />
      <Route path="projects/:projectId/team" element={<ProjectDetail />} />
      <Route path="projects/:projectId/budget" element={<ProjectDetail />} />
      <Route path="projects/:projectId/discussions" element={<ProjectDetail />} />
      <Route path="projects/:projectId/workspaces" element={<ProjectDetail />} />
      <Route path="projects/:projectId/settings" element={<ProjectDetail />} />
      <Route path="issues" element={<Issues />} />
      <Route path="issues/all" element={<Navigate to="/issues" replace />} />
      <Route path="issues/active" element={<Navigate to="/issues" replace />} />
      <Route path="issues/backlog" element={<Navigate to="/issues" replace />} />
      <Route path="issues/done" element={<Navigate to="/issues" replace />} />
      <Route path="issues/recent" element={<Navigate to="/issues" replace />} />
      <Route path="issues/:issueId" element={<Issues />} />
      <Route path="goals" element={<Navigate to="../objectives?tab=goals" replace />} />
      <Route path="goals/:goalId" element={<GoalDetail />} />
      <Route path="skills/*" element={<Skills />} />
      <Route path="routines" element={<Routines />} />
      <Route path="routines/:routineId" element={<RoutineDetail />} />
      {/* Discussions continuum: Home/board/list index and selected-thread detail share one surface. */}
      <Route path="discussions" element={<ThreadsWorkspace />} />
      <Route path="discussions/legacy" element={<Discussions />} />
      {/* Codex #1: individual items use ThreadDetail (Plan 4). */}
      <Route path="discussions/:discussionId" element={<ThreadsWorkspace />} />
      {/* Canonical thread route — same ThreadDetail component, different param name */}
      <Route path="threads/:threadId" element={<ThreadsWorkspace />} />
      <Route path="briefs" element={<Navigate to="/discussions" replace />} />
      <Route path="briefs/:briefId" element={<Navigate to="/discussions" replace />} />
      <Route path="debriefs" element={<Navigate to="/discussions" replace />} />
      <Route path="active-agents" element={<ActiveAgents />} />
      {/* Phase 6.2a: explorer is the only memory page; home content lives in its center pane when no scope is selected. /memory redirects in. */}
      <Route path="memory" element={<Navigate to="explore" replace />} />
      <Route path="memory/explore" element={<MemoryExplorer />} />
      <Route path="memory/legacy" element={<Memory />} />
      <Route path="approvals" element={<Navigate to="/approvals/pending" replace />} />
      <Route path="approvals/pending" element={<Approvals />} />
      <Route path="approvals/all" element={<Approvals />} />
      <Route path="approvals/:approvalId" element={<ApprovalDetail />} />
      <Route path="budget" element={<Navigate to="../settings?tab=budget" replace />} />
      <Route path="costs" element={<Navigate to="../settings?tab=budget" replace />} />
      <Route path="activity" element={<Navigate to="../settings?tab=activity" replace />} />
      <Route path="inbox" element={<InboxHub />} />
      <Route path="inbox/new" element={<InboxHub />} />
      <Route path="inbox/all" element={<InboxHub />} />
      <Route path="inbox/:lane" element={<InboxHub />} />
      <Route path="inbox/:lane/:itemId" element={<InboxHub />} />
      <Route path="inbox-hub" element={<InboxHub />} />
      <Route path="inbox-hub/:lane" element={<InboxHub />} />
      <Route path="inbox-hub/:lane/:itemId" element={<InboxHub />} />
      <Route path="design-guide" element={<DesignGuide />} />
      <Route path="workspaces" element={<WorkspacesList />} />
      <Route path="workspaces/:workspaceId" element={<WorkspaceView />} />
      <Route path="plugins/:pluginId" element={<PluginPage />} />
      <Route path="marketplace-updates" element={<MarketplaceUpdates />} />
    </>
  );
}

function CompanyRootRedirect() {
  const { companies, selectedCompany, loading } = useCompany();

  if (loading) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Loading...</div>;
  }

  const targetCompany = selectedCompany ?? companies[0] ?? null;
  if (!targetCompany) {
    return <NoCompaniesStartPage />;
  }

  return <Navigate to={`/${targetCompany.issuePrefix}/home`} replace />;
}

function UnprefixedBoardRedirect() {
  const location = useLocation();
  const { companies, selectedCompany, loading } = useCompany();

  if (loading) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Loading...</div>;
  }

  const targetCompany = selectedCompany ?? companies[0] ?? null;
  if (!targetCompany) {
    return <NoCompaniesStartPage />;
  }

  return (
    <Navigate
      to={`/${targetCompany.issuePrefix}${location.pathname}${location.search}${location.hash}`}
      replace
    />
  );
}

function NoCompaniesStartPage({ autoOpen = true }: { autoOpen?: boolean }) {
  const navigate = useNavigate();
  const opened = useRef(false);

  // Onboarding is the FlowEngine at /onboarding (C13) — route there instead of
  // opening a modal.
  useEffect(() => {
    if (!autoOpen) return;
    if (opened.current) return;
    opened.current = true;
    navigate("/onboarding");
  }, [autoOpen, navigate]);

  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold">Create your first company</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Get started by creating a company.
        </p>
        <div className="mt-4">
          <Button onClick={() => navigate("/onboarding")}>New Company</Button>
        </div>
      </div>
    </div>
  );
}

/** Redirect /marketplace/:type → /marketplace?type={type} without company-prefix logic. */
function MarketplaceTypeRedirect() {
  const { type } = useRawParams<{ type: string }>();
  return <RawNavigate to={`/marketplace${type ? `?type=${type}` : ""}`} replace />;
}

/** Self-consuming mount shim — mirrors the DiscussionCaptureModal pattern */
function NewThreadDialogMount() {
  const { newThreadOpen, newThreadDefaults, closeNewThread } = useDialog();
  return (
    <NewThreadDialog
      open={newThreadOpen}
      onClose={closeNewThread}
      defaults={newThreadDefaults}
    />
  );
}

// The index gate (Stage B / B7). Fetches the post-auth journey and redirects a
// founder to /onboarding, an invited user to /onboarding/join; a returning user
// sees the Lobby (with their pending invitations surfaced there).
function LobbyOrOnboardingRedirect() {
  const navigate = useNavigate();
  const { setSelectedCompanyId } = useCompany();
  const { data, isLoading } = useQuery({
    queryKey: ["onboarding", "journey"],
    queryFn: () => fetchJourney(),
    retry: false,
  });
  // Only needed to key the pending-tenant recovery hint for the strand-resume
  // branch below; deduped against CloudAccessGate's own session query, so this is
  // effectively free (returns the warm cache).
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  useEffect(() => {
    if (!data) return;
    if (data.journey === "founder") {
      navigate("/onboarding", { replace: true });
    } else if (data.journey === "invited") {
      navigate(`/onboarding/join?company=${data.targetCompanyId ?? ""}`, { replace: true });
    } else if (data.resumeFirstRunCompanyId) {
      // Returning founder who abandoned their first-run tail: select that company
      // and drop them back into /onboarding to finish it. The spine is already
      // complete, so OnboardingFlow's FlowEngine resolves no step and jumps
      // straight to the inline tail — onboarding never appears on the dashboard.
      setSelectedCompanyId(data.resumeFirstRunCompanyId);
      navigate("/onboarding", { replace: true });
    } else if (data.resumeCompanyCreationOrgId) {
      // Empty-Lobby strand (Fix 3b): a founder who created their org but never a
      // company. Wait for the session so we can key the hint (the effect re-runs
      // when it loads); seed the tenant recovery hint (mirrors the org step's own
      // localStorage durability) so CreateOrganizationStep ADOPTS this org instead
      // of minting a ghost, then resume into /onboarding at the company step.
      if (!session?.user?.id) return;
      writePendingTenant(session.user.id, { id: data.resumeCompanyCreationOrgId, name: "" });
      navigate("/onboarding", { replace: true });
    }
  }, [data, navigate, setSelectedCompanyId, session]);
  if (isLoading) return <RouteFallback />;
  // Redirecting (founder / invited) OR resuming an unfinished founder tail OR the
  // empty-Lobby strand — render nothing so the Lobby doesn't flash underneath
  // before the redirect.
  if (
    data &&
    (data.journey !== "returning" ||
      data.resumeFirstRunCompanyId ||
      data.resumeCompanyCreationOrgId)
  )
    return null;
  return <Lobby pendingInvitations={data?.pendingInvitations ?? []} />;
}

export function App() {
  return (
    <>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="auth" element={<AuthPage />} />
          <Route path="board-claim/:token" element={<BoardClaimPage />} />
          <Route path="cli-auth/:id" element={<CliAuthPage />} />
          <Route path="invite/:token" element={<InviteLandingPage />} />

          <Route element={<CloudAccessGate />}>
            {/* Persistent lobby shell — sidebar mounts once, content swaps via <Outlet/> */}
            <Route element={<LobbyLayout />}>
              <Route index element={<LobbyOrOnboardingRedirect />} />
              <Route path="instance/settings" element={<InstanceSettingsPage />} />
              <Route path="instance/access" element={<InstanceAccessPage />} />
              <Route path="marketplace" element={<Marketplace />} />
              <Route path="marketplace/search" element={<MarketplaceSearch />} />
              {/* Static segment — outranks `marketplace/:type` (which would
                  otherwise bounce it to `?type=connectors`, a type the catalog
                  does not and must not have). */}
              <Route path="marketplace/connectors" element={<MarketplaceConnectors />} />
              <Route path="marketplace/package/:id/*" element={<MarketplacePackageDetail />} />
              <Route path="marketplace/:type" element={<MarketplaceTypeRedirect />} />
              <Route
                path={AOA_DEFAULT_CREW_MARKETPLACE_ROUTE}
                element={<DefaultCrewRosterRedirect />}
              />
              <Route
                path={MARKETPLACE_TEAM_DETAIL_ROUTE}
                element={<MarketplaceDetail fixedType="team" />}
              />
              <Route path="marketplace/:type/:slug/*" element={<MarketplaceDetail />} />
            </Route>
            <Route path="me" element={<Me />} />
            <Route path="onboarding" element={<OnboardingFlowPage journey="founder" />} />
            <Route path="onboarding/join" element={<OnboardingFlowPage journey="invited" />} />
            <Route path="export" element={<Layout />}>
              <Route index element={<CompanyExport />} />
            </Route>
            <Route path="import" element={<Layout />}>
              <Route index element={<CompanyImport />} />
            </Route>
            <Route path="instance/settings/plugins/:pluginId" element={<PluginSettings />} />
            <Route path="companies" element={<UnprefixedBoardRedirect />} />
            <Route path="issues" element={<UnprefixedBoardRedirect />} />
            <Route path="issues/:issueId" element={<UnprefixedBoardRedirect />} />
            <Route path="agents" element={<UnprefixedBoardRedirect />} />
            <Route path="agents/:agentId" element={<UnprefixedBoardRedirect />} />
            <Route path="agents/:agentId/:tab" element={<UnprefixedBoardRedirect />} />
            <Route path="agents/:agentId/runs/:runId" element={<UnprefixedBoardRedirect />} />
            <Route path="discussions" element={<UnprefixedBoardRedirect />} />
            <Route path="discussions/:discussionId" element={<UnprefixedBoardRedirect />} />
            <Route path="briefs" element={<Navigate to="/discussions" replace />} />
            <Route path="briefs/*" element={<Navigate to="/discussions" replace />} />
            <Route path="vision" element={<UnprefixedBoardRedirect />} />
            <Route path="objectives" element={<UnprefixedBoardRedirect />} />
            <Route path="commander" element={<UnprefixedBoardRedirect />} />
            <Route path="memory" element={<UnprefixedBoardRedirect />} />
            <Route path="budget" element={<UnprefixedBoardRedirect />} />
            <Route path="settings" element={<UnprefixedBoardRedirect />} />
            <Route path="secrets" element={<UnprefixedBoardRedirect />} />
            <Route path="projects" element={<UnprefixedBoardRedirect />} />
            <Route path="projects/:projectId" element={<UnprefixedBoardRedirect />} />
            <Route path="team/teams/:slug" element={<UnprefixedBoardRedirect />} />
            <Route path="projects/:projectId/overview" element={<UnprefixedBoardRedirect />} />
            <Route path="projects/:projectId/issues" element={<UnprefixedBoardRedirect />} />
            <Route path="projects/:projectId/issues/:filter" element={<UnprefixedBoardRedirect />} />
            <Route path="projects/:projectId/goals" element={<UnprefixedBoardRedirect />} />
            <Route path="projects/:projectId/team" element={<UnprefixedBoardRedirect />} />
            <Route path="projects/:projectId/budget" element={<UnprefixedBoardRedirect />} />
            <Route path="projects/:projectId/settings" element={<UnprefixedBoardRedirect />} />
            <Route path="skills/*" element={<UnprefixedBoardRedirect />} />
            <Route path="workspaces" element={<UnprefixedBoardRedirect />} />
            <Route path=":companyPrefix" element={<Layout />}>
              {boardRoutes()}
            </Route>
          </Route>
        </Routes>
      </Suspense>
      <DiscussionCaptureModal />
      <NewThreadDialogMount />
      <MemoryQuickSwitcher />
    </>
  );
}
