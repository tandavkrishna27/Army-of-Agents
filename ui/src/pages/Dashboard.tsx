import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { useHomeSummary } from "../hooks/useHomeSummary";
import { authApi } from "../api/auth";
import { suggestionsApi } from "../api/suggestions";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useTeamAccess } from "../hooks/useTeamAccess";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { HomeBoard } from "../components/home/HomeBoard";
import { HomeBoardControls } from "../components/home/HomeBoardControls";
import { NewMenu } from "../components/home/NewMenu";
import { useBoardEdit } from "../components/home/useBoardEdit";
import { buildActionGroups } from "../components/home/actionQueue";
import { Home } from "lucide-react";

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

// Plan 7 Task 2: a small muted date line under the greeting, e.g.
// "Wednesday, 30 July 2026". `new Date()` in a component is fine — app code,
// not a workflow script.
function getDateLine(): string {
  return new Date().toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export function Dashboard() {
  const { selectedCompanyId, companies } = useCompany();
  const navigate = useNavigate();
  const { setBreadcrumbs } = useBreadcrumbs();

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Home" }]);
  }, [setBreadcrumbs]);

  // Shared with Layout's WS9 first-run full-bleed check via the same
  // `queryKeys.home(companyId)` entry (see useHomeSummary).
  const { data, isLoading, error } = useHomeSummary(selectedCompanyId);

  const { data: suggestions = [] } = useQuery({
    queryKey: queryKeys.suggestions.pending(selectedCompanyId!),
    queryFn: () => suggestionsApi.pending(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { role: teamRole } = useTeamAccess(selectedCompanyId);

  // Task D3: lifted here (rather than owned inside HomeBoard) so the pinned
  // header controls (HomeBoardControls, below) and the grid (HomeBoard)
  // share exactly one edit session/draft — see HomeBoard's and
  // HomeBoardControls' doc comments. Called unconditionally, before the
  // !selectedCompanyId early return, same as every other hook above (Rules
  // of Hooks) — useBoardEdit/useHomeBoardLayout already tolerate a null
  // companyId (the query is simply disabled until one is selected).
  const boardEdit = useBoardEdit(selectedCompanyId, teamRole);

  if (!selectedCompanyId) {
    if (companies.length === 0) {
      return (
        <EmptyState
          icon={Home}
          message="Welcome to AoA. Set up your first company and agent to get started."
          action="Get Started"
          onAction={() => navigate("/onboarding")}
        />
      );
    }
    return <EmptyState icon={Home} message="Create or select a company to get started." />;
  }

  const userName = session?.user?.name?.split(" ")[0] ?? null;
  const greeting = userName ? `${getGreeting()}, ${userName}` : getGreeting();
  // Onboarding (spine + persona fork + in-flight tail) lives ENTIRELY in the
  // standalone /onboarding dark flow and never takes over the dashboard. A
  // founder who hasn't finished their first-run tail is routed back to
  // /onboarding by the index gate (see resumeFirstRunCompanyId), so Home is
  // always the steady dashboard here.

  const actionGroups = data ? buildActionGroups(data) : [];

  return (
    // Full content width: the widget board's grid measures this container to pick
    // its responsive breakpoint. A narrow cap (was `max-w-3xl` = 768px) pinned the
    // board to the `md` 2-col layout and made edit mode (gated on `lg` ≥ 1024px)
    // permanently unreachable, so the board spans the full content area.
    <div className="space-y-6">
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {/* Plan 6 Task 1 (pinned header) + Plan 7 Task 2 (date subline): a single
          pinned row — greeting + muted date line on the left, the "Create"
          menu + the board's customize/edit controls on the right. Renders
          regardless of the home-summary/grid loading state below, and
          survives a per-widget error (each widget has its own
          WidgetErrorBoundary inside HomeBoard, so one failing widget can
          never take this out). The old "N items need attention"/"All clear"
          subline and the three always-visible QuickActionCard creators are
          gone — the creators live behind NewMenu now, and the bottom
          "Nothing needs attention" card (below) still surfaces the all-clear
          state. */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{greeting}</h1>
          {/* Plan 7 Task 2: muted weekday + date line, e.g. "Wednesday, 30 July 2026". */}
          <p className="text-sm text-muted-foreground">{getDateLine()}</p>
        </div>
        <div className="flex items-center gap-2">
          <NewMenu />
          <HomeBoardControls boardEdit={boardEdit} role={teamRole} />
        </div>
      </div>

      {isLoading ? (
        <PageSkeleton variant="dashboard" />
      ) : (
        <>
          <HomeBoard companyId={selectedCompanyId} role={teamRole} boardEdit={boardEdit} />

          {data && actionGroups.length === 0 && suggestions.length === 0 && data.recentActivity.length === 0 && (
            <div className="border border-border rounded-md p-8 text-center">
              <p className="text-sm text-muted-foreground">Nothing needs your attention right now.</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
