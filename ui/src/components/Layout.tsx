import { lazy, Suspense, useCallback, useEffect, useRef, useState, type UIEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Outlet, useLocation, useNavigate, useParams } from "@/lib/router";
import { Sidebar } from "./Sidebar";
import { SidebarNavItem } from "./SidebarNavItem";
import { BreadcrumbBar } from "./BreadcrumbBar";
import { CommandPalette } from "./CommandPalette";
import { MobileBottomNav } from "./MobileBottomNav";
import { KeyboardShortcutsCheatsheet } from "./KeyboardShortcutsCheatsheet";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { useSidebar } from "../context/SidebarContext";

import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { useCompanyPageMemory } from "../hooks/useCompanyPageMemory";
import { healthApi } from "../api/health";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AgentPanelProvider } from "../context/AgentPanelContext";
import { AccessRequired } from "../pages/AccessRequired";

const NewAgentDialog = lazy(() => import("./NewAgentDialog").then((m) => ({ default: m.NewAgentDialog })));
const NewGoalDialog = lazy(() => import("./NewGoalDialog").then((m) => ({ default: m.NewGoalDialog })));
const NewIssueDialog = lazy(() => import("./NewIssueDialog").then((m) => ({ default: m.NewIssueDialog })));
const NewProjectDialog = lazy(() => import("./NewProjectDialog").then((m) => ({ default: m.NewProjectDialog })));

function getRouteSection(pathname: string, companyPrefix?: string) {
  const normalizedPath = pathname.split(/[?#]/, 1)[0] ?? pathname;
  const segments = normalizedPath.split("/").filter(Boolean);
  const firstContentIndex = companyPrefix && segments[0]?.toUpperCase() === companyPrefix.toUpperCase() ? 1 : 0;
  return { section: segments[firstContentIndex], detailId: segments[firstContentIndex + 1] };
}

export function shouldUseFullBleedMain(pathname: string, companyPrefix?: string) {
  const { section, detailId } = getRouteSection(pathname, companyPrefix);

  return (
    (section === "workspaces" && Boolean(detailId)) ||
    section === "settings" ||
    section === "memory" ||
    section === "skills" ||
    (section === "team" && !detailId) ||
    section === "commander" ||
    // Threads continuum (§13) is an edge-to-edge resizable surface, like Workspace.
    section === "discussions" ||
    section === "threads" ||
    // Inbox hub is an edge-to-edge attention/decision surface (left rail + panels).
    section === "inbox" ||
    section === "inbox-hub"
  );
}

export function Layout() {
  const { sidebarOpen, setSidebarOpen, toggleSidebar, isMobile, setCollapsed, toggleCollapse } = useSidebar();
  const {
    newAgentOpen,
    newGoalOpen,
    newIssueOpen,
    newProjectOpen,
    openNewIssue,
  } = useDialog();
  const { companies, loading: companiesLoading, selectedCompanyId, selectionSource, setSelectedCompanyId } = useCompany();

  const { companyPrefix } = useParams<{ companyPrefix: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const onboardingTriggered = useRef(false);
  const lastMainScrollTop = useRef(0);
  const [mobileNavVisible, setMobileNavVisible] = useState(true);
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);
  // Set to the requested prefix when it matches none of the user's accessible
  // companies — renders AccessRequired in place of the page instead of silently
  // redirecting. Null whenever the prefix resolves (including a wrong-case one).
  const [noAccessPrefix, setNoAccessPrefix] = useState<string | null>(null);

  const { data: health } = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });

  useEffect(() => {
    if (companiesLoading || onboardingTriggered.current) return;
    if (health?.deploymentMode === "authenticated") return;
    // Only the first-time-founder path (no specific company requested) routes to
    // onboarding. A user who requested a specific /PREFIX/... URL but has zero
    // accessible companies (e.g. a revoked LAST membership) must fall through to
    // the no-match effect below → AccessRequired, not the founder flow.
    if (companies.length === 0 && !companyPrefix) {
      onboardingTriggered.current = true;
      // Onboarding is the FlowEngine at /onboarding (C13), not a modal.
      navigate("/onboarding");
    }
  }, [companies, companiesLoading, navigate, health?.deploymentMode, companyPrefix]);

  useEffect(() => {
    // Do NOT early-return on companies.length === 0: a zero-company user who
    // requested a specific prefix must reach the `matched === undefined` branch
    // below so AccessRequired renders (the revoked-last-membership case). The
    // matched/wrong-case/route-sync branches only run when a company matches, so
    // they are unaffected by an empty list.
    if (!companyPrefix || companiesLoading) return;

    const requestedPrefix = companyPrefix.toUpperCase();
    const matched = companies.find((company) => company.issuePrefix.toUpperCase() === requestedPrefix);

    if (!matched) {
      // The client cannot tell "company does not exist" from "exists but I'm
      // not a member" — both simply fall out of the accessible list. Surface an
      // honest access-required state (with the requested prefix as context)
      // rather than silently bouncing a shared link elsewhere.
      setNoAccessPrefix(companyPrefix);
      return;
    }

    // Resolved to an accessible company — clear any prior no-access state.
    setNoAccessPrefix(null);

    if (companyPrefix !== matched.issuePrefix) {
      const suffix = location.pathname.replace(/^\/[^/]+/, "");
      navigate(`/${matched.issuePrefix}${suffix}${location.search}`, { replace: true });
      return;
    }

    if (selectedCompanyId !== matched.id) {
      setSelectedCompanyId(matched.id, { source: "route_sync" });
    }
  }, [
    companyPrefix,
    companies,
    companiesLoading,
    location.pathname,
    location.search,
    navigate,
    selectedCompanyId,
    setSelectedCompanyId,
  ]);

  // G8: Navigate when company is manually switched (Cmd+1-9, etc.)
  // ONLY triggers on "manual" source to avoid 4 race conditions.
  useEffect(() => {
    if (selectionSource === "manual" && selectedCompanyId) {
      const company = companies.find((c) => c.id === selectedCompanyId);
      if (company) {
        navigate(`/${company.issuePrefix}/home`, { replace: true });
      }
    }
  }, [selectedCompanyId, selectionSource, companies, navigate]);

  // Cmd+1..9 to switch companies
  const switchCompany = useCallback(
    (index: number) => {
      if (index < companies.length) {
        setSelectedCompanyId(companies[index]!.id);
      }
    },
    [companies, setSelectedCompanyId],
  );

  // Auto-collapse sidebar on workspace routes
  useEffect(() => {
    if (!isMobile && location.pathname.includes("/workspaces/")) {
      setCollapsed(true);
    }
  }, [location.pathname, isMobile, setCollapsed]);

  useCompanyPageMemory();

  useKeyboardShortcuts({
    onNewIssue: () => openNewIssue(),
    onToggleSidebar: isMobile ? toggleSidebar : toggleCollapse,
    onSwitchCompany: switchCompany,
    onShowCheatsheet: () => setCheatsheetOpen(true),
  });

  useEffect(() => {
    if (!isMobile) {
      setMobileNavVisible(true);
      return;
    }
    lastMainScrollTop.current = 0;
    setMobileNavVisible(true);
  }, [isMobile]);

  // Swipe gesture to open/close sidebar on mobile
  useEffect(() => {
    if (!isMobile) return;

    const EDGE_ZONE = 30; // px from left edge to start open-swipe
    const MIN_DISTANCE = 50; // minimum horizontal swipe distance
    const MAX_VERTICAL = 75; // max vertical drift before we ignore

    let startX = 0;
    let startY = 0;

    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0]!;
      startX = t.clientX;
      startY = t.clientY;
    };

    const onTouchEnd = (e: TouchEvent) => {
      const t = e.changedTouches[0]!;
      const dx = t.clientX - startX;
      const dy = Math.abs(t.clientY - startY);

      if (dy > MAX_VERTICAL) return; // vertical scroll, ignore

      // Swipe right from left edge → open
      if (!sidebarOpen && startX < EDGE_ZONE && dx > MIN_DISTANCE) {
        setSidebarOpen(true);
        return;
      }

      // Swipe left when open → close
      if (sidebarOpen && dx < -MIN_DISTANCE) {
        setSidebarOpen(false);
      }
    };

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchend", onTouchEnd, { passive: true });

    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchend", onTouchEnd);
    };
  }, [isMobile, sidebarOpen, setSidebarOpen]);

  const handleMainScroll = useCallback(
    (event: UIEvent<HTMLElement>) => {
      if (!isMobile) return;

      const currentTop = event.currentTarget.scrollTop;
      const delta = currentTop - lastMainScrollTop.current;

      if (currentTop <= 24) {
        setMobileNavVisible(true);
      } else if (delta > 8) {
        setMobileNavVisible(false);
      } else if (delta < -8) {
        setMobileNavVisible(true);
      }

      lastMainScrollTop.current = currentTop;
    },
    [isMobile],
  );

  return (
    <AgentPanelProvider>
    <div className="flex h-dvh bg-background text-foreground overflow-hidden pt-[env(safe-area-inset-top)]">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[200] focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Skip to Main Content
      </a>
      {/* Mobile backdrop */}
      {isMobile && sidebarOpen && (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-black/50"
          onClick={() => setSidebarOpen(false)}
          aria-label="Close sidebar"
        />
      )}

      {/* Sidebar + docs bar */}
      {isMobile ? (
        <div
          className={cn(
            "fixed inset-y-0 left-0 z-50 flex flex-col overflow-hidden pt-[env(safe-area-inset-top)] transition-transform duration-100 ease-out",
            sidebarOpen ? "translate-x-0" : "-translate-x-full"
          )}
        >
          <div className="flex flex-1 min-h-0 overflow-hidden">
            <Sidebar />
          </div>
        </div>
      ) : (
        <div className="relative flex flex-col shrink-0 h-full">
          <div className="flex flex-1 min-h-0">
            <Sidebar />
          </div>
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 h-full">
        <BreadcrumbBar />
        <main
          id="main-content"
          tabIndex={-1}
          className={cn(
            "flex-1 overflow-auto",
            !shouldUseFullBleedMain(location.pathname, companyPrefix) && "p-4 md:p-6",
            isMobile && "pb-[calc(5rem+env(safe-area-inset-bottom))]",
          )}
          onScroll={handleMainScroll}
        >
          {noAccessPrefix ? <AccessRequired requestedPrefix={noAccessPrefix} /> : <Outlet />}
        </main>
      </div>


      {isMobile && <MobileBottomNav visible={mobileNavVisible} />}
      <CommandPalette />
      <Suspense fallback={null}>
        {newIssueOpen && <NewIssueDialog />}
        {newProjectOpen && <NewProjectDialog />}
        {newGoalOpen && <NewGoalDialog />}
        {newAgentOpen && <NewAgentDialog />}
      </Suspense>
      <KeyboardShortcutsCheatsheet open={cheatsheetOpen} onOpenChange={setCheatsheetOpen} />
    </div>
    </AgentPanelProvider>
  );
}
