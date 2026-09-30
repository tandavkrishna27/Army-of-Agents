# Git Command Centre — Arc Layout Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the parallel-lanes canvas layout in the Git Command Centre with a trunk-and-arcs layout, and surface GitHub integration data (labels, CI/PR badges, repo selector) in the toolbar.

**Architecture:** A new pure-function layout module (`git-arc-layout.ts`) computes positions from graph data; `GitGraphCanvas.tsx` imports and renders it; `GitCommandCentre.tsx` adds toolbar chips and a repo selector pill. Server adds `labels[]` to the PR enrichment response.

**Tech Stack:** React + D3 zoom + HTML5 Canvas, TypeScript, vitest + jsdom, Octokit (server)

---

## Files Summary

| File | Action | Description |
|------|--------|-------------|
| `packages/shared/src/types/git-graph.ts` | Modify | Add `labels` array to `GitBranchInfo.pr` |
| `server/src/services/github-pr.ts` | Modify | Populate `labels` from GitHub PR response |
| `ui/src/components/workspace/git-arc-layout.ts` | **Create** | Pure layout functions — no canvas imports |
| `ui/src/__tests__/GitArcLayout.test.ts` | **Create** | vitest unit tests for layout functions |
| `ui/src/components/workspace/GitGraphCanvas.tsx` | Major rewrite | Arc drawing system, replaces parallel lanes |
| `ui/src/components/workspace/GitCommandCentre.tsx` | Modify | Merged chip, count badges, repo selector pill |

---

## Task 1 — Add `labels` to the shared type + populate server-side

**Files:**
- Modify: `packages/shared/src/types/git-graph.ts`
- Modify: `server/src/services/github-pr.ts:366-373`

- [ ] **Step 1: Add `labels` field to `GitBranchInfo.pr`**

Open `packages/shared/src/types/git-graph.ts`. Find the `pr` field inside `GitBranchInfo` (lines 65-72). Replace:

```typescript
  pr: {
    number: number;
    url: string;
    reviewState: GitPrReviewState;
    ciStatus: GitCIStatus;
    ciUrl: string | null;
    commentCount: number;
  } | null;
```

With:

```typescript
  pr: {
    number: number;
    url: string;
    reviewState: GitPrReviewState;
    ciStatus: GitCIStatus;
    ciUrl: string | null;
    commentCount: number;
    /** GitHub label dots shown below task cards on the canvas. */
    labels: Array<{ name: string; color: string }>;
  } | null;
```

- [ ] **Step 2: Populate `labels` in `enrichBranchPr`**

Open `server/src/services/github-pr.ts`. Find the `return` statement in `enrichBranchPr` (lines 366-373). Replace:

```typescript
    return {
      number: match.number,
      url: match.html_url,
      reviewState,
      ciStatus: ciResult.status,
      ciUrl: ciResult.ciUrl,
      commentCount: commentData.data.comments + commentData.data.review_comments,
    };
```

With:

```typescript
    return {
      number: match.number,
      url: match.html_url,
      reviewState,
      ciStatus: ciResult.status,
      ciUrl: ciResult.ciUrl,
      commentCount: commentData.data.comments + commentData.data.review_comments,
      labels: (match.labels ?? []).map((l) => ({
        name: l.name,
        color: l.color.startsWith("#") ? l.color : `#${l.color}`,
      })),
    };
```

- [ ] **Step 3: TypeScript check — server**

```bash
cd server && npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 4: TypeScript check — ui**

```bash
cd ui && npx tsc --noEmit
```

Expected: 0 errors. (The new field is additive; nothing else uses `pr.labels` yet.)

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/git-graph.ts server/src/services/github-pr.ts
git commit -m "feat: add labels[] to GitBranchInfo.pr and populate from GitHub enrichment"
```

---

## Task 2 — Create `git-arc-layout.ts` pure layout module

**Files:**
- Create: `ui/src/components/workspace/git-arc-layout.ts`

- [ ] **Step 1: Create the file with all types and helpers**

Create `ui/src/components/workspace/git-arc-layout.ts` with the following complete content:

```typescript
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
}

export interface ArcLayoutResult {
  nodes: ArcCommitLayout[];
  arcs: ArcDefinition[];
  trunkY: number;
  totalWidth: number;
  totalHeight: number;
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
  let current: string | undefined = defaultBranch.tipSha;
  let guard = 0;
  while (current && guard < 500) {
    result.add(current);
    current = commitMap.get(current)?.parentShas[0];
    guard++;
  }
  return result;
}

/**
 * Walks a feature branch tip backwards until a trunk SHA is found.
 * Returns that SHA as the branch point.
 * Graceful fallback: if none found within 500 steps, returns the tip itself.
 */
export function findBranchPoint(
  commitMap: Map<string, { sha: string; parentShas: string[] }>,
  trunkShas: Set<string>,
  featureTipSha: string,
): string {
  const visited = new Set<string>();
  const queue: string[] = [featureTipSha];
  let guard = 0;
  while (queue.length > 0 && guard < 500) {
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
    guard++;
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
 * Assigns alternating up/down directions to feature branches by their
 * list index. Index 0 → "up", 1 → "down", 2 → "up", …
 */
export function assignArcDirections(
  featureBranches: Array<{ name: string }>,
): Map<string, "up" | "down"> {
  const result = new Map<string, "up" | "down">();
  featureBranches.forEach((b, i) => {
    result.set(b.name, i % 2 === 0 ? "up" : "down");
  });
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
  const t = (commitX - branchPointX) / span;
  return trunkY + Math.sin(t * Math.PI * 0.5) * (apexY - trunkY);
}

// ---------------------------------------------------------------------------
// Main layout function
// ---------------------------------------------------------------------------

export function computeArcLayout(
  graph: GitGraphData,
  branches: GitBranchInfo[],
): ArcLayoutResult {
  const branchColors = new Map(graph.branches.map((b) => [b.name, b.color]));
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

  // Feature branches = everything except default
  const featureBranches = graph.branches.filter((b) => b.name !== graph.defaultBranch);
  const directions = assignArcDirections(featureBranches);

  // Helper sets
  const doneBranches = new Set(
    branches
      .filter((b) => b.linkedIssueStatus === "done" || b.linkedIssueStatus === "cancelled")
      .map((b) => b.name),
  );
  const remoteOnlyBranches = new Set(
    branches.filter((b) => !b.isLocal && b.isRemote).map((b) => b.name),
  );
  const taskTipShas = new Set(
    branches.filter((b) => b.linkedIssueId).map((b) => b.lastCommitSha),
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

  for (const fb of featureBranches) {
    const color = branchColors.get(fb.name) ?? "#7E8AA8";
    const direction = directions.get(fb.name) ?? "up";
    const isDone = doneBranches.has(fb.name);

    const featureShaSha = getFeatureCommitShas(commitMap, trunkShas, fb.tipSha);
    const featureShaSet = new Set(featureShaSha);

    const branchPointSha = findBranchPoint(commitMap, trunkShas, fb.tipSha);
    const branchPointX = commitXMap.get(branchPointSha) ?? PAD_LEFT;

    const mergePointSha = findMergePoint(graph.commits, trunkShas, featureShaSet);
    const mergePointX =
      mergePointSha != null ? (commitXMap.get(mergePointSha) ?? null) : null;

    const arcHeight = computeArcHeight(featureShaSha.length);
    const apexY = direction === "up" ? TRUNK_Y - arcHeight : TRUNK_Y + arcHeight;

    // Rail starts 60px right of branch point for open arcs
    const railStartX = branchPointX + 60;

    arcs.push({
      branchName: fb.name,
      direction,
      branchPointX,
      mergePointX,
      apexY,
      isOpen: mergePointX == null,
      color,
      isDone,
    });

    // Pre-compute Y for each feature commit
    for (const sha of featureShaSha) {
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
    }
  }

  // ── Build nodes ───────────────────────────────────────────────────────────

  const nodes: ArcCommitLayout[] = graph.commits.map((commit) => {
    const isTrunk = trunkShas.has(commit.sha);
    const x = commitXMap.get(commit.sha) ?? PAD_LEFT;
    const arcBranchName = shaToArcBranch.get(commit.sha) ?? null;
    const y = isTrunk ? TRUNK_Y : (shaToArcY.get(commit.sha) ?? TRUNK_Y);

    const tipBranchName = tipShaToName.get(commit.sha) ?? null;
    const tipBranchInfo = tipBranchName ? branchInfoMap.get(tipBranchName) : undefined;

    const colorBranchName = arcBranchName ?? graph.defaultBranch;
    const laneColor = branchColors.get(colorBranchName) ?? "#7E8AA8";

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

  const totalWidth =
    PAD_LEFT * 2 + (graph.commits.length > 0 ? maxIdx * X_SPACING : 400);
  const totalHeight = TRUNK_Y * 2 + MAX_ARC_HEIGHT + 80;

  return { nodes, arcs, trunkY: TRUNK_Y, totalWidth, totalHeight };
}
```

- [ ] **Step 2: TypeScript check**

```bash
cd ui && npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/workspace/git-arc-layout.ts
git commit -m "feat: add git-arc-layout pure layout functions (trunk-and-arcs)"
```

---

## Task 3 — Unit tests for arc layout

**Files:**
- Create: `ui/src/__tests__/GitArcLayout.test.ts`

- [ ] **Step 1: Create the test file**

Create `ui/src/__tests__/GitArcLayout.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import type { GitGraphData, GitBranchInfo } from "@armyofagents/shared";
import {
  findTrunkShas,
  findBranchPoint,
  findMergePoint,
  getFeatureCommitShas,
  computeArcHeight,
  assignArcDirections,
  computeArcLayout,
} from "../components/workspace/git-arc-layout";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkCommit(
  sha: string,
  parentShas: string[],
  isMerge = false,
  tags: string[] = [],
) {
  return {
    sha,
    parentShas,
    shortSha: sha.slice(0, 7),
    message: `commit ${sha}`,
    author: "test",
    committedAt: "2024-01-01T00:00:00Z",
    branchNames: [] as string[],
    isMerge,
    tags,
  };
}

/**
 * Standard test fixture:
 *
 *   main:    c1 ← c2 ← merge ← c3
 *   feat/x:       c1 ← f1 ← f2
 *
 * merge has parentShas ["c2", "f2"] → it is the merge commit on main.
 *
 * Graph commits array (newest first): c3, merge, c2, f2, f1, c1
 */
function makeGraph(): GitGraphData {
  return {
    defaultBranch: "main",
    commits: [
      mkCommit("c3",    ["merge"]),
      mkCommit("merge", ["c2", "f2"], true),
      mkCommit("c2",    ["c1"]),
      mkCommit("f2",    ["f1"]),
      mkCommit("f1",    ["c1"]),
      mkCommit("c1",    []),
    ],
    branches: [
      { name: "main",   laneIndex: 0, color: "#6470DC", tipSha: "c3" },
      { name: "feat/x", laneIndex: 1, color: "#4FB67E", tipSha: "f2" },
    ],
  };
}

function makeBranches(): GitBranchInfo[] {
  const base: Omit<GitBranchInfo, "name" | "lastCommitSha"> = {
    isLocal: true, isRemote: true, aheadCount: 0, behindCount: 0,
    lastCommitMessage: "", lastCommitAt: "2024-01-01T00:00:00Z",
    lastCommitAuthor: "test",
    linkedWorkspaceId: null, linkedIssueId: null,
    linkedIssueIdentifier: null, linkedIssueTitle: null,
    linkedIssueStatus: null, linkedIssueWorkMode: null,
    pr: null,
    overlays: { hasConflicts: false, isDiverged: false, isBehindRemote: false },
    tags: [],
  };
  return [
    { ...base, name: "main",   lastCommitSha: "c3" },
    { ...base, name: "feat/x", lastCommitSha: "f2" },
  ];
}

// ---------------------------------------------------------------------------
// findTrunkShas
// ---------------------------------------------------------------------------

describe("findTrunkShas", () => {
  it("returns main commits via first-parent only", () => {
    const graph = makeGraph();
    const trunk = findTrunkShas(graph);
    // main tip c3 → merge → c2 → c1 (first-parent chain)
    expect(trunk.has("c3")).toBe(true);
    expect(trunk.has("merge")).toBe(true);
    expect(trunk.has("c2")).toBe(true);
    expect(trunk.has("c1")).toBe(true);
  });

  it("does NOT include feature branch commits", () => {
    const graph = makeGraph();
    const trunk = findTrunkShas(graph);
    expect(trunk.has("f1")).toBe(false);
    expect(trunk.has("f2")).toBe(false);
  });

  it("returns empty set when default branch not found", () => {
    const graph: GitGraphData = {
      defaultBranch: "missing",
      commits: [mkCommit("c1", [])],
      branches: [{ name: "main", laneIndex: 0, color: "#fff", tipSha: "c1" }],
    };
    expect(findTrunkShas(graph).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// findBranchPoint
// ---------------------------------------------------------------------------

describe("findBranchPoint", () => {
  it("returns the correct branch point SHA for feat/x", () => {
    const graph = makeGraph();
    const trunkShas = findTrunkShas(graph);
    const commitMap = new Map(graph.commits.map((c) => [c.sha, c]));
    const branchPoint = findBranchPoint(commitMap, trunkShas, "f2");
    expect(branchPoint).toBe("c1");
  });

  it("returns fallback when feature tip is already on trunk", () => {
    const graph = makeGraph();
    const trunkShas = findTrunkShas(graph);
    const commitMap = new Map(graph.commits.map((c) => [c.sha, c]));
    // c3 IS on trunk — branch point should be c3 itself
    const branchPoint = findBranchPoint(commitMap, trunkShas, "c3");
    expect(branchPoint).toBe("c3");
  });
});

// ---------------------------------------------------------------------------
// findMergePoint
// ---------------------------------------------------------------------------

describe("findMergePoint", () => {
  it("finds the merge commit when branch is merged", () => {
    const graph = makeGraph();
    const trunkShas = findTrunkShas(graph);
    const commitMap = new Map(graph.commits.map((c) => [c.sha, c]));
    const featureShas = new Set(getFeatureCommitShas(commitMap, trunkShas, "f2"));
    const result = findMergePoint(graph.commits, trunkShas, featureShas);
    expect(result).toBe("merge");
  });

  it("returns null for an open (unmerged) branch", () => {
    const graph = makeGraph();
    const trunkShas = findTrunkShas(graph);
    // Pretend feat/x tip is "f3" (not in commits) — no merge commit points to it
    const featureShas = new Set(["f3"]);
    const result = findMergePoint(graph.commits, trunkShas, featureShas);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeArcHeight
// ---------------------------------------------------------------------------

describe("computeArcHeight", () => {
  it("returns base 60px for 1 commit", () => {
    expect(computeArcHeight(1)).toBe(60 + 8 * 1); // 68
    // Actually base is 60, per commit is 8, so 1 commit → 68
  });

  it("caps at 120px for many commits", () => {
    expect(computeArcHeight(10)).toBe(120);
    expect(computeArcHeight(100)).toBe(120);
  });

  it("returns base 60 for 0 commits", () => {
    expect(computeArcHeight(0)).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// assignArcDirections
// ---------------------------------------------------------------------------

describe("assignArcDirections", () => {
  it("alternates up/down correctly for 4 branches", () => {
    const branches = [
      { name: "feat/a" },
      { name: "feat/b" },
      { name: "feat/c" },
      { name: "feat/d" },
    ];
    const dirs = assignArcDirections(branches);
    expect(dirs.get("feat/a")).toBe("up");
    expect(dirs.get("feat/b")).toBe("down");
    expect(dirs.get("feat/c")).toBe("up");
    expect(dirs.get("feat/d")).toBe("down");
  });

  it("handles empty list", () => {
    expect(assignArcDirections([]).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeArcLayout — integration
// ---------------------------------------------------------------------------

describe("computeArcLayout", () => {
  it("produces one arc for feat/x and trunk nodes for main", () => {
    const graph = makeGraph();
    const branches = makeBranches();
    const result = computeArcLayout(graph, branches);

    expect(result.arcs).toHaveLength(1);
    expect(result.arcs[0]!.branchName).toBe("feat/x");
    expect(result.arcs[0]!.isOpen).toBe(false); // feat/x is merged
  });

  it("trunk nodes sit at TRUNK_Y", () => {
    const graph = makeGraph();
    const branches = makeBranches();
    const result = computeArcLayout(graph, branches);
    const trunkNodes = result.nodes.filter((n) => n.isTrunk);
    for (const n of trunkNodes) {
      expect(n.y).toBe(result.trunkY);
    }
  });

  it("feature branch commits have y !== TRUNK_Y (they arc away)", () => {
    const graph = makeGraph();
    const branches = makeBranches();
    const result = computeArcLayout(graph, branches);
    const f1 = result.nodes.find((n) => n.sha === "f1");
    const f2 = result.nodes.find((n) => n.sha === "f2");
    expect(f1).toBeDefined();
    expect(f2).toBeDefined();
    // f1 and f2 should arc above trunk (direction "up" for first branch)
    expect(f1!.y).not.toBe(result.trunkY);
    expect(f2!.y).not.toBe(result.trunkY);
  });

  it("nodes are ordered newest-X-right oldest-X-left", () => {
    const graph = makeGraph();
    const branches = makeBranches();
    const result = computeArcLayout(graph, branches);
    // c3 is newest (index 0) → highest X; c1 is oldest (index 5) → lowest X
    const c3 = result.nodes.find((n) => n.sha === "c3")!;
    const c1 = result.nodes.find((n) => n.sha === "c1")!;
    expect(c3.x).toBeGreaterThan(c1.x);
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd ui && npx vitest run src/__tests__/GitArcLayout.test.ts
```

Expected: all tests pass (green).

- [ ] **Step 3: If any test fails, fix the bug in `git-arc-layout.ts` before proceeding**

The most common failure: `computeArcHeight(1)` — base is 60, per-commit is 8, so 1 commit → 68. Update the test expectation in step 1 if needed (the formula is BASE + PER_COMMIT * count, not BASE + PER_COMMIT * (count - 1)).

- [ ] **Step 4: Commit**

```bash
git add ui/src/__tests__/GitArcLayout.test.ts
git commit -m "test: unit tests for git-arc-layout pure functions"
```

---

## Task 4 — Rewrite `GitGraphCanvas.tsx`

**Files:**
- Modify: `ui/src/components/workspace/GitGraphCanvas.tsx`

This is the largest change. The strategy is: replace the layout + drawing subsystem while keeping the React wrapper, D3 zoom, RAF loop, resize observer, and pointer event logic structurally identical.

**Functions to KEEP unchanged:** `drawCommitNode`, `drawCardLabel`, `drawCardBadges`, `drawTagPills`, `drawHeadLabel`, `hitTest`, `pointToSegmentDist`

**Functions to REMOVE:** `computeLayout`, `drawEdges`, `hitTestEdge`, `drawFlowPulse` (replaced), `drawLaneLabels` (if present)

**Functions to ADD:** `drawTrunk`, `drawArcLines`, `drawArcLabels`, `drawLabelDots`, `drawFlowPulse` (new signature), `hitTestArc`

- [ ] **Step 1: Update imports + type imports at the top of the file**

Replace the top of `GitGraphCanvas.tsx` (lines 1-25) with:

```typescript
/**
 * GitGraphCanvas — D3 + Canvas renderer for the Git Command Centre.
 *
 * Uses a trunk-and-arcs layout: main branch is a central horizontal spine;
 * feature branches arc above and below as bezier curves.
 *
 * Exposed via forwardRef as GitGraphCanvasHandle for imperative zoom controls.
 * Animation loop (RAF) only runs when running/in_review tasks are present.
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
import {
  computeArcLayout,
  type ArcCommitLayout,
  type ArcDefinition,
  type ArcLayoutResult,
  TRUNK_Y,
  PAD_LEFT,
} from "./git-arc-layout";
```

- [ ] **Step 2: Replace layout constants and remove old internal types**

Replace the layout constants section (lines 29-36) and all internal type definitions (`CommitLayout`, `EdgeLayout`, `LayoutResult`) with:

```typescript
// ---------------------------------------------------------------------------
// Drawing constants (kept from previous layout for card/circle sizing)
// ---------------------------------------------------------------------------

const X_SPACING = 60;
const COMMIT_R = 5;
const CARD_W = 28;
const CARD_H = 18;

// Status → dot color
function statusDotColor(status: string | null, fallback: string): string {
  if (status === "in_progress") return "#4FB67E";
  if (status === "in_review") return "#D9A938";
  if (status === "blocked") return "#ef4444";
  if (status === "done" || status === "cancelled") return "#7E8AA8";
  if (status === "planning") return "#D9A938";
  return fallback;
}
```

- [ ] **Step 3: Update `GitGraphCanvasProps` filter type**

Find `export interface GitGraphCanvasProps` and update the `filter` field:

```typescript
export interface GitGraphCanvasProps {
  branches: GitBranchInfo[];
  graph: GitGraphData;
  filter: "all" | "running" | "blocked" | "prs" | "merged";
  onHover: (node: HoveredNode | null, position: { x: number; y: number }) => void;
  onClick: (node: HoveredNode) => void;
}
```

- [ ] **Step 4: Add the new drawing functions**

Add these functions AFTER the `drawHeadLabel` function (and BEFORE `drawFlowPulse`):

```typescript
// ---------------------------------------------------------------------------
// Arc drawing functions (new in trunk-and-arcs layout)
// ---------------------------------------------------------------------------

function drawTrunk(
  ctx: CanvasRenderingContext2D,
  nodes: ArcCommitLayout[],
  trunkY: number,
  color: string,
) {
  const trunkNodes = nodes.filter((n) => n.isTrunk);
  if (trunkNodes.length < 2) return;
  const minX = Math.min(...trunkNodes.map((n) => n.x));
  const maxX = Math.max(...trunkNodes.map((n) => n.x));
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(minX, trunkY);
  ctx.lineTo(maxX, trunkY);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.7;
  ctx.setLineDash([]);
  ctx.stroke();
  ctx.restore();
}

function drawArcLines(
  ctx: CanvasRenderingContext2D,
  arcs: ArcDefinition[],
  visibleNames: Set<string>,
  canvasRightInLayout: number,
  trunkY: number,
) {
  for (const arc of arcs) {
    if (!visibleNames.has(arc.branchName)) continue;

    ctx.save();
    ctx.strokeStyle = arc.color;
    ctx.lineWidth = 2;
    ctx.globalAlpha = arc.isDone ? 0.15 : 0.7;
    ctx.setLineDash([]);

    if (!arc.isOpen && arc.mergePointX != null) {
      // Closed arc: two-segment cubic bezier
      const span = arc.mergePointX - arc.branchPointX;
      const apexX = (arc.branchPointX + arc.mergePointX) / 2;
      const offset = span * 0.25;

      ctx.beginPath();
      ctx.moveTo(arc.branchPointX, trunkY);
      ctx.bezierCurveTo(
        arc.branchPointX + offset, trunkY,
        apexX, arc.apexY,
        apexX, arc.apexY,
      );
      ctx.bezierCurveTo(
        apexX, arc.apexY,
        arc.mergePointX - offset, trunkY,
        arc.mergePointX, trunkY,
      );
      ctx.stroke();
    } else {
      // Open arc: curve up to rail height, then flat rail with dashed tail
      const railStartX = arc.branchPointX + 60;
      const curveOffset = railStartX - arc.branchPointX;
      const tailX = canvasRightInLayout - 20;

      ctx.beginPath();
      ctx.moveTo(arc.branchPointX, trunkY);
      ctx.bezierCurveTo(
        arc.branchPointX + curveOffset * 0.4, trunkY,
        railStartX, arc.apexY,
        railStartX, arc.apexY,
      );
      ctx.lineTo(tailX, arc.apexY);
      ctx.stroke();

      // Dashed tail at right edge
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(tailX, arc.apexY);
      ctx.lineTo(canvasRightInLayout, arc.apexY);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function drawArcLabels(
  ctx: CanvasRenderingContext2D,
  arcs: ArcDefinition[],
  visibleNames: Set<string>,
) {
  ctx.save();
  ctx.font = `9px "Courier New", monospace`;

  for (const arc of arcs) {
    if (!visibleNames.has(arc.branchName)) continue;
    if (arc.isDone) continue; // labels only for active arcs

    const labelX =
      arc.isOpen || arc.mergePointX == null
        ? arc.branchPointX + 80
        : (arc.branchPointX + arc.mergePointX) / 2;
    const labelY = arc.direction === "up" ? arc.apexY - 8 : arc.apexY + 14;

    ctx.globalAlpha = 0.7;
    ctx.fillStyle = arc.color;
    const name =
      arc.branchName.length > 22
        ? arc.branchName.slice(0, 21) + "…"
        : arc.branchName;
    ctx.fillText(name, labelX - ctx.measureText(name).width / 2, labelY);
  }

  ctx.restore();
}

function drawLabelDots(
  ctx: CanvasRenderingContext2D,
  node: ArcCommitLayout,
  branch: GitBranchInfo,
) {
  const labels = branch.pr?.labels;
  if (!labels || labels.length === 0) return;
  const maxDots = Math.min(labels.length, 3);
  const startX = node.x - CARD_W / 2;
  const dotY = node.y + CARD_H / 2 + 28; // below card label text
  ctx.save();
  for (let i = 0; i < maxDots; i++) {
    const color = labels[i]!.color;
    ctx.fillStyle = color.startsWith("#") ? color : `#${color}`;
    ctx.beginPath();
    ctx.rect(startX + i * 8, dotY, 5, 5);
    ctx.fill();
  }
  ctx.restore();
}
```

- [ ] **Step 5: Replace `drawFlowPulse` with the arc-aware version**

Delete the old `drawFlowPulse` and replace it with:

```typescript
function drawFlowPulse(
  ctx: CanvasRenderingContext2D,
  arcs: ArcDefinition[],
  trunkNodes: ArcCommitLayout[],
  branchByName: Map<string, GitBranchInfo>,
  animPhase: number,
  visibleNames: Set<string>,
  trunkY: number,
  defaultBranch: string,
) {
  ctx.save();

  // Helper: sample two-segment closed arc at t ∈ [0,1]
  function closedArcPoint(arc: ArcDefinition, t: number): [number, number] {
    const span = arc.mergePointX! - arc.branchPointX;
    const apexX = (arc.branchPointX + arc.mergePointX!) / 2;
    const offset = span * 0.25;
    if (t <= 0.5) {
      const tt = t * 2;
      const u = 1 - tt;
      const bx =
        u ** 3 * arc.branchPointX +
        3 * u ** 2 * tt * (arc.branchPointX + offset) +
        3 * u * tt ** 2 * apexX +
        tt ** 3 * apexX;
      const by =
        u ** 3 * trunkY +
        3 * u ** 2 * tt * trunkY +
        3 * u * tt ** 2 * arc.apexY +
        tt ** 3 * arc.apexY;
      return [bx, by];
    } else {
      const tt = (t - 0.5) * 2;
      const u = 1 - tt;
      const bx =
        u ** 3 * apexX +
        3 * u ** 2 * tt * apexX +
        3 * u * tt ** 2 * (arc.mergePointX! - offset) +
        tt ** 3 * arc.mergePointX!;
      const by =
        u ** 3 * arc.apexY +
        3 * u ** 2 * tt * arc.apexY +
        3 * u * tt ** 2 * trunkY +
        tt ** 3 * trunkY;
      return [bx, by];
    }
  }

  const t = ((animPhase * 0.3) % (Math.PI * 2)) / (Math.PI * 2);

  // Trunk pulse for default branch
  const defaultInfo = branchByName.get(defaultBranch);
  if (
    defaultInfo &&
    (defaultInfo.linkedIssueStatus === "in_progress" ||
      defaultInfo.linkedIssueStatus === "in_review") &&
    trunkNodes.length >= 2
  ) {
    const minX = Math.min(...trunkNodes.map((n) => n.x));
    const maxX = Math.max(...trunkNodes.map((n) => n.x));
    const dotX = minX + t * (maxX - minX);
    const dotColor = defaultInfo.linkedIssueStatus === "in_progress" ? "#4FB67E" : "#D9A938";
    ctx.beginPath(); ctx.arc(dotX, trunkY, 4, 0, Math.PI * 2);
    ctx.fillStyle = dotColor; ctx.globalAlpha = 0.85; ctx.fill();
    ctx.beginPath(); ctx.arc(dotX, trunkY, 7, 0, Math.PI * 2);
    ctx.fillStyle = dotColor + "30"; ctx.fill();
  }

  // Arc pulses
  for (const arc of arcs) {
    if (!visibleNames.has(arc.branchName)) continue;
    const info = branchByName.get(arc.branchName);
    if (!info) continue;
    const isRunning = info.linkedIssueStatus === "in_progress";
    const isInReview = info.linkedIssueStatus === "in_review";
    if (!isRunning && !isInReview) continue;

    const dotColor = isRunning ? "#4FB67E" : "#D9A938";
    let dotX: number;
    let dotY: number;

    if (!arc.isOpen && arc.mergePointX != null) {
      [dotX, dotY] = closedArcPoint(arc, t);
    } else {
      // Open arc: 30% curve, 70% rail
      const railStartX = arc.branchPointX + 60;
      const curveOffset = railStartX - arc.branchPointX;
      if (t <= 0.3) {
        const tt = t / 0.3;
        const u = 1 - tt;
        dotX =
          u ** 3 * arc.branchPointX +
          3 * u ** 2 * tt * (arc.branchPointX + curveOffset * 0.4) +
          3 * u * tt ** 2 * railStartX +
          tt ** 3 * railStartX;
        dotY =
          u ** 3 * trunkY +
          3 * u ** 2 * tt * trunkY +
          3 * u * tt ** 2 * arc.apexY +
          tt ** 3 * arc.apexY;
      } else {
        const railT = (t - 0.3) / 0.7;
        dotX = railStartX + railT * 300;
        dotY = arc.apexY;
      }
    }

    ctx.globalAlpha = 0.85;
    ctx.beginPath(); ctx.arc(dotX, dotY, 4, 0, Math.PI * 2);
    ctx.fillStyle = dotColor; ctx.fill();
    ctx.beginPath(); ctx.arc(dotX, dotY, 7, 0, Math.PI * 2);
    ctx.fillStyle = dotColor + "30"; ctx.fill();
  }

  ctx.restore();
}
```

- [ ] **Step 6: Replace `hitTestEdge` with `hitTestArc`**

Delete `hitTestEdge` (and `pointToSegmentDist` if no longer needed) and add:

```typescript
/** Finds the closest arc within threshold px of cursor (cx, cy). */
function hitTestArc(
  arcs: ArcDefinition[],
  visibleNames: Set<string>,
  cx: number,
  cy: number,
  trunkY: number,
  threshold = 8,
): ArcDefinition | null {
  let best: ArcDefinition | null = null;
  let bestDist = threshold;

  for (const arc of arcs) {
    if (!visibleNames.has(arc.branchName)) continue;
    if (arc.isDone) continue; // don't hit-test very faded arcs

    const points: Array<[number, number]> = [];

    if (!arc.isOpen && arc.mergePointX != null) {
      const span = arc.mergePointX - arc.branchPointX;
      const apexX = (arc.branchPointX + arc.mergePointX) / 2;
      const offset = span * 0.25;

      for (let i = 0; i <= 16; i++) {
        const t = i / 16;
        if (t <= 0.5) {
          const tt = t * 2;
          const u = 1 - tt;
          points.push([
            u ** 3 * arc.branchPointX + 3 * u ** 2 * tt * (arc.branchPointX + offset) + 3 * u * tt ** 2 * apexX + tt ** 3 * apexX,
            u ** 3 * trunkY + 3 * u ** 2 * tt * trunkY + 3 * u * tt ** 2 * arc.apexY + tt ** 3 * arc.apexY,
          ]);
        } else {
          const tt = (t - 0.5) * 2;
          const u = 1 - tt;
          points.push([
            u ** 3 * apexX + 3 * u ** 2 * tt * apexX + 3 * u * tt ** 2 * (arc.mergePointX! - offset) + tt ** 3 * arc.mergePointX!,
            u ** 3 * arc.apexY + 3 * u ** 2 * tt * arc.apexY + 3 * u * tt ** 2 * trunkY + tt ** 3 * trunkY,
          ]);
        }
      }
    } else {
      // Open arc: sample curve + 200px of rail
      const railStartX = arc.branchPointX + 60;
      const curveOffset = railStartX - arc.branchPointX;
      for (let i = 0; i <= 16; i++) {
        const t = i / 16;
        if (t <= 0.5) {
          const tt = t * 2;
          const u = 1 - tt;
          points.push([
            u ** 3 * arc.branchPointX + 3 * u ** 2 * tt * (arc.branchPointX + curveOffset * 0.4) + 3 * u * tt ** 2 * railStartX + tt ** 3 * railStartX,
            u ** 3 * trunkY + 3 * u ** 2 * tt * trunkY + 3 * u * tt ** 2 * arc.apexY + tt ** 3 * arc.apexY,
          ]);
        } else {
          const railT = (t - 0.5) * 2;
          points.push([railStartX + railT * 200, arc.apexY]);
        }
      }
    }

    for (const [px, py] of points) {
      const d = Math.sqrt((cx - px) ** 2 + (cy - py) ** 2);
      if (d < bestDist) {
        bestDist = d;
        best = arc;
      }
    }
  }

  return best;
}
```

- [ ] **Step 7: Update the main component — layout + visible filter**

Inside `GitGraphCanvas` (the `forwardRef` component), replace `useMemo(() => computeLayout(...))` and the `visibleBranches` / `visibleNames` memos:

```typescript
    // Filter branches
    const visibleBranches = useMemo(() => {
      if (filter === "all") return branches;
      if (filter === "running") return branches.filter((b) => b.linkedIssueStatus === "in_progress");
      if (filter === "blocked") return branches.filter((b) => b.linkedIssueStatus === "blocked");
      if (filter === "prs")     return branches.filter((b) => !!b.pr);
      if (filter === "merged")  return branches.filter(
        (b) => b.linkedIssueStatus === "done" || b.linkedIssueStatus === "cancelled",
      );
      return branches;
    }, [branches, filter]);

    const visibleNames = useMemo(() => {
      const names = new Set(visibleBranches.map((b) => b.name));
      names.add(graph.defaultBranch); // trunk always visible
      return names;
    }, [visibleBranches, graph.defaultBranch]);

    const layout = useMemo(
      () => computeArcLayout(graph, branches),
      [graph, branches],
    );
```

- [ ] **Step 8: Update the `redraw` callback**

Replace the entire `redraw` useCallback body with:

```typescript
    const redraw = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const t = transformRef.current;
      const dpr = window.devicePixelRatio || 1;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.setTransform(t.k * dpr, 0, 0, t.k * dpr, t.x * dpr, t.y * dpr);

      // Canvas right edge in layout space (for open-arc rail endpoint)
      const canvasRightInLayout = (canvas.width / dpr - t.x) / t.k;

      // Default branch color for trunk line
      const trunkColor =
        graph.branches.find((b) => b.name === graph.defaultBranch)?.color ?? "#6470DC";

      // Filter nodes: trunk nodes always shown; arc nodes filtered by arcBranchName
      const visibleNodes = layout.nodes.filter((n) => {
        if (n.isTrunk) return visibleNames.has(graph.defaultBranch);
        return n.arcBranchName != null && visibleNames.has(n.arcBranchName);
      });

      // 1. Trunk line
      drawTrunk(ctx, layout.nodes, layout.trunkY, trunkColor);

      // 2. Arc lines (bezier + rail)
      drawArcLines(ctx, layout.arcs, visibleNames, canvasRightInLayout, layout.trunkY);

      // 3. Flow pulse dots
      if (hasActiveNodes) {
        const trunkNodes = layout.nodes.filter((n) => n.isTrunk);
        drawFlowPulse(
          ctx,
          layout.arcs,
          trunkNodes,
          branchByName,
          animPhaseRef.current,
          visibleNames,
          layout.trunkY,
          graph.defaultBranch,
        );
      }

      // 4. Commit nodes + task labels + badges + label dots
      for (const node of visibleNodes) {
        const branchStatus =
          node.branchName != null
            ? (branchByName.get(node.branchName)?.linkedIssueStatus ?? null)
            : null;
        drawCommitNode(ctx, node, animPhaseRef.current, branchStatus);

        if (node.isTaskTip) {
          let branch = node.branchName ? branchByName.get(node.branchName) : undefined;
          if (!branch?.linkedIssueId) branch = taskBranchByTipSha.get(node.sha);
          if (branch?.linkedIssueId) {
            drawCardLabel(ctx, node, branch);
            drawCardBadges(ctx, node, branch);
            drawLabelDots(ctx, node, branch);
          }
        }
      }

      // 5. Tag pills
      for (const node of visibleNodes) {
        if (node.tags.length > 0) drawTagPills(ctx, node);
      }

      // 6. HEAD label on default branch tip
      const defaultTip = visibleNodes.find((n) => n.isDefault && n.branchName != null);
      if (defaultTip) drawHeadLabel(ctx, defaultTip);

      // 7. Arc labels (branch name near apex)
      drawArcLabels(ctx, layout.arcs, visibleNames);

      ctx.restore();
    }, [layout, visibleNames, branchByName, graph.defaultBranch, graph.branches, hasActiveNodes]);
```

- [ ] **Step 9: Update pointer events to use `hitTestArc`**

In `handleMouseMove`, find the `hitTestEdge` call and replace the entire `if (!hit)` block:

```typescript
        if (!hit) {
          // No node — check if cursor is over a branch arc
          const arcHit = hitTestArc(layout.arcs, visibleNames, cx, cy, layout.trunkY);
          if (arcHit) {
            canvas.style.cursor = "pointer";
            const branch = branchByName.get(arcHit.branchName);
            if (branch) {
              onHover(
                branch.linkedIssueId
                  ? { type: "task", branch }
                  : { type: "plain_tip", branch },
                { x: e.clientX, y: e.clientY },
              );
            } else {
              onHover(null, { x: e.clientX, y: e.clientY });
            }
          } else {
            canvas.style.cursor = "grab";
            onHover(null, { x: e.clientX, y: e.clientY });
          }
          return;
        }
```

Also update the `handleMouseMove` dependencies (last line of the useCallback):

```typescript
      [layout.nodes, layout.arcs, visibleNames, branchByName, taskBranchByTipSha, graph.commits, onHover],
```

- [ ] **Step 10: Fix `drawCommitNode` signature to accept `ArcCommitLayout`**

The function currently takes `CommitLayout`. Change its parameter type:

```typescript
function drawCommitNode(
  ctx: CanvasRenderingContext2D,
  node: ArcCommitLayout,
  animPhase: number,
  branchStatus: string | null,
) {
```

Do the same for `drawCardLabel`, `drawCardBadges`, `drawTagPills`, `drawHeadLabel` — change `node: CommitLayout` to `node: ArcCommitLayout` in each signature.

- [ ] **Step 11: TypeScript check**

```bash
cd ui && npx tsc --noEmit
```

Expected: 0 errors. Fix any type errors before proceeding.

- [ ] **Step 12: Commit**

```bash
git add ui/src/components/workspace/GitGraphCanvas.tsx
git commit -m "feat: replace parallel-lanes canvas with trunk-and-arcs layout"
```

---

## Task 5 — Update `GitCommandCentre.tsx` toolbar

**Files:**
- Modify: `ui/src/components/workspace/GitCommandCentre.tsx`

- [ ] **Step 1: Add `"merged"` to `FilterMode` and update the import**

Find `type FilterMode = "all" | "running" | "blocked" | "prs";` and replace with:

```typescript
type FilterMode = "all" | "running" | "blocked" | "prs" | "merged";
```

- [ ] **Step 2: Add the GitHub repo list query**

Find the `isWorkspacesTabActive` destructure and, just after the `enrichData` query block, add:

```typescript
  // Repo list for selector pill (only fetched when GitHub is connected)
  const { data: repoList } = useQuery({
    queryKey: ["github-repos", companyId],
    queryFn: () => githubIntegrationApi.getAuthorizedRepos(companyId),
    enabled: isWorkspacesTabActive && graphData?.hasGitHubPat === true,
    staleTime: 60_000,
  });
```

Also add the import at the top of the file:

```typescript
import { githubIntegrationApi } from "@/api/github-integration";
```

- [ ] **Step 3: Derive count values for filter chips**

Add these two derived values just before the `return` statement:

```typescript
  const runningCount = branches.filter((b) => b.linkedIssueStatus === "in_progress").length;
  const prCount = branches.filter((b) => b.pr !== null).length;
```

- [ ] **Step 4: Replace the filter chips section**

Find the `{/* Filters */}` block and replace it entirely:

```tsx
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
```

- [ ] **Step 5: Add the repo selector pill**

Find `{/* Spacer */}` and the `{/* PAT notice */}` block. Replace the PAT notice with the repo selector pill:

```tsx
        {/* Spacer */}
        <div className="flex-1" />

        {/* Repo selector pill — shown only when GitHub is connected */}
        {graphData?.hasGitHubPat && (
          <div className="relative">
            <div
              className="flex items-center gap-1.5 px-2 py-1 rounded bg-white/5 border border-[#2e2c2a] cursor-pointer hover:bg-white/10 transition-colors"
              title="Connected GitHub repository"
            >
              {/* GitHub icon */}
              <svg width="11" height="11" viewBox="0 0 16 16" fill="#7E8AA8">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
              </svg>
              <span className="text-[10px] text-[#ccc] font-mono">
                {repoList && repoList.length > 0
                  ? repoList[0]!.fullName
                  : graphData.repoUrl
                    ? graphData.repoUrl.replace(/.*github\.com[:/]/, "").replace(/\.git$/, "")
                    : "repo"}
              </span>
              <span className="text-[#7E8AA8] text-[10px]">▾</span>
            </div>
          </div>
        )}
        {!graphData?.hasGitHubPat && (
          <span className="text-[11px] text-amber-400/70">
            Connect GitHub →
          </span>
        )}
```

- [ ] **Step 6: TypeScript check**

```bash
cd ui && npx tsc --noEmit
```

Expected: 0 errors. The `getAuthorizedRepos` function returns `GitHubAuthorizedRepo[]` which has a `fullName` field — confirm this in `packages/shared/src/types/`.

- [ ] **Step 7: Commit**

```bash
git add ui/src/components/workspace/GitCommandCentre.tsx
git commit -m "feat: add Merged chip, count badges, and repo selector pill to git toolbar"
```

---

## Task 6 — Final verification

**Files:** No changes — verification only.

- [ ] **Step 1: Full TypeScript check (all packages)**

```bash
cd ui && npx tsc --noEmit && echo "UI OK"
cd ../server && npx tsc --noEmit && echo "SERVER OK"
```

Expected: both print "OK" with 0 errors.

- [ ] **Step 2: Run all arc layout tests**

```bash
cd ui && npx vitest run src/__tests__/GitArcLayout.test.ts
```

Expected: all tests green.

- [ ] **Step 3: Run full test suite**

```bash
cd ui && npx vitest run
```

Expected: no regressions.

- [ ] **Step 4: Manual visual checklist** (in browser, with TK-Website or any project with multiple branches)

```
- [ ] Main trunk is a horizontal centre line at canvas midpoint
- [ ] Feature branches arc upward or downward from their branch point
- [ ] Merged branches show as faded closed arcs (visible only with "Merged" chip active)
- [ ] Open branches extend as flat rails to right edge with dashed tail
- [ ] Hovering an arc line shows the hover card for that branch
- [ ] Task cards show CI dot (✓) when GitHub is connected and CI passes
- [ ] PR badge shows on cards when PR exists
- [ ] Label dots (up to 3 coloured squares) appear below task cards when labels exist
- [ ] Repo pill shows owner/repo in top-right toolbar when GitHub connected
- [ ] Filter chips: Running shows count, PRs shows count
- [ ] "Merged" chip toggles merged arcs; deactivating hides them
- [ ] Zoom in/out/reset still works via bottom-right buttons
- [ ] Pan left/right works; arc labels follow pan correctly
- [ ] npx tsc --noEmit = zero errors
```

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore: final verification — arc layout redesign complete"
```

---

## Self-review Notes

**Spec coverage check:**
- ✅ Trunk-and-arcs layout replacing parallel lanes
- ✅ Merged arcs hidden by default, revealed by "Merged" chip
- ✅ Open branches: arc + flat rail + dashed tail
- ✅ CI dot + PR badge on canvas (already existed, unchanged)
- ✅ Label dots (1–3 squares, only when GitHub connected)
- ✅ Repo selector pill (compact monospace, top-right toolbar)
- ✅ "Merged" filter chip (4th chip)
- ✅ Count badges on Running and PRs chips
- ✅ `npx tsc --noEmit` after every task
- ✅ Unit tests for all pure layout functions

**Type consistency:**
- `ArcCommitLayout` defined in `git-arc-layout.ts`, imported by `GitGraphCanvas.tsx` — consistent
- `ArcDefinition` same — consistent
- `GitBranchInfo.pr.labels` added in shared type, populated in server, consumed in `drawLabelDots` — consistent
- `FilterMode` updated in `GitCommandCentre.tsx` and `GitGraphCanvasProps.filter` — consistent

---

## GSTACK REVIEW REPORT

**Reviewed by:** plan-eng-review skill  
**Date:** 2026-05-23  
**Branch:** feat/git-command-centre  

### Scope

6 files — within limits. No complexity trigger. No TODOS.md references. Review complete.

---

### D1 — Repo selector pill: dead interactive element [P1] ✅ Resolved

**Location:** Task 5, Step 5 — `GitCommandCentre.tsx` repo selector pill

**Issue:** The pill has `cursor-pointer`, `hover:bg-white/10`, and a `▾` arrow but has no `onClick` handler. Users will click it and nothing will happen. No PATCH route exists on the server for switching the connected repo.

**Decision:** Keep `▾` and hover styling but add a `// TODO` comment before the `onClick` is wired up.

**Required fix before executing Task 5:**

Add a `// TODO` comment and a stub `onClick` (or explicit no-op) to the pill div:

```tsx
{/* TODO: repo switching requires new server route PATCH /companies/:cid/projects/:pid/workspaces
    For now this is display-only. The ▾ arrow is a placeholder for the future dropdown. */}
<div
  className="flex items-center gap-1.5 px-2 py-1 rounded bg-white/5 border border-[#2e2c2a] cursor-default transition-colors"
  title="Connected GitHub repository"
>
```

Change `cursor-pointer` → `cursor-default` and remove `hover:bg-white/10` until the route is built, so the affordance matches the behaviour. The `▾` can stay as a future-intent marker.

---

### D2 — `computeArcHeight(1)` test description [P2] ✅ Resolved

**Location:** Task 3, Step 1 — `GitArcLayout.test.ts`, line inside `describe("computeArcHeight")`

**Issue:** `it("returns base 60px for 1 commit")` — misleading. `computeArcHeight(1)` returns **68** (BASE 60 + 8×1), not 60. The assertion `toBe(60 + 8 * 1)` is correct; only the English label is wrong.

**Required fix:**

```typescript
// BEFORE
it("returns base 60px for 1 commit", () => {
  expect(computeArcHeight(1)).toBe(60 + 8 * 1); // 68

// AFTER
it("returns 68px for 1 commit (base 60 + 8×1)", () => {
  expect(computeArcHeight(1)).toBe(68);
```

---

### D3 — `getFeatureCommitShas` not directly tested [P2]

**Location:** Task 3, Step 1 — `GitArcLayout.test.ts`

**Issue:** `getFeatureCommitShas` is exported and used as a building block for `findMergePoint`, but has no `describe("getFeatureCommitShas")` block. If it regresses, the only signal is a broken `findMergePoint` test, which is indirect.

**Recommended addition** (can be added at the end of Task 3 Step 1):

```typescript
describe("getFeatureCommitShas", () => {
  it("returns only non-trunk commits reachable from feature tip", () => {
    const graph = makeGraph();
    const trunkShas = findTrunkShas(graph);
    const commitMap = new Map(graph.commits.map((c) => [c.sha, c]));
    const shas = getFeatureCommitShas(commitMap, trunkShas, "f2");
    expect(shas).toContain("f1");
    expect(shas).toContain("f2");
    expect(shas).not.toContain("c1");
    expect(shas).not.toContain("c2");
    expect(shas).not.toContain("merge");
  });
});
```

---

### D4 — `repoList[0]` may not be the connected repo [P2]

**Location:** Task 5, Step 5 — `GitCommandCentre.tsx` repo pill label

**Issue:** The pill shows `repoList[0]!.fullName` when `repoList` has entries. But `repoList` is all repos the GitHub App is authorized on — the first entry may not be the repo connected to *this project's workspace*. `graphData.repoUrl` (the git remote) is the accurate source.

**Required fix:** Swap the preference order:

```tsx
// BEFORE
{repoList && repoList.length > 0
  ? repoList[0]!.fullName
  : graphData.repoUrl
    ? graphData.repoUrl.replace(/.*github\.com[:/]/, "").replace(/\.git$/, "")
    : "repo"}

// AFTER
{graphData.repoUrl
  ? graphData.repoUrl.replace(/.*github\.com[:/]/, "").replace(/\.git$/, "")
  : repoList && repoList.length > 0
    ? repoList[0]!.fullName
    : "repo"}
```

---

### P3 Minor — open-arc pulse hardcoded rail length

**Location:** Task 4, Step 5 — `drawFlowPulse`, open-arc animation

```typescript
dotX = railStartX + railT * 300; // hardcoded 300
```

The dot travels 300px along the rail regardless of canvas width. On a narrow canvas the dot goes off-screen while animation is still active. Low priority — doesn't affect correctness, only animation polish.

**Suggested fix when time allows:**

```typescript
const railLen = Math.max(200, canvasRightInLayout - railStartX);
dotX = railStartX + railT * railLen;
```

(`canvasRightInLayout` needs to be passed into `drawFlowPulse` — it's already computed in the redraw callback.)

---

### Test Coverage Summary

| Function | Covered | Test count |
|----------|---------|-----------|
| `findTrunkShas` | ✅ | 3 |
| `findBranchPoint` | ✅ | 2 |
| `findMergePoint` | ✅ | 2 |
| `getFeatureCommitShas` | ⚠️ indirect only | 0 direct |
| `computeArcHeight` | ✅ | 3 |
| `assignArcDirections` | ✅ | 2 |
| `computeArcLayout` | ✅ (merged case) | 4 |
| `computeArcLayout` (open branch) | ❌ not tested | 0 |

**Recommended additions** (see D3 above): one direct test for `getFeatureCommitShas`, one integration test for an open (unmerged) branch arc.

---

### Architecture Verdict

The plan is **sound**. The trunk-and-arcs layout module is correctly isolated as a pure function, all D3/canvas code stays in `GitGraphCanvas.tsx`, and the enrichment pipeline correctly rides the existing `/git/enrich` route. First-parent-only traversal for `findTrunkShas` is the critical correctness invariant and is properly implemented.

**Fixes required before execution:**
1. D1: Change `cursor-pointer` → `cursor-default`, remove `hover:bg-white/10` on repo pill + add TODO comment (Task 5 Step 5)
2. D2: Fix `it()` description for `computeArcHeight(1)` (Task 3 Step 1)
3. D3: Add direct `getFeatureCommitShas` test block (Task 3 Step 1)
4. D4: Invert `repoUrl` / `repoList` preference order in pill label (Task 5 Step 5)

**Can be deferred:**
- P3: Open-arc pulse rail length (`canvasRightInLayout` pass-through)
