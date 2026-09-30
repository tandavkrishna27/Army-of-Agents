/**
 * GitGraphCanvas — D3 + Canvas renderer for the Git Command Centre.
 *
 * Uses a trunk-and-arcs layout: main branch is a central horizontal spine;
 * feature branches arc above and below as bezier curves.
 *
 * Exposed via forwardRef as GitGraphCanvasHandle for imperative zoom controls.
 * Animation loop (RAF) runs always while the tab is visible, throttled to ~30fps,
 * so the trunk's left→right pulse animates continuously.
 */

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import * as d3 from "d3";
import type { GitBranchInfo, GitGraphData } from "@armyofagents/shared";
import type { HoveredNode } from "./GitHoverCard";
import { buildTrunkSummary, isRemoteOnly, type TrunkSummary } from "./git-tooltip-data";
import {
  computeArcLayout,
  computeHeadFocusTransform,
  type ArcCommitLayout,
} from "./git-arc-layout";
import {
  drawCommitNode,
  drawCardLabel,
  drawCardBadges,
  drawTagPills,
  drawHeadLabel,
  drawSyncBadge,
  drawTrunk,
  drawArcLines,
  drawArcLabels,
  drawLabelDots,
  drawFlowPulse,
  drawTipStack,
} from "./git-arc-draw";
import {
  buildHitRegions,
  hitRegionAt,
  resolveNodeRender,
  type HitTarget,
} from "./git-arc-hit";
import { sortByRecency } from "./git-pipeline-sort";

/**
 * Max non-trunk branches drawn in the default ("all") Map view. The trunk-and-
 * arcs layout has two lanes (up/down), so beyond ~12 branches the arcs overlap
 * into an unreadable band. Branches beyond the cap are still in the Pipeline tab.
 */
export const MAX_DEFAULT_BRANCHES = 12;

// ---------------------------------------------------------------------------
// Public handle (for toolbar zoom controls)
// ---------------------------------------------------------------------------

export interface GitGraphCanvasHandle {
  zoomIn(): void;
  zoomOut(): void;
  resetZoom(): void;
}


export interface GitGraphCanvasProps {
  branches: GitBranchInfo[];
  graph: GitGraphData;
  filter: "all" | "running" | "blocked" | "prs" | "merged";
  onHover: (node: HoveredNode | null, position: { x: number; y: number }) => void;
  onClick: (node: HoveredNode) => void;
  /** Called when the "+N more" stack pill is clicked — open the Pipeline tab. */
  onShowMore?: () => void;
}

// ---------------------------------------------------------------------------
// Hit-target resolution (registry HitTarget → HoveredNode)
// ---------------------------------------------------------------------------

export function resolveTarget(
  target: HitTarget,
  branchByName: Map<string, GitBranchInfo>,
  graph: GitGraphData,
  _layoutNodes: ArcCommitLayout[],
  _cx: number,
  trunkSummary: TrunkSummary,
): { hover: HoveredNode | null; showMore: boolean } {
  switch (target.kind) {
    case "task": {
      const b = branchByName.get(target.branchName);
      if (b?.linkedIssueId) return { hover: { type: "task", branch: b }, showMore: false };
      return { hover: b ? { type: "plain_tip", branch: b } : null, showMore: false };
    }
    case "plainTip": {
      const b = branchByName.get(target.branchName);
      if (!b) return { hover: null, showMore: false };
      return { hover: { type: isRemoteOnly(b) ? "remote_marker" : "plain_tip", branch: b }, showMore: false };
    }
    case "commit": {
      const c = graph.commits.find((x) => x.sha === target.sha);
      return { hover: c ? { type: "commit", commit: c } : null, showMore: false };
    }
    case "merge": {
      const c = graph.commits.find((x) => x.sha === target.sha);
      return { hover: c ? { type: "merge", commit: c, defaultBranch: graph.defaultBranch } : null, showMore: false };
    }
    case "tag": {
      const c = graph.commits.find((x) => x.sha === target.sha);
      return {
        hover: { type: "tag", name: target.name, sha: target.sha, date: c?.committedAt ?? "" },
        showMore: false,
      };
    }
    case "trunkLine": {
      const b = branchByName.get(graph.defaultBranch) ?? null;
      return { hover: { type: "trunk", branch: b, summary: trunkSummary }, showMore: false };
    }
    case "showMore": {
      const bs = target.branchNames
        .map((n) => branchByName.get(n))
        .filter((x): x is GitBranchInfo => !!x);
      return { hover: { type: "cluster", branches: bs, total: target.branchNames.length }, showMore: true };
    }
  }
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export const GitGraphCanvas = forwardRef<GitGraphCanvasHandle, GitGraphCanvasProps>(
  function GitGraphCanvas({ branches, graph, filter, onHover, onClick, onShowMore }, ref) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const transformRef = useRef(d3.zoomIdentity);
    const zoomRef = useRef<d3.ZoomBehavior<HTMLCanvasElement, unknown> | null>(null);
    const initialPanApplied = useRef(false);
    const rafRef = useRef<number | null>(null);
    const animPhaseRef = useRef(0);
    const frameSkipRef = useRef(0);

    const branchByName = useMemo(
      () => new Map(branches.map((b) => [b.name, b])),
      [branches],
    );

    // Map tipSha → task branch (for collision fix when branches share a tip SHA)
    const taskBranchByTipSha = useMemo(() => {
      const m = new Map<string, GitBranchInfo>();
      for (const b of branches) {
        if (b.lastCommitSha && b.linkedIssueId && !m.has(b.lastCommitSha)) {
          m.set(b.lastCommitSha, b);
        }
      }
      return m;
    }, [branches]);

    const trunkSummary = useMemo(() => buildTrunkSummary(graph, branches), [graph, branches]);

    // Filter branches.
    // Default ("all") = the trunk + every branch that is NOT done/cancelled
    // (both AoA task branches AND plain git branches), capped at the N most
    // recently-committed so the Map stays readable. Done/cancelled show via the
    // "Merged" chip; the full list lives in the Pipeline tab. The cap matters
    // for real repos (e.g. SeaMaster has ~80 branches, paperclip ~296) where
    // showing every branch at once is an unreadable smear.
    const visibleBranches = useMemo(() => {
      if (filter === "running") return sortByRecency(branches.filter((b) => b.linkedIssueStatus === "in_progress"), MAX_DEFAULT_BRANCHES);
      if (filter === "blocked") return sortByRecency(branches.filter((b) => b.linkedIssueStatus === "blocked"), MAX_DEFAULT_BRANCHES);
      if (filter === "prs")     return sortByRecency(branches.filter((b) => !!b.pr), MAX_DEFAULT_BRANCHES);
      if (filter === "merged")  return sortByRecency(
        branches.filter((b) => b.linkedIssueStatus === "done" || b.linkedIssueStatus === "cancelled"),
        MAX_DEFAULT_BRANCHES,
      );
      // default "all"
      const isDone = (b: GitBranchInfo) =>
        b.linkedIssueStatus === "done" || b.linkedIssueStatus === "cancelled";
      const trunk = branches.filter((b) => b.name === graph.defaultBranch);
      const rest = sortByRecency(
        branches.filter((b) => b.name !== graph.defaultBranch && !isDone(b)),
        MAX_DEFAULT_BRANCHES,
      );
      return [...trunk, ...rest];
    }, [branches, filter, graph.defaultBranch]);

    const visibleNames = useMemo(() => {
      const names = new Set(visibleBranches.map((b) => b.name));
      names.add(graph.defaultBranch); // trunk always visible
      return names;
    }, [visibleBranches, graph.defaultBranch]);

    // Merged filter brings done/cancelled branches back into the layout; every
    // other view excludes them so they don't consume lanes or layout cost. (Phase 4A)
    // Depend on includeDone (not raw filter) so toggling among running/blocked/
    // prs/all — all includeDone=false — reuses the layout instead of recomputing.
    const includeDone = filter === "merged";
    const layout = useMemo(
      () => computeArcLayout(graph, branches, { includeDone }),
      [graph, branches, includeDone],
    );

    // Always-current layout ref — prevents stale closure in ResizeObserver
    const layoutRef = useRef(layout);
    layoutRef.current = layout;

    // Trunk x-range (layout space) for trunk-line hover.
    const trunkSpan = useMemo(() => {
      const xs = layout.nodes.filter((n) => n.isTrunk).map((n) => n.x);
      if (xs.length === 0) return null;
      return { minX: Math.min(...xs), maxX: Math.max(...xs) };
    }, [layout]);

    // Stacks restricted to currently-visible branches. A stack needs >=2 visible
    // members to fan; otherwise its node renders the normal single-card path.
    const visibleStacks = useMemo(
      () =>
        layout.tipStacks
          .map((s) => ({
            ...s,
            branchNames: s.branchNames.filter((n) => visibleNames.has(n)),
            extraNames: (s.extraNames ?? []).filter((n) => visibleNames.has(n)),
          }))
          .filter((s) => s.branchNames.length >= 2),
      [layout.tipStacks, visibleNames],
    );
    // SHAs drawn as a fan (their node becomes a plain dot, not a card).
    const stackedShas = useMemo(
      () => new Set(visibleStacks.map((s) => s.sha)),
      [visibleStacks],
    );
    // Branch names whose (degenerate) arc + label must be suppressed because the
    // branch is shown as a fanned card instead.
    const stackedBranchNames = useMemo(
      () => new Set(visibleStacks.flatMap((s) => [...s.branchNames, ...(s.extraNames ?? [])])),
      [visibleStacks],
    );
    // visibleNames minus stacked branches — used ONLY for arc lines + arc labels.
    const arcVisibleNames = useMemo(() => {
      const s = new Set(visibleNames);
      for (const n of stackedBranchNames) s.delete(n);
      return s;
    }, [visibleNames, stackedBranchNames]);

    // Hit regions for hover/click — rebuilt only when the layout/filter/branch
    // data change (NOT per animation frame).
    const regions = useMemo(
      () =>
        buildHitRegions({
          layout,
          visibleNames,
          arcVisibleNames,
          visibleStacks,
          stackedShas,
          branchByName,
          taskBranchByTipSha,
          trunkSpan,
          defaultBranch: graph.defaultBranch,
        }),
      [layout, visibleNames, arcVisibleNames, visibleStacks, stackedShas, branchByName, taskBranchByTipSha, trunkSpan, graph.defaultBranch],
    );

    // Reset initial-pan flag whenever graph data changes
    useEffect(() => {
      initialPanApplied.current = false;
    }, [graph]);

    // ── Imperative zoom handle ──────────────────────────────────────────────

    useImperativeHandle(ref, () => ({
      zoomIn() {
        const canvas = canvasRef.current;
        if (!canvas || !zoomRef.current) return;
        d3.select(canvas).call(zoomRef.current.scaleBy, 1.4);
      },
      zoomOut() {
        const canvas = canvasRef.current;
        if (!canvas || !zoomRef.current) return;
        d3.select(canvas).call(zoomRef.current.scaleBy, 1 / 1.4);
      },
      resetZoom() {
        const canvas = canvasRef.current;
        if (!canvas || !zoomRef.current) return;
        d3.select(canvas).call(zoomRef.current.transform, d3.zoomIdentity);
      },
    }));

    // ── Redraw ──────────────────────────────────────────────────────────────

    const redraw = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const t = transformRef.current;
      const dpr = window.devicePixelRatio || 1;

      // Left viewport edge in layout space (+ a small inset so the stub is visible).
      const viewportLeftInLayout = (0 - t.x) / t.k + 24;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.setTransform(t.k * dpr, 0, 0, t.k * dpr, t.x * dpr, t.y * dpr);

      // Default branch color for trunk line
      const trunkColor =
        graph.branches.find((b) => b.name === graph.defaultBranch)?.color ?? "#6470DC";

      // Filter nodes: trunk always shown; arc nodes filtered by arcBranchName
      const visibleNodes = layout.nodes.filter((n) => {
        if (n.isTrunk) return visibleNames.has(graph.defaultBranch);
        return n.arcBranchName != null && visibleNames.has(n.arcBranchName);
      });

      // 1. Trunk line
      drawTrunk(ctx, layout.nodes, layout.trunkY, trunkColor, graph.defaultBranch);

      // 2. Arc lines (smooth path through commit nodes + dashed open stub)
      drawArcLines(ctx, layout.arcs, arcVisibleNames, viewportLeftInLayout);

      // 3. Flow pulse dots (trunk pulse always shows; arc pulses self-gate on status)
      {
        const trunkNodes = layout.nodes.filter((n) => n.isTrunk);
        drawFlowPulse(
          ctx,
          layout.arcs,
          trunkNodes,
          branchByName,
          animPhaseRef.current,
          // arcVisibleNames (not visibleNames): a stacked branch's arc line is
          // suppressed, so its flow pulse must be too — otherwise the pulse
          // animates along the hidden degenerate stub ("dot floating in the air").
          arcVisibleNames,
          layout.trunkY,
          graph.defaultBranch,
        );
      }

      // 4. Commit nodes + task labels + badges + label dots.
      // Track which branches render a card so arc labels can skip them (the
      // card already shows the identifier + title — drawing both collides).
      const cardBranchNames = new Set<string>();
      for (const node of visibleNodes) {
        const r = resolveNodeRender(
          node, visibleNames, branchByName, taskBranchByTipSha, stackedShas,
        );
        const branchStatus = r.taskBranch?.linkedIssueStatus ?? null;
        drawCommitNode(ctx, node, animPhaseRef.current, branchStatus, r.asDot);

        if (node.isBranchTip && !r.isStacked) {
          let syncBranch = node.branchName ? branchByName.get(node.branchName) : undefined;
          if (!syncBranch) syncBranch = taskBranchByTipSha.get(node.sha);
          if (syncBranch) drawSyncBadge(ctx, node, syncBranch);
        }

        if (node.isTaskTip && !r.isStacked && r.taskVisible && r.taskBranch?.linkedIssueId) {
          drawCardLabel(ctx, node, r.taskBranch);
          drawCardBadges(ctx, node, r.taskBranch);
          drawLabelDots(ctx, node, r.taskBranch);
          if (node.arcBranchName) cardBranchNames.add(node.arcBranchName);
        }
      }

      // 4b. Same-commit task stacks (fanned cards + connectors + "+N more").
      for (const stack of visibleStacks) {
        drawTipStack(ctx, stack, branchByName, animPhaseRef.current);
      }

      // 5. Tag pills
      for (const node of visibleNodes) {
        if (node.tags.length > 0) drawTagPills(ctx, node);
      }

      // 6. HEAD label on default branch tip
      const defaultTip = visibleNodes.find((n) => n.isDefault && n.branchName != null);
      if (defaultTip) drawHeadLabel(ctx, defaultTip);

      // 7. Arc labels (branch name near apex) — only for plain branches that
      // don't already have a task card.
      drawArcLabels(ctx, layout.arcs, arcVisibleNames, cardBranchNames);

      ctx.restore();
    }, [layout, visibleNames, arcVisibleNames, visibleStacks, stackedShas, branchByName, taskBranchByTipSha, graph.defaultBranch, graph.branches]);

    // ── RAF loop (throttled to ~30fps, pauses when the tab is hidden) ─────────

    // Single source of truth for the animation tick — used by both the mount
    // effect and the visibilitychange resume handler (no duplicated tick).
    const startRafLoop = useCallback(() => {
      if (rafRef.current !== null) return; // already running
      const tick = () => {
        if (document.visibilityState === "hidden") {
          rafRef.current = null;
          return;
        }
        // Throttle to ~30fps: advance + redraw on every other frame.
        frameSkipRef.current = (frameSkipRef.current + 1) % 2;
        if (frameSkipRef.current === 0) {
          animPhaseRef.current += 0.1; // larger step compensates for ~30fps
          redraw();
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    }, [redraw]);

    // Run the loop on mount / whenever redraw changes.
    useEffect(() => {
      startRafLoop();
      return () => {
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
      };
    }, [startRafLoop]);

    // Resume the loop when the tab becomes visible again.
    useEffect(() => {
      const onVis = () => {
        if (document.visibilityState === "visible") startRafLoop();
      };
      document.addEventListener("visibilitychange", onVis);
      return () => document.removeEventListener("visibilitychange", onVis);
    }, [startRafLoop]);

    // ── Resize handler ──────────────────────────────────────────────────────

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const parent = canvas.parentElement;
      if (!parent) return;

      const obs = new ResizeObserver(() => {
        const dpr = window.devicePixelRatio || 1;
        const w = parent.clientWidth;
        const h = parent.clientHeight;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;

        // Initial fit-to-view: scale to fit vertically (arcs stay readable) and
        // center / right-align horizontally so the trunk AND branch arcs are
        // visible. Replaces the old pin-to-right pan that pushed arcs off-screen.
        if (!initialPanApplied.current && zoomRef.current && w > 0 && h > 0) {
          const fit = computeHeadFocusTransform(
            layoutRef.current,
            graph.defaultBranch,
            w,
            h,
          );
          const t = d3.zoomIdentity.translate(fit.x, fit.y).scale(fit.k);
          d3.select(canvas).call(zoomRef.current.transform, t);
          initialPanApplied.current = true;
        }

        redraw();
      });
      obs.observe(parent);
      return () => obs.disconnect();
    }, [redraw]);

    // ── D3 zoom ─────────────────────────────────────────────────────────────

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const zoom = d3
        .zoom<HTMLCanvasElement, unknown>()
        .scaleExtent([0.2, 4])
        .on("start", () => {
          canvas.style.cursor = "grabbing";
        })
        .on("zoom", (event: d3.D3ZoomEvent<HTMLCanvasElement, unknown>) => {
          transformRef.current = event.transform;
          redraw();
        })
        .on("end", () => {
          canvas.style.cursor = "grab";
        });

      zoomRef.current = zoom;
      d3.select(canvas).call(zoom);
      return () => {
        d3.select(canvas).on(".zoom", null);
        zoomRef.current = null;
      };
    }, [redraw]);

    // ── Pointer events ──────────────────────────────────────────────────────

    const handleMouseMove = useCallback(
      (e: React.MouseEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const t = transformRef.current;
        const cx = (e.clientX - rect.left - t.x) / t.k;
        const cy = (e.clientY - rect.top - t.y) / t.k;

        const target = hitRegionAt(regions, cx, cy);
        if (!target) {
          canvas.style.cursor = "grab";
          onHover(null, { x: e.clientX, y: e.clientY });
          return;
        }
        canvas.style.cursor = "pointer";
        const { hover } = resolveTarget(target, branchByName, graph, layout.nodes, cx, trunkSummary);
        onHover(hover, { x: e.clientX, y: e.clientY });
      },
      [regions, branchByName, graph, layout.nodes, onHover, trunkSummary],
    );

    const handleMouseLeave = useCallback(() => {
      const canvas = canvasRef.current;
      if (canvas) canvas.style.cursor = "grab";
      // Don't null immediately — GitCommandCentre uses a 200ms grace period timer
      onHover(null, { x: 0, y: 0 });
    }, [onHover]);

    const handleClick = useCallback(
      (e: React.MouseEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const t = transformRef.current;
        const cx = (e.clientX - rect.left - t.x) / t.k;
        const cy = (e.clientY - rect.top - t.y) / t.k;

        const target = hitRegionAt(regions, cx, cy);
        if (!target) return;
        const { hover, showMore } = resolveTarget(target, branchByName, graph, layout.nodes, cx, trunkSummary);
        if (showMore) { onShowMore?.(); return; }
        if (hover) onClick(hover);
      },
      [regions, branchByName, graph, layout.nodes, onClick, onShowMore, trunkSummary],
    );

    return (
      <canvas
        ref={canvasRef}
        className="w-full h-full cursor-grab"
        role="img"
        aria-label={`Git branch graph: ${branches.length} branches across ${graph.commits.length} commits. Use the Pipeline tab for an accessible, screen-reader-friendly list.`}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
      />
    );
  },
);
