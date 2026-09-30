/**
 * ThreadsWorkspace is the route-level discussions shell.
 *
 * Home renders the shared thread rail, a discussions overview center pane, and
 * the global viewer. A selected thread keeps the rail and delegates the center
 * and right viewer to ThreadDetail in embedded mode.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useDialog } from "../context/DialogContext";
import { useTeamAccess } from "../hooks/useTeamAccess";
import { api } from "../api/client";
import { threadsApi, type ThreadListItem } from "../api/threads";
import { cn } from "../lib/utils";
import {
  closeTab,
  ensureTab,
  type ThreadViewerTab,
} from "../components/threads/threadViewerModel";
import { ThreadCollapsedTabStrip } from "../components/threads/ThreadViewer";
import { ThreadsHomeOverview } from "../components/threads/ThreadsHomeOverview";
import {
  HOME_VIEWER_DEFAULT_TAB,
  ThreadsGlobalViewer,
} from "../components/threads/ThreadsGlobalViewer";
import { ThreadsSidebarRail } from "../components/threads/ThreadsSidebarRail";
import type { InboxCardItem } from "../components/threads/ThreadBoard";
import { ThreadDetail } from "./ThreadDetail";

const BROWSER_COLLAPSED_WIDTH = 48;
const BROWSER_RAIL_WIDTH = 264;
const BROWSER_FULL_THRESHOLD = 560;
const BROWSER_COLLAPSE_THRESHOLD = 96;
const HOME_VIEWER_COLLAPSED_WIDTH = 46;
const HOME_VIEWER_DEFAULT_WIDTH = 340;
const HOME_VIEWER_MIN_WIDTH = 280;
const HOME_VIEWER_MAX_WIDTH = 640;

/** Track desktop vs mobile so the continuum split is desktop-only; on mobile we
 *  render the full ThreadDetail (its own rail + tab bar). */
function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== "undefined"
      ? window.matchMedia("(min-width: 768px)").matches
      : true
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(min-width: 768px)");
    const handler = () => setIsDesktop(mq.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return isDesktop;
}

export function ThreadsWorkspace() {
  const { discussionId, threadId } = useParams<{
    discussionId?: string;
    threadId?: string;
  }>();
  const selectedId = discussionId ?? threadId ?? null;
  const hasSelection = !!selectedId;
  const isDesktop = useIsDesktop();

  const { selectedCompanyId } = useCompany();
  const { role } = useTeamAccess(selectedCompanyId);
  const canEditRouting = role === "founder";
  const { openNewThread } = useDialog();
  const { setBreadcrumbs, setEntityColor, setSubtitle } = useBreadcrumbs();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [homeViewerTabs, setHomeViewerTabs] = useState<ThreadViewerTab[]>(
    () => [HOME_VIEWER_DEFAULT_TAB]
  );
  const [homeViewerActiveKey, setHomeViewerActiveKey] = useState<string | null>(
    HOME_VIEWER_DEFAULT_TAB.key
  );
  const [homeViewerCollapsed, setHomeViewerCollapsed] = useState(false);
  const [homeViewerWidth, setHomeViewerWidth] = useState(
    HOME_VIEWER_DEFAULT_WIDTH
  );

  // Legacy board/list URLs fall back to the Home workspace.
  const viewParam = searchParams.get("view");
  useEffect(() => {
    if (viewParam !== "board" && viewParam !== "list") return;
    const next = new URLSearchParams(searchParams);
    next.delete("view");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, viewParam]);

  const [railWidth, setRailWidth] = useState(BROWSER_RAIL_WIDTH);
  const [search, setSearch] = useState("");
  const browserDragStart = useRef<{ x: number; width: number } | null>(null);
  const homeViewerDragStart = useRef<{ x: number; width: number } | null>(null);

  // Breadcrumb for browse mode; the detail (ThreadDetail) sets its own.
  useEffect(() => {
    if (hasSelection) return;
    setBreadcrumbs([{ label: "Discussions" }]);
    setEntityColor("var(--entity-brief)");
    return () => {
      setSubtitle(null);
      setEntityColor(null);
    };
  }, [hasSelection, setBreadcrumbs, setEntityColor, setSubtitle]);

  const { data, isError, refetch } = useQuery({
    queryKey: ["threads", selectedCompanyId, "list", "active"],
    queryFn: () => threadsApi.list(selectedCompanyId!, { status: "active" }),
    enabled: !!selectedCompanyId,
    retry: false,
  });
  const threads = (data?.discussions ?? []) as ThreadListItem[];

  const { data: archivedData } = useQuery({
    queryKey: ["threads", selectedCompanyId, "list", "archived"],
    queryFn: () => threadsApi.list(selectedCompanyId!, { status: "archived" }),
    enabled: !!selectedCompanyId,
    retry: false,
  });
  const archivedThreads = (archivedData?.discussions ?? []) as ThreadListItem[];

  const { data: inboxData } = useQuery({
    queryKey: ["threads-inbox", selectedCompanyId],
    queryFn: () =>
      api.get<{ items: InboxCardItem[]; total: number }>(
        `/companies/${selectedCompanyId}/discussions/inbox`
      ),
    enabled: !!selectedCompanyId,
    retry: false,
  });
  const inboxItems = inboxData?.items ?? [];

  const filtered = useMemo(() => {
    if (!search.trim()) return threads;
    const q = search.trim().toLowerCase();
    return threads.filter((t) => t.title.toLowerCase().includes(q));
  }, [threads, search]);

  const archiveThread = useMutation({
    mutationFn: (threadId: string) =>
      threadsApi.setStatus(selectedCompanyId!, threadId, "archived"),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["threads", selectedCompanyId, "list"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["threads", selectedCompanyId, "list", "archived"],
      });
    },
  });

  const unarchiveThread = useMutation({
    mutationFn: (threadId: string) =>
      threadsApi.setStatus(selectedCompanyId!, threadId, "active"),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["threads", selectedCompanyId, "list"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["threads", selectedCompanyId, "list", "archived"],
      });
    },
  });

  const refreshInboxAndThreads = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: ["threads-inbox", selectedCompanyId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["threads", selectedCompanyId, "list"],
    });
  }, [queryClient, selectedCompanyId]);

  const openHomeViewerTab = useCallback((tab: ThreadViewerTab) => {
    setHomeViewerTabs((tabs) => ensureTab(tabs, tab));
    setHomeViewerActiveKey(tab.key);
  }, []);

  const closeHomeViewerTab = useCallback((key: string) => {
    setHomeViewerTabs((tabs) => {
      const nextTabs = closeTab(tabs, key);
      setHomeViewerActiveKey((activeKey) => {
        if (activeKey !== key) return activeKey;
        return nextTabs.at(-1)?.key ?? null;
      });
      return nextTabs;
    });
  }, []);

  const startHomeViewerResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (homeViewerCollapsed) return;
      homeViewerDragStart.current = {
        x: event.clientX,
        width: homeViewerWidth,
      };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    [homeViewerCollapsed, homeViewerWidth]
  );

  const resizeHomeViewer = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!homeViewerDragStart.current) return;
      const delta = homeViewerDragStart.current.x - event.clientX;
      const nextWidth = Math.min(
        HOME_VIEWER_MAX_WIDTH,
        Math.max(
          HOME_VIEWER_MIN_WIDTH,
          homeViewerDragStart.current.width + delta
        )
      );
      setHomeViewerWidth(nextWidth);
    },
    []
  );

  const stopHomeViewerResize = useCallback(() => {
    homeViewerDragStart.current = null;
  }, []);

  // Index width: browse → fills; detail → narrow rail (collapsible).
  const browserCollapsed = railWidth <= BROWSER_COLLAPSED_WIDTH;

  const openHomeBrowser = useCallback(() => {
    navigate("/discussions");
  }, [navigate]);

  const toggleBrowserCollapse = useCallback(() => {
    setRailWidth((width) =>
      width <= BROWSER_COLLAPSED_WIDTH
        ? BROWSER_RAIL_WIDTH
        : BROWSER_COLLAPSED_WIDTH
    );
  }, []);

  const startBrowserResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!hasSelection) return;
      browserDragStart.current = { x: event.clientX, width: railWidth };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    [railWidth, hasSelection]
  );

  const resizeBrowser = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!browserDragStart.current) return;
      const delta = event.clientX - browserDragStart.current.x;
      const nextWidth = Math.max(
        BROWSER_COLLAPSED_WIDTH,
        browserDragStart.current.width + delta
      );
      if (nextWidth >= BROWSER_FULL_THRESHOLD) {
        browserDragStart.current = null;
        navigate("/discussions");
        return;
      }
      setRailWidth(
        nextWidth <= BROWSER_COLLAPSE_THRESHOLD
          ? BROWSER_COLLAPSED_WIDTH
          : nextWidth
      );
    },
    [navigate]
  );

  const stopBrowserResize = useCallback(() => {
    browserDragStart.current = null;
  }, []);

  // On mobile with a selection, hide the index rail — the full ThreadDetail
  // (rendered non-embedded below) owns navigation via its mobile tab bar.
  const showIndex = !hasSelection || isDesktop;

  return (
    <div
      className="flex h-full overflow-hidden bg-muted/30 p-2"
      data-testid="threads-workspace"
    >
      <div className="flex min-h-0 flex-1 gap-2 overflow-hidden">
        {/* ── Index surface (board ↔ list ↔ icon rail) ── */}
        {showIndex && (
          <section
            className={cn(
              "relative flex h-full flex-col overflow-hidden rounded-xl border border-border bg-background shadow-sm transition-[width] duration-200",
              "shrink-0"
            )}
            style={{ width: railWidth }}
            data-testid="threads-index"
            data-mode={hasSelection ? "threads" : "home"}
            data-browser={browserCollapsed ? "collapsed" : "rail"}
            data-expanded="false"
            data-collapsed={browserCollapsed ? "true" : "false"}
            data-width={String(Math.round(railWidth))}
          >
            <ThreadsSidebarRail
              activeMode={hasSelection ? "threads" : "home"}
              collapsed={browserCollapsed}
              threads={filtered}
              archivedThreads={archivedThreads}
              unlistedHasItems={inboxItems.length > 0}
              currentId={selectedId}
              onNewThread={openNewThread}
              onToggle={toggleBrowserCollapse}
              onOpenHome={openHomeBrowser}
              onArchiveThread={(threadId) => archiveThread.mutate(threadId)}
              onUnarchiveThread={(threadId) => unarchiveThread.mutate(threadId)}
              search={search}
              setSearch={setSearch}
            />
          </section>
        )}

        {/* ── Detail (embedded 3-pane on desktop; full ThreadDetail on mobile) ── */}
        {showIndex && (
          <div
            role="separator"
            aria-label="Resize thread browser"
            aria-orientation="vertical"
            onPointerDown={startBrowserResize}
            onPointerMove={resizeBrowser}
            onPointerUp={stopBrowserResize}
            onPointerCancel={stopBrowserResize}
            className="relative z-20 h-full w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-border/70"
          />
        )}

        {!hasSelection && (
          <main
            className="min-w-0 flex-1 h-full overflow-hidden rounded-xl border border-border bg-background shadow-sm"
            data-testid="threads-browse-detail"
          >
            {isError ? (
              <div
                className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"
                data-testid="threads-browse-error"
              >
                <p className="text-sm font-medium text-destructive">
                  Couldn&apos;t load discussions
                </p>
                <p className="max-w-sm text-sm text-muted-foreground">
                  Something went wrong fetching your discussions. Check your
                  connection and try again.
                </p>
                <button
                  type="button"
                  onClick={() => void refetch()}
                  className="inline-flex h-8 items-center justify-center rounded-md border border-border-strong bg-transparent px-3 text-sm font-semibold text-text transition-colors hover:bg-card focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-focus-ring"
                >
                  Retry
                </button>
              </div>
            ) : (
              <ThreadsHomeOverview
                threads={filtered}
                inboxItems={inboxItems}
                onInboxUpdate={refreshInboxAndThreads}
                companyId={selectedCompanyId}
                canEditRouting={canEditRouting}
              />
            )}
          </main>
        )}

        {!hasSelection && !homeViewerCollapsed && (
          <>
            <div
              role="separator"
              aria-label="Resize global viewer"
              aria-orientation="vertical"
              onPointerDown={startHomeViewerResize}
              onPointerMove={resizeHomeViewer}
              onPointerUp={stopHomeViewerResize}
              onPointerCancel={stopHomeViewerResize}
              className="relative z-20 h-full w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-border/70"
            />
            <ThreadsGlobalViewer
              tabs={homeViewerTabs}
              activeKey={homeViewerActiveKey}
              onActivate={setHomeViewerActiveKey}
              onClose={closeHomeViewerTab}
              onOpenTab={openHomeViewerTab}
              onToggleCollapse={() => setHomeViewerCollapsed(true)}
              width={homeViewerWidth}
            />
          </>
        )}

        {!hasSelection && homeViewerCollapsed && (
          <div
            className="relative h-full shrink-0 overflow-hidden rounded-xl border border-border bg-background shadow-sm transition-[width] duration-200"
            style={{ width: HOME_VIEWER_COLLAPSED_WIDTH }}
            data-testid="threads-global-viewer-collapsed"
            data-collapsed="true"
            data-width={String(HOME_VIEWER_COLLAPSED_WIDTH)}
          >
            <ThreadCollapsedTabStrip
              tabs={homeViewerTabs}
              activeKey={homeViewerActiveKey}
              onActivate={setHomeViewerActiveKey}
              onExpand={() => setHomeViewerCollapsed(false)}
            />
          </div>
        )}

        {hasSelection && (
          <div className="min-w-0 flex-1 h-full" data-testid="threads-detail">
            <ThreadDetail embedded={isDesktop} />
          </div>
        )}
      </div>
    </div>
  );
}
