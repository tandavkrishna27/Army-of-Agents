/**
 * git-arc-layout.ts — Pure layout functions for the trunk-and-arcs git graph.
 *
 * Zero canvas/DOM dependencies. Fully unit-testable.
 * Imported by GitGraphCanvas.tsx for layout computation.
 */

import type { GitGraphData, GitBranchInfo } from "@armyofagents/shared";

// ---------------------------------------------------------------------------
// Layout constants (exported so canvas drawing code can reference them)
// ---------------------------------------------------------------------------

export const TRUNK_Y = 200;          // trunk vertical centre in layout space
export const PAD_LEFT = 24;          // left padding before first commit
export const X_SPACING = 60;         // horizontal pixels between commits

const BASE_ARC_HEIGHT = 60;          // minimum arc height (px)
const ARC_HEIGHT_PER_COMMIT = 8;     // px added per extra feature commit
const MAX_ARC_HEIGHT = 120;          // maximum arc height (px)

/** How far an open branch's line extends past its tip before the dashed stub. */
export const OPEN_ARC_STUB = 40;

/** Single neutral grey for ALL feature-branch lines and commit dots. Status
 * colour lives ONLY on task cards; the trunk LINE keeps the default-branch blue. */
export const NEUTRAL_GREY = "#7E8AA8";

/** Horizontal/vertical geometry for fanned same-commit task cards. */
export const STACK_MAX_CARDS = 3;
export const STACK_DX = 64;       // cards sit this far right of the shared commit
export const STACK_DY = 40;       // vertical gap between fanned cards
export const STACK_BASE_DY = 34;  // first card's vertical offset above the commit

/** Multi-lane packing: overlapping same-direction arcs are stacked into lanes
 * LANE_GAP apart so they don't draw on top of each other. Lane 0 == the
 * previous single-lane behaviour; each extra lane adds LANE_GAP of arc height.
 * MAX_LANES caps how high a dense pile can grow (adaptive mode handles the rest
 * later). (Phase 3A) */
export const LANE_GAP = 40;
export const MAX_LANES = 5;

export interface TipStack {
  sha: string;
  x: number;
  y: number;
  /** Task branch names sharing this tip commit (length >= 2). These get cards. */
  branchNames: string[];
  /** Non-task (plain) branches at the SAME tip commit. Absorbed into the cluster:
   * counted in the "+N more" pill and suppressed from individual arc/label render,
   * so a "broom" of branches at one commit collapses into one fan + pill instead
   * of spraying labels. (Phase 2A) */
  extraNames?: string[];
}

export interface StackCardPos {
  branchName: string;
  x: number;
  y: number;
}

/** Positions of the (up to STACK_MAX_CARDS) cards fanned upward from a stack. */
export function computeStackCardLayout(stack: TipStack): StackCardPos[] {
  const shown = Math.min(stack.branchNames.length, STACK_MAX_CARDS);
  const out: StackCardPos[] = [];
  for (let i = 0; i < shown; i++) {
    out.push({
      branchName: stack.branchNames[i]!,
      x: stack.x + STACK_DX,
      y: stack.y - STACK_BASE_DY - i * STACK_DY,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ArcCommitLayout {
  sha: string;
  x: number;
  y: number;
  isMerge: boolean;
  /** True if this commit sits on the main trunk line. */
  isTrunk: boolean;
  /**
   * Which arc (feature branch) this commit visually belongs to.
   * Null for trunk commits.
   */
  arcBranchName: string | null;
  /**
   * Set only for TIP commits — the branch whose tip SHA this is.
   * Used for hover-card / label lookup.
   */
  branchName: string | null;
  isTaskTip: boolean;
  isBranchTip: boolean;
  issueStatus: string | null;
  /** True when the branch is done/cancelled — drives 0.15 opacity. */
  isDone: boolean;
  isRemoteOnly: boolean;
  /** True when this is the tip of the default branch (for HEAD label). */
  isDefault: boolean;
  tags: string[];
  laneColor: string;
}

export interface ArcDefinition {
  branchName: string;
  direction: "up" | "down";
  /** X coordinate on trunk where arc originates. */
  branchPointX: number;
  /** X coordinate on trunk where arc merges back. Null = open branch. */
  mergePointX: number | null;
  /** Absolute Y of the arc's peak. */
  apexY: number;
  isOpen: boolean;
  color: string;
  isDone: boolean;
  /**
   * Ordered path points in layout space: branch point on the trunk → each
   * feature commit node (ascending x) → merge point on the trunk (closed) or
   * the tip node + a short stub (open). The line is stroked through these, so
   * commit dots always lie on the line. Length >= 2.
   */
  points: Array<[number, number]>;
}

export interface ArcLayoutResult {
  nodes: ArcCommitLayout[];
  arcs: ArcDefinition[];
  trunkY: number;
  totalWidth: number;
  totalHeight: number;
  /** Groups of >=2 TASK branches sharing a tip commit (rendered as fanned cards). */
  tipStacks: TipStack[];
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Returns the set of SHAs on the default branch using FIRST-PARENT traversal.
 * Must be first-parent only: all-ancestors traversal would pull merged feature
 * commits into the trunk set and break findBranchPoint.
 */
export function findTrunkShas(graph: GitGraphData): Set<string> {
  const defaultBranch = graph.branches.find((b) => b.name === graph.defaultBranch);
  if (!defaultBranch) return new Set();
  const commitMap = new Map(graph.commits.map((c) => [c.sha, c]));
  const result = new Set<string>();
  // Walk the FULL first-parent chain. The visited-set (result.has) bounds a
  // cyclic/malformed parent ref without truncating a deep trunk. The old
  // `guard < 500` dropped older trunk (history loss) and made branches that
  // fork before commit 500 walk to end-of-history in getFeatureCommitShas
  // (O(branches*commits) layout blowup).
  let current: string | undefined = defaultBranch.tipSha;
  while (current && !result.has(current)) {
    result.add(current);
    current = commitMap.get(current)?.parentShas[0];
  }
  return result;
}

/**
 * Walks a feature branch tip backwards until a trunk SHA is found.
 * Returns that SHA as the branch point.
 * Graceful fallback: if no trunk ancestor is reachable, returns the tip itself.
 */
export function findBranchPoint(
  commitMap: Map<string, { sha: string; parentShas: string[] }>,
  trunkShas: Set<string>,
  featureTipSha: string,
): string {
  // BFS to the first trunk ancestor. The visited-set bounds it (can't revisit),
  // so no fixed iteration cap is needed — the old `guard < 500` made a branch
  // with >500 of its own commits fall back to the tip (wrong branch point). (D3)
  const visited = new Set<string>();
  const queue: string[] = [featureTipSha];
  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (visited.has(sha)) continue;
    visited.add(sha);
    if (trunkShas.has(sha)) return sha;
    const commit = commitMap.get(sha);
    if (!commit) continue;
    for (const p of commit.parentShas) {
      if (trunkShas.has(p)) return p;
      if (!visited.has(p)) queue.push(p);
    }
  }
  return featureTipSha; // fallback
}

/**
 * Returns all commit SHAs reachable from featureTipSha that are NOT on trunk.
 * These are the commits that belong to the feature branch arc.
 */
export function getFeatureCommitShas(
  commitMap: Map<string, { sha: string; parentShas: string[] }>,
  trunkShas: Set<string>,
  featureTipSha: string,
): string[] {
  const result: string[] = [];
  const visited = new Set<string>();
  const queue: string[] = [featureTipSha];
  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (visited.has(sha) || trunkShas.has(sha)) continue;
    visited.add(sha);
    result.push(sha);
    const commit = commitMap.get(sha);
    if (commit) {
      for (const p of commit.parentShas) {
        if (!visited.has(p) && !trunkShas.has(p)) queue.push(p);
      }
    }
  }
  return result;
}

/**
 * Finds the merge commit on the trunk that merged the given feature branch.
 * Returns null if the branch is not yet merged.
 */
export function findMergePoint(
  commits: Array<{ sha: string; parentShas: string[]; isMerge: boolean }>,
  trunkShas: Set<string>,
  featureShas: Set<string>,
): string | null {
  for (const commit of commits) {
    if (!commit.isMerge || !trunkShas.has(commit.sha)) continue;
    for (const p of commit.parentShas) {
      if (featureShas.has(p)) return commit.sha;
    }
  }
  return null;
}

/**
 * Arc height in px: base + 8px per feature commit, capped at 120px.
 */
export function computeArcHeight(featureCommitCount: number): number {
  return Math.min(
    BASE_ARC_HEIGHT + ARC_HEIGHT_PER_COMMIT * featureCommitCount,
    MAX_ARC_HEIGHT,
  );
}

/**
 * Assigns up/down directions to feature branches by a stable hash of the branch
 * name (so a branch's lane survives add/remove of OTHER branches).
 */
/** Deterministic 32-bit hash so a branch's lane depends only on its name, not
 * its index in the list. Index parity reshuffled the whole Map when any branch
 * was added/removed; name-hash keeps each branch's lane stable across refreshes.
 * Multi-lane packing (Phase 3) handles balance. */
function branchHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

export function assignArcDirections(
  featureBranches: Array<{ name: string }>,
): Map<string, "up" | "down"> {
  const result = new Map<string, "up" | "down">();
  for (const b of featureBranches) {
    result.set(b.name, (branchHash(b.name) & 1) === 0 ? "up" : "down");
  }
  return result;
}

/** Interval-schedule arcs into vertical lanes PER direction so arcs whose
 * x-ranges overlap land in distinct lanes (the old layout had only up/down, so
 * concurrent branches drew on top of each other). Greedy: sort by start x, put
 * each arc in the lowest lane whose previous arc has already ended. Returns the
 * lane index per branch name. */
export function assignArcLanes(
  arcs: Array<{ branchName: string; direction: "up" | "down"; startX: number; endX: number }>,
): Map<string, number> {
  const result = new Map<string, number>();
  for (const dir of ["up", "down"] as const) {
    const inDir = arcs.filter((a) => a.direction === dir).sort((a, b) => a.startX - b.startX);
    const laneEnds: number[] = []; // laneEnds[i] = endX of the last arc placed in lane i
    for (const a of inDir) {
      let lane = laneEnds.findIndex((end) => end <= a.startX);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(a.endX);
      } else {
        laneEnds[lane] = a.endX;
      }
      result.set(a.branchName, lane);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Internal Y helpers
// ---------------------------------------------------------------------------

/** Y on a closed (merged) arc using sine interpolation. t ∈ [0,1]. */
function closedArcY(t: number, trunkY: number, apexY: number): number {
  return trunkY + Math.sin(t * Math.PI) * (apexY - trunkY);
}

/** Y on an open (rail) arc: curve from branchPoint to railStart, then flat. */
function openArcY(
  commitX: number,
  branchPointX: number,
  railStartX: number,
  trunkY: number,
  apexY: number,
): number {
  if (commitX >= railStartX) return apexY;
  const span = railStartX - branchPointX;
  if (span <= 0) return apexY;
  const t = Math.max(0, Math.min(1, (commitX - branchPointX) / span));
  return trunkY + Math.sin(t * Math.PI * 0.5) * (apexY - trunkY);
}

// ---------------------------------------------------------------------------
// Main layout function
// ---------------------------------------------------------------------------

export function computeArcLayout(
  graph: GitGraphData,
  branches: GitBranchInfo[],
  /** includeDone: keep done/cancelled branches in the arc + lane layout. Default
   * false so hidden done branches don't consume lanes or layout cost; the
   * "Merged" filter passes true to bring them back. (Phase 4A) */
  opts?: { includeDone?: boolean },
): ArcLayoutResult {
  const branchInfoMap = new Map(branches.map((b) => [b.name, b]));

  // X assignment: graph.commits[0] is newest → highest X, last is oldest → lowest X
  const maxIdx = Math.max(0, graph.commits.length - 1);
  const commitXMap = new Map<string, number>();
  graph.commits.forEach((c, idx) => {
    commitXMap.set(c.sha, PAD_LEFT + (maxIdx - idx) * X_SPACING);
  });

  const commitMap = new Map(graph.commits.map((c) => [c.sha, c]));

  // Trunk SHAs (first-parent walk from default tip)
  const trunkShas = findTrunkShas(graph);

  // Done/cancelled branches. Computed up front so they can be excluded from the
  // arc + lane layout by default (they were being built + taking lanes while
  // hidden, pushing visible arcs higher). The Merged filter passes includeDone. (Phase 4A)
  const doneBranches = new Set(
    branches
      .filter((b) => b.linkedIssueStatus === "done" || b.linkedIssueStatus === "cancelled")
      .map((b) => b.name),
  );

  // Feature branches = everything except default (and except done, unless asked).
  const featureBranches = graph.branches.filter(
    (b) => b.name !== graph.defaultBranch && (opts?.includeDone || !doneBranches.has(b.name)),
  );
  const directions = assignArcDirections(featureBranches);
  const remoteOnlyBranches = new Set(
    branches.filter((b) => !b.isLocal && b.isRemote).map((b) => b.name),
  );
  // NOTE: uses lastCommitSha from GitBranchInfo (enriched list) not tipSha from graph.
  // These can diverge if data is stale. A missing task badge is the failure mode.
  // Task tips key off the enriched lastCommitSha, which can be stale vs the
  // graph. If it points at a commit not in the graph, fall back to the graph
  // branch's tipSha so the task card still lands on a real node. (Phase 4D)
  const graphTipByName = new Map(graph.branches.map((b) => [b.name, b.tipSha]));
  const taskTipShas = new Set(
    branches
      .filter((b) => b.linkedIssueId)
      .map((b) =>
        commitMap.has(b.lastCommitSha) ? b.lastCommitSha : graphTipByName.get(b.name) ?? b.lastCommitSha,
      ),
  );

  // tipSha → first branch name (default branch wins for shared tips)
  const tipShaToName = new Map<string, string>();
  for (const gb of graph.branches) {
    if (!tipShaToName.has(gb.tipSha)) tipShaToName.set(gb.tipSha, gb.name);
  }

  // ── Build arc definitions + pre-compute per-commit Y ──────────────────────

  const arcs: ArcDefinition[] = [];
  const shaToArcBranch = new Map<string, string>(); // sha → feature branch name
  const shaToArcY = new Map<string, number>();       // sha → pre-computed Y

  // Pass 1: per-branch geometry. The expensive BFS/merge lookups run ONCE here;
  // pass 2 reuses these to build the arc paths after lanes are assigned.
  const arcData = featureBranches.map((fb) => {
    const direction = directions.get(fb.name) ?? "up";
    const featureCommitShas = getFeatureCommitShas(commitMap, trunkShas, fb.tipSha);
    const branchPointSha = findBranchPoint(commitMap, trunkShas, fb.tipSha);
    const branchPointX = commitXMap.get(branchPointSha) ?? PAD_LEFT;
    const mergePointSha = findMergePoint(graph.commits, trunkShas, new Set(featureCommitShas));
    const mergePointX =
      mergePointSha != null ? (commitXMap.get(mergePointSha) ?? null) : null;
    const xs = featureCommitShas.map((s) => commitXMap.get(s) ?? branchPointX);
    const tipX = xs.length > 0 ? Math.max(...xs) : branchPointX;
    const endX =
      mergePointX != null && mergePointX > branchPointX ? mergePointX : tipX + OPEN_ARC_STUB;
    return { fb, direction, featureCommitShas, branchPointX, mergePointX, endX };
  });

  // Multi-lane: interval-schedule overlapping same-direction arcs into lanes so
  // they don't draw on top of each other (the old up/down 2-lane ceiling).
  const arcLanes = assignArcLanes(
    arcData.map((d) => ({
      branchName: d.fb.name,
      direction: d.direction,
      startX: d.branchPointX,
      endX: d.endX,
    })),
  );

  // Pass 2: build the arc paths using the lane-bumped apex (lane 0 == old apex).
  for (const d of arcData) {
    const fb = d.fb;
    const color = NEUTRAL_GREY;
    const direction = d.direction;
    const isDone = doneBranches.has(fb.name);

    const featureCommitShas = d.featureCommitShas;
    const branchPointX = d.branchPointX;
    const mergePointX = d.mergePointX;

    // Clamp to MAX_LANES-1: MAX_LANES is a lane COUNT (5 lanes => valid indices
    // 0..4). Clamping to MAX_LANES let a dense pile reach index 5, i.e. a 6th
    // lane that overflows the budgeted vertical band.
    const lane = Math.min(arcLanes.get(fb.name) ?? 0, MAX_LANES - 1);
    const arcHeight = computeArcHeight(featureCommitShas.length) + lane * LANE_GAP;
    const apexY = direction === "up" ? TRUNK_Y - arcHeight : TRUNK_Y + arcHeight;

    // Rail starts 60px right of branch point for open arcs
    const railStartX = branchPointX + 60;

    // Compute each feature commit's (x, y) ONCE: record Y by sha (for the
    // node-build pass) and collect the ordered node points (for the arc path).
    const featureNodeXY: Array<[number, number]> = [];
    for (const sha of featureCommitShas) {
      shaToArcBranch.set(sha, fb.name);
      const cx = commitXMap.get(sha) ?? branchPointX;
      let cy: number;
      if (mergePointX != null && mergePointX > branchPointX) {
        const t = (cx - branchPointX) / (mergePointX - branchPointX);
        cy = closedArcY(Math.max(0, Math.min(1, t)), TRUNK_Y, apexY);
      } else {
        cy = openArcY(cx, branchPointX, railStartX, TRUNK_Y, apexY);
      }
      shaToArcY.set(sha, cy);
      featureNodeXY.push([cx, cy]);
    }
    featureNodeXY.sort((a, b) => a[0] - b[0]); // oldest → newest along the arc

    // Assemble the ordered path: branch point → feature nodes → end
    const points: Array<[number, number]> = [[branchPointX, TRUNK_Y]];
    for (const xy of featureNodeXY) points.push(xy);
    if (mergePointX != null && mergePointX > branchPointX) {
      points.push([mergePointX, TRUNK_Y]); // closed arc returns to trunk
    } else if (featureNodeXY.length > 0) {
      // open arc: extend a short flat run past the tip (dashed at draw time)
      const [tipX, tipY] = featureNodeXY[featureNodeXY.length - 1]!;
      points.push([tipX + OPEN_ARC_STUB, tipY]);
    } else {
      // degenerate (no feature commits): a tiny stub off the branch point
      points.push([branchPointX + OPEN_ARC_STUB, apexY]);
    }

    arcs.push({
      branchName: fb.name,
      direction,
      branchPointX,
      mergePointX,
      apexY,
      isOpen: mergePointX == null,
      color,
      isDone,
      points,
    });
  }

  // ── Build nodes ───────────────────────────────────────────────────────────

  const nodes: ArcCommitLayout[] = graph.commits.map((commit) => {
    const isTrunk = trunkShas.has(commit.sha);
    const x = commitXMap.get(commit.sha) ?? PAD_LEFT;
    const arcBranchName = shaToArcBranch.get(commit.sha) ?? null;
    const y = isTrunk ? TRUNK_Y : (shaToArcY.get(commit.sha) ?? TRUNK_Y);

    const tipBranchName = tipShaToName.get(commit.sha) ?? null;
    const tipBranchInfo = tipBranchName ? branchInfoMap.get(tipBranchName) : undefined;

    // All commit dots render neutral grey. The trunk LINE colour is computed
    // separately in the component (drawTrunk) and stays the default-branch blue.
    const laneColor = NEUTRAL_GREY;

    const isDone = arcBranchName
      ? doneBranches.has(arcBranchName)
      : doneBranches.has(graph.defaultBranch);
    const isRemoteOnly = arcBranchName ? remoteOnlyBranches.has(arcBranchName) : false;

    return {
      sha: commit.sha,
      x,
      y,
      isMerge: commit.isMerge,
      isTrunk,
      arcBranchName,
      branchName: tipBranchName,
      isTaskTip: taskTipShas.has(commit.sha),
      isBranchTip: tipShaToName.has(commit.sha),
      issueStatus: (tipBranchInfo?.linkedIssueStatus as string | null | undefined) ?? null,
      isDone,
      isRemoteOnly,
      isDefault: tipBranchName === graph.defaultBranch,
      tags: commit.tags,
      laneColor,
    };
  });

  // ── Same-commit task stacks ───────────────────────────────────────────────
  // Group TASK branches (linkedIssueId) by their tip commit. Two or more on the
  // same commit would collapse into one card; expose them so the component can
  // fan them out instead.
  const nodeBySha = new Map(nodes.map((n) => [n.sha, n]));
  const tasksByTipSha = new Map<string, string[]>();
  const plainByTipSha = new Map<string, string[]>();
  for (const b of branches) {
    if (b.name === graph.defaultBranch) continue; // trunk is not a cluster member
    const map = b.linkedIssueId ? tasksByTipSha : plainByTipSha;
    const list = map.get(b.lastCommitSha) ?? [];
    list.push(b.name);
    map.set(b.lastCommitSha, list);
  }
  const tipStacks: TipStack[] = [];
  for (const [sha, branchNames] of tasksByTipSha) {
    if (branchNames.length < 2) continue;
    const node = nodeBySha.get(sha);
    if (!node) continue;
    // Absorb plain (non-task) branches at the same commit so they don't spray as
    // individual arcs/labels (the "broom"). (Phase 2A/2C)
    tipStacks.push({ sha, x: node.x, y: node.y, branchNames, extraNames: plainByTipSha.get(sha) ?? [] });
  }

  const totalWidth =
    PAD_LEFT * 2 + (graph.commits.length > 0 ? maxIdx * X_SPACING : 400);
  const totalHeight = TRUNK_Y * 2 + MAX_ARC_HEIGHT + 80;

  return { nodes, arcs, trunkY: TRUNK_Y, totalWidth, totalHeight, tipStacks };
}

// ---------------------------------------------------------------------------
// Content bounds — used to fit the whole graph into the viewport on load
// ---------------------------------------------------------------------------

export interface LayoutBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * Bounding box of all drawn content (commit nodes + arc apexes), padded for
 * cards, the labels drawn below cards, and badges drawn to the right.
 * Used by the canvas to compute an initial fit-to-view transform so the trunk
 * AND the branch arcs are both visible (instead of arcs clipping off-screen).
 *
 * Returns a sensible default box when the layout is empty.
 */
export function getLayoutBounds(
  layout: ArcLayoutResult,
  /**
   * When provided, only the trunk and arcs/nodes for these branch names are
   * measured. Critical for repos with many hidden branches: an unfiltered
   * bound would include hundreds of off-window, fallback-positioned arcs and
   * wreck the fit. Trunk nodes are always included (they're the spine).
   */
  visibleBranchNames?: Set<string>,
): LayoutBounds {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const n of layout.nodes) {
    const include =
      n.isTrunk ||
      (n.arcBranchName != null &&
        (!visibleBranchNames || visibleBranchNames.has(n.arcBranchName)));
    if (!include) continue;
    if (n.x < minX) minX = n.x;
    if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.y > maxY) maxY = n.y;
  }
  for (const a of layout.arcs) {
    if (visibleBranchNames && !visibleBranchNames.has(a.branchName)) continue;
    if (a.apexY < minY) minY = a.apexY;
    if (a.apexY > maxY) maxY = a.apexY;
  }
  if (!isFinite(minX)) {
    return { minX: 0, maxX: layout.totalWidth, minY: 0, maxY: layout.totalHeight };
  }
  // Pad for card width/height, the 2 label lines + dots below cards, and badges.
  return {
    minX: minX - 40,
    maxX: maxX + 150,
    minY: minY - 36,
    maxY: maxY + 64,
  };
}

/**
 * Initial transform that opens the Map zoomed near HEAD: scales on height so
 * arcs are readable, then positions the default-branch tip at ~70% of the
 * viewport width so HEAD + nearby active branches are prominent and older
 * history pans off to the left. Falls back to computeFitTransform when there
 * is no default tip.
 */
export function computeHeadFocusTransform(
  layout: ArcLayoutResult,
  defaultBranch: string,
  viewportW: number,
  viewportH: number,
  pad = 32,
): { k: number; x: number; y: number } {
  const headNode = layout.nodes.find(
    (n) => n.isDefault && n.branchName === defaultBranch,
  );
  if (!headNode || viewportW <= 0 || viewportH <= 0) {
    return computeFitTransform(getLayoutBounds(layout), viewportW, viewportH, pad);
  }
  // Height-fit so the trunk ± arc heights are visible.
  // Use the actual tallest arc: multi-lane arcs (Phase 3A) can exceed
  // MAX_ARC_HEIGHT, so a fixed estimate clipped lane-bumped arcs below the
  // viewport. Falls back to MAX_ARC_HEIGHT when there are no arcs.
  const maxArcDev = layout.arcs.reduce(
    (m, a) => Math.max(m, Math.abs(a.apexY - layout.trunkY)),
    MAX_ARC_HEIGHT,
  );
  const contentH = maxArcDev * 2 + 160; // trunk band + tallest arc + cards/labels
  const k = Math.max(0.4, Math.min((viewportH - 2 * pad) / contentH, 1.2));
  // Put HEAD at 70% width; center the trunk vertically.
  const x = viewportW * 0.7 - headNode.x * k;
  const y = viewportH / 2 - layout.trunkY * k;
  return { k, x, y };
}

/**
 * Fit-to-view transform for the canvas.
 *
 * Scales to fit the content VERTICALLY (so arcs keep a readable height — never
 * crushed to fit a long trunk's width), then:
 *   - centers horizontally if the content fits, otherwise
 *   - right-aligns so the newest commits + HEAD + active arcs are visible and
 *     older history pans off the left edge.
 *
 * Returns a d3-style transform { k, x, y } where screenPoint = k*point + (x,y).
 */
export function computeFitTransform(
  bounds: LayoutBounds,
  viewportW: number,
  viewportH: number,
  pad = 32,
): { k: number; x: number; y: number } {
  const bw = bounds.maxX - bounds.minX;
  const bh = bounds.maxY - bounds.minY;
  if (bw <= 0 || bh <= 0 || viewportW <= 0 || viewportH <= 0) {
    return { k: 1, x: pad, y: pad };
  }

  // Scale on HEIGHT so arcs stay readable; clamp to a sane zoom range.
  const kFitHeight = (viewportH - 2 * pad) / bh;
  const k = Math.max(0.2, Math.min(kFitHeight, 1.4));

  const contentW = bw * k;
  let x: number;
  if (contentW <= viewportW - 2 * pad) {
    // Fits horizontally → center.
    x = pad - bounds.minX * k + (viewportW - 2 * pad - contentW) / 2;
  } else {
    // Too wide → right-align (show newest commits + HEAD; history pans left).
    x = viewportW - pad - bounds.maxX * k;
  }

  const contentH = bh * k;
  const y = pad - bounds.minY * k + (viewportH - 2 * pad - contentH) / 2;
  return { k, x, y };
}
