/**
 * GitCommandCentre — root component for the project-level git visualization.
 *
 * Data fetching:
 *   /git/graph  — fast (~50ms), git-only, 30s polling via React Query
 *   /git/enrich — slow (~1–2s), GitHub PR+CI badges, separate query
 *
 * Live refresh:
 *   WebSocket heartbeat.run.status events trigger a refetch.
 *   Payload has NO issueId — we do a blanket refetch on any terminal event
 *   for this company. The 25s server cache absorbs burst events.
 *
 * Visibility gate:
 *   Both queries are gated on isWorkspacesTabActive to prevent polling
 *   when the tab is CSS-hidden (which this component is when switching tabs).
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery } from "@tanstack/react-query";
import type { GitBranchInfo, LiveEvent } from "@armyofagents/shared";
import { projectGitApi } from "@/api/project-git";
import { githubIntegrationApi } from "@/api/github-integration";
import { cn } from "@/lib/utils";
import { GitGraphCanvas, type GitGraphCanvasHandle, MAX_DEFAULT_BRANCHES } from "./GitGraphCanvas";
import { GitHoverCard, type HoveredNode } from "./GitHoverCard";
import { GitGraphLegend } from "./GitGraphLegend";
import { GitPipelineView } from "./GitPipelineView";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ViewMode = "map" | "pipeline";
type FilterMode = "all" | "running" | "blocked" | "prs" | "merged";

interface GitCommandCentreProps {
  projectId: string;
  companyId: string;
  /** Gate queries when the Workspaces tab is CSS-hidden (not unmounted). */
  isWorkspacesTabActive: boolean;
  onSelectIssue: (issueId: string) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mergeEnrichments(
  branches: GitBranchInfo[] | undefined,
  enrichments: Array<{ branchName: string; pr: GitBranchInfo["pr"] }> | undefined,
): GitBranchInfo[] {
  if (!branches) return [];
  if (!enrichments?.length) return branches;

  const enrichMap = new Map(enrichments.map((e) => [e.branchName, e.pr]));
  return branches.map((b) => {
    const enrichedPr = enrichMap.get(b.name);
    if (enrichedPr === undefined) return b;
    return { ...b, pr: enrichedPr };
  });
}

// ---------------------------------------------------------------------------
// Empty states
// ---------------------------------------------------------------------------

function NoWorkspaceState() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-8">
      <div className="w-12 h-12 rounded-full bg-[#6470DC]/10 flex items-center justify-center">
        <svg
          className="w-6 h-6 text-[#6470DC]"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M7 7c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm10 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zM12 3c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 8c0 1.1-.9 2-2 2m4 0c0 1.1.9 2 2 2M7 11v2m10-2v2M12 7v2"
          />
        </svg>
      </div>
      <div>
        <p className="text-sm font-medium">No git workspaces yet</p>
        <p className="text-xs text-muted-foreground mt-1">
          Create a task and assign it to this project to see the git graph.
        </p>
      </div>
    </div>
  );
}

function NoBranchesState() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-8">
      <p className="text-sm text-muted-foreground">No branches found in the repository.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function GitCommandCentre({
  projectId,
  companyId,
  isWorkspacesTabActive,
  onSelectIssue,
}: GitCommandCentreProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("map");
  const [filter, setFilter] = useState<FilterMode>("all");
  const [hoveredNode, setHoveredNode] = useState<HoveredNode | null>(null);
  const [hoverPosition, setHoverPosition] = useState({ x: 0, y: 0 });

  // Ref to the canvas imperative handle (zoom controls)
  const canvasHandleRef = useRef<GitGraphCanvasHandle>(null);

  // Tooltip dismiss timer — 200ms grace period so the user can move from the
  // canvas into the hover card without the card vanishing mid-flight.
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearDismissTimer = useCallback(() => {
    if (dismissTimerRef.current !== null) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
  }, []);

  const scheduleDismiss = useCallback(() => {
    clearDismissTimer();
    dismissTimerRef.current = setTimeout(() => {
      setHoveredNode(null);
      dismissTimerRef.current = null;
    }, 200);
  }, [clearDismissTimer]);

  // Cleanup timer on unmount
  useEffect(() => () => clearDismissTimer(), [clearDismissTimer]);

  // ── Data fetching ────────────────────────────────────────────────────────

  const { data: graphData, refetch: refetchGraph, isError: graphError, isPending: graphPending } = useQuery({
    queryKey: ["git-graph", companyId, projectId],
    queryFn: () => projectGitApi.getGraph(companyId, projectId),
    refetchInterval: 30_000,
    staleTime: 25_000,
    enabled: isWorkspacesTabActive,
  });

  const { data: enrichData, refetch: refetchEnrich } = useQuery({
    queryKey: ["git-enrich", companyId, projectId],
    queryFn: () => projectGitApi.getEnrich(companyId, projectId),
    refetchInterval: 30_000,
    staleTime: 25_000,
    enabled: isWorkspacesTabActive && !graphData?.noWorkspaceYet && graphData?.hasGitHubConnection,
  });

  // Repo list for selector pill (only fetched when GitHub is connected)
  const { data: repoList } = useQuery({
    queryKey: ["github-repos", companyId],
    queryFn: () => githubIntegrationApi.getAuthorizedRepos(companyId),
    enabled: isWorkspacesTabActive && graphData?.hasGitHubConnection === true,
    staleTime: 60_000,
  });

  // Merge enrichment patches onto graph branches
  const branches = useMemo(
    () => mergeEnrichments(graphData?.branches, enrichData?.enrichments),
    [graphData?.branches, enrichData?.enrichments],
  );

  // ── SSE smart refresh (Issue A + Issue 3 fixes) ─────────────────────────
  // heartbeat.run.status payload has NO issueId — blanket refetch on terminal.
  // Use ref to avoid stale closure over refetch functions.

  const refetchRef = useRef({ refetchGraph, refetchEnrich });
  useEffect(() => {
    refetchRef.current = { refetchGraph, refetchEnrich };
  }, [refetchGraph, refetchEnrich]);

  useEffect(() => {
    if (!isWorkspacesTabActive) return;

    let socket: WebSocket | null = null;
    let closed = false;

    const connect = () => {
      if (closed) return;
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const url = `${protocol}://${window.location.host}/api/companies/${encodeURIComponent(companyId)}/events/ws`;
      socket = new WebSocket(url);

      socket.onmessage = (message) => {
        const raw = typeof message.data === "string" ? message.data : "";
        if (!raw) return;
        let event: LiveEvent;
        try {
          event = JSON.parse(raw) as LiveEvent;
        } catch {
          return;
        }
        if (event.companyId !== companyId) return;
        if (event.type !== "heartbeat.run.status") return;

        const status = (event.payload as Record<string, unknown>)?.["status"] as string | undefined;
        const TERMINAL = new Set(["completed", "failed", "error", "timed_out", "cancelled"]);
        if (!status || !TERMINAL.has(status)) return;

        // Blanket refetch — 25s server cache absorbs burst events
        refetchRef.current.refetchGraph();
        refetchRef.current.refetchEnrich();
      };

      socket.onclose = () => {
        if (!closed) setTimeout(connect, 3_000);
      };
    };

    connect();
    return () => {
      closed = true;
      socket?.close();
    };
  }, [companyId, isWorkspacesTabActive]);

  // ── Hover ────────────────────────────────────────────────────────────────

  const handleHover = useCallback(
    (node: HoveredNode | null, position: { x: number; y: number }) => {
      if (node) {
        // New node in range — cancel any pending dismiss and show immediately
        clearDismissTimer();
        setHoveredNode(node);
        setHoverPosition(position);
      } else {
        // Cursor left a hit target — schedule dismiss with grace period so the
        // user can move into the hover card before it disappears.
        scheduleDismiss();
      }
    },
    [clearDismissTimer, scheduleDismiss],
  );

  const handleCardMouseEnter = useCallback(() => {
    // Cursor entered the card — cancel dismiss so card stays visible
    clearDismissTimer();
  }, [clearDismissTimer]);

  const handleCardMouseLeave = useCallback(() => {
    // Cursor left the card — dismiss after grace period
    scheduleDismiss();
  }, [scheduleDismiss]);

  const handleClick = useCallback(
    (node: HoveredNode) => {
      if (node.type === "task" && node.branch.linkedIssueId) {
        onSelectIssue(node.branch.linkedIssueId);
      }
    },
    [onSelectIssue],
  );

  // ── Render ───────────────────────────────────────────────────────────────

  const runningCount = branches.filter((b) => b.linkedIssueStatus === "in_progress").length;
  const prCount = branches.filter((b) => b.pr !== null).length;

  if (!graphData) {
    if (graphError) {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-2">
          <p className="text-sm text-red-400">Failed to load git graph</p>
          <button
            className="text-xs text-muted-foreground hover:text-foreground underline"
            onClick={() => refetchGraph()}
          >
            Retry
          </button>
        </div>
      );
    }
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-sm text-muted-foreground animate-pulse">Loading git graph…</div>
      </div>
    );
  }

  if (graphData.noWorkspaceYet) {
    return <NoWorkspaceState />;
  }

  if (branches.length === 0) {
    return <NoBranchesState />;
  }

  const nonDoneCount = branches.filter(
    (b) =>
      b.name !== graphData?.graph.defaultBranch &&
      b.linkedIssueStatus !== "done" &&
      b.linkedIssueStatus !== "cancelled",
  ).length;
  const hiddenCount = filter === "all" ? Math.max(0, nonDoneCount - MAX_DEFAULT_BRANCHES) : 0;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-white/10 shrink-0">
        {/* View toggle */}
        <div className="flex items-center gap-1 bg-white/5 rounded p-0.5">
          {(["map", "pipeline"] as ViewMode[]).map((mode) => (
            <button
              key={mode}
              className={cn(
                "px-3 py-1 rounded text-xs transition-colors capitalize",
                viewMode === mode
                  ? "bg-[#6470DC] text-white"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setViewMode(mode)}
            >
              {mode}
            </button>
          ))}
        </div>

        {/* Filter chips */}
        <div className="flex items-center gap-1">
          {(
            [
              { key: "running", label: "Running", dot: "#4FB67E", count: runningCount },
              { key: "blocked", label: "Blocked", dot: "#ef4444", count: null },
              { key: "prs",     label: "PRs",     dot: null,       count: prCount },
              { key: "merged",  label: "Merged",  dot: null,       count: null },
            ] as Array<{
              key: FilterMode;
              label: string;
              dot: string | null;
              count: number | null;
            }>
          ).map(({ key, label, dot, count }) => (
            <button
              key={key}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] border transition-colors",
                filter === key
                  ? "bg-white/10 border-white/20 text-foreground"
                  : "bg-transparent border-[#2e2c2a] text-[#7E8AA8] hover:text-foreground",
              )}
              onClick={() => setFilter(filter === key ? "all" : key)}
            >
              {dot && (
                <span
                  className="w-1.5 h-1.5 rounded-full inline-block shrink-0"
                  style={{ background: dot }}
                />
              )}
              {label}
              {count !== null && count > 0 && (
                <span className="ml-0.5 text-[10px] opacity-60">{count}</span>
              )}
            </button>
          ))}
        </div>

        {hiddenCount > 0 && (
          <button
            className="px-2.5 py-1 rounded-full text-[11px] border border-[#2e2c2a] text-[#7E8AA8] hover:text-foreground transition-colors"
            title="Showing the most recent branches. Open the Pipeline tab for the full list."
            onClick={() => setViewMode("pipeline")}
          >
            +{hiddenCount} more
          </button>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* ★ D1: Repo pill is DISPLAY-ONLY — no onClick handler.
            TODO: repo switching requires a new server route before this can be interactive.
            Using cursor-default intentionally (not cursor-pointer) to match the behavior. */}
        {graphData?.hasGitHubConnection && (
          <div
            className="flex items-center gap-1.5 px-2 py-1 rounded bg-white/5 border border-[#2e2c2a]"
            title="Connected GitHub repository"
          >
            {/* GitHub icon */}
            <svg width="11" height="11" viewBox="0 0 16 16" fill="#7E8AA8">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            {/* ★ D4: prefer repoUrl (actual connected repo) over repoList[0] (first authorized repo) */}
            <span className="text-[10px] text-[#ccc] font-mono">
              {graphData.repoUrl
                ? graphData.repoUrl.replace(/.*github\.com[:/]/, "").replace(/\.git$/, "")
                : repoList && repoList.length > 0
                  ? repoList[0]!.fullName
                  : "repo"}
            </span>
          </div>
        )}
        {!graphData?.hasGitHubConnection && (
          <span className="text-[11px] text-amber-400/70">
            Connect GitHub →
          </span>
        )}

        {/* Refresh */}
        <button
          className="px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground transition-colors bg-white/5"
          title="Refresh"
          onClick={() => { refetchGraph(); refetchEnrich(); }}
        >
          ↺
        </button>
      </div>

      {/* Main content area */}
      <div className="flex-1 relative overflow-hidden bg-[#0a0a0a] min-h-0">
        {viewMode === "map" ? (
          <>
            <GitGraphCanvas
              ref={canvasHandleRef}
              branches={branches}
              graph={graphData.graph}
              filter={filter}
              onHover={handleHover}
              onClick={handleClick}
              onShowMore={() => setViewMode("pipeline")}
            />
            <GitHoverCard
              node={hoveredNode}
              position={hoverPosition}
              onOpenTask={onSelectIssue}
              onOpenPipeline={() => setViewMode("pipeline")}
              onMouseEnter={handleCardMouseEnter}
              onMouseLeave={handleCardMouseLeave}
            />
            <GitGraphLegend />
            {/* Density hint (Phase 3B) — nudge to the Pipeline list for
                branch-heavy repos where the Map is an overview, not the detail. */}
            {branches.length > 20 && (
              <button
                className="absolute top-3 right-3 z-10 flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#1e1d1c]/90 border border-[#2e2c2a] text-[11px] text-[#7E8AA8] hover:text-foreground transition-colors"
                title="Many branches — the Pipeline list is easier to scan"
                onClick={() => setViewMode("pipeline")}
              >
                <span className="font-mono">{branches.length}</span>&nbsp;branches · Open in Pipeline →
              </button>
            )}
            {/* Zoom controls — bottom-right corner of canvas */}
            <div className="absolute bottom-3 right-3 flex flex-col gap-0.5 z-10">
              {(
                [
                  { label: "+", title: "Zoom in", fn: "zoomIn" },
                  { label: "−", title: "Zoom out", fn: "zoomOut" },
                  { label: "⊡", title: "Reset zoom", fn: "resetZoom" },
                ] as Array<{ label: string; title: string; fn: keyof GitGraphCanvasHandle }>
              ).map(({ label, title, fn }) => (
                <button
                  key={fn}
                  className="w-7 h-7 bg-[#1e1d1c] border border-[#2e2c2a] rounded text-[#7E8AA8] hover:text-foreground text-sm flex items-center justify-center transition-colors"
                  title={title}
                  onClick={() => canvasHandleRef.current?.[fn]()}
                >
                  {label}
                </button>
              ))}
            </div>
          </>
        ) : (
          <GitPipelineView
            branches={branches}
            onOpenIssue={onSelectIssue}
            onSwitchToMap={() => setViewMode("map")}
          />
        )}
      </div>
    </div>
  );
}
