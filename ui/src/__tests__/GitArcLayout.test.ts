import { describe, it, expect } from "vitest";
import type { GitGraphData, GitBranchInfo } from "@armyofagents/shared";
import {
  findTrunkShas,
  findBranchPoint,
  findMergePoint,
  getFeatureCommitShas,
  computeArcHeight,
  assignArcDirections,
  assignArcLanes,
  computeArcLayout,
  getLayoutBounds,
  computeFitTransform,
  computeHeadFocusTransform,
  computeStackCardLayout,
  STACK_MAX_CARDS,
  STACK_DX,
  type LayoutBounds,
} from "../components/workspace/git-arc-layout";
import { polylinePointAt } from "../components/workspace/git-arc-draw";

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
// getFeatureCommitShas  ★ D3 — direct test block added
// ---------------------------------------------------------------------------

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

  it("returns empty array when tip is on trunk", () => {
    const graph = makeGraph();
    const trunkShas = findTrunkShas(graph);
    const commitMap = new Map(graph.commits.map((c) => [c.sha, c]));
    const shas = getFeatureCommitShas(commitMap, trunkShas, "c3");
    expect(shas).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// computeArcHeight
// ---------------------------------------------------------------------------

describe("computeArcHeight", () => {
  it("returns 68px for 1 commit (base 60 + 8×1)", () => {  // ★ D2 — description fixed
    expect(computeArcHeight(1)).toBe(68);
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
  it("assigns deterministic name-hash up/down for 4 branches", () => {
    // Directions key on a stable name hash, not list index. For these four
    // names the hash happens to fold to up/down/up/down (verified directly).
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

  it("open branch produces an arc with isOpen=true", () => {
    // Make a graph where feat/y is NOT merged into main
    const graph: GitGraphData = {
      defaultBranch: "main",
      commits: [
        mkCommit("c2", ["c1"]),
        mkCommit("f1", ["c1"]),
        mkCommit("c1", []),
      ],
      branches: [
        { name: "main",   laneIndex: 0, color: "#6470DC", tipSha: "c2" },
        { name: "feat/y", laneIndex: 1, color: "#4FB67E", tipSha: "f1" },
      ],
    };
    const branches: GitBranchInfo[] = [
      {
        name: "main", lastCommitSha: "c2",
        isLocal: true, isRemote: true, aheadCount: 0, behindCount: 0,
        lastCommitMessage: "", lastCommitAt: "2024-01-01T00:00:00Z", lastCommitAuthor: "test",
        linkedWorkspaceId: null, linkedIssueId: null, linkedIssueIdentifier: null,
        linkedIssueTitle: null, linkedIssueStatus: null, linkedIssueWorkMode: null,
        pr: null, overlays: { hasConflicts: false, isDiverged: false, isBehindRemote: false }, tags: [],
      },
      {
        name: "feat/y", lastCommitSha: "f1",
        isLocal: true, isRemote: true, aheadCount: 0, behindCount: 0,
        lastCommitMessage: "", lastCommitAt: "2024-01-01T00:00:00Z", lastCommitAuthor: "test",
        linkedWorkspaceId: null, linkedIssueId: null, linkedIssueIdentifier: null,
        linkedIssueTitle: null, linkedIssueStatus: null, linkedIssueWorkMode: null,
        pr: null, overlays: { hasConflicts: false, isDiverged: false, isBehindRemote: false }, tags: [],
      },
    ];
    const result = computeArcLayout(graph, branches);
    expect(result.arcs).toHaveLength(1);
    expect(result.arcs[0]!.isOpen).toBe(true);
    expect(result.arcs[0]!.mergePointX).toBeNull();
  });

  it("each feature commit node lies on its arc's points path", () => {
    const graph = makeGraph();
    const branches = makeBranches();
    const result = computeArcLayout(graph, branches);
    const arc = result.arcs.find((a) => a.branchName === "feat/x")!;
    const f1 = result.nodes.find((n) => n.sha === "f1")!;
    const f2 = result.nodes.find((n) => n.sha === "f2")!;
    const onPath = (x: number, y: number) =>
      arc.points.some((p) => Math.abs(p[0] - x) < 0.001 && Math.abs(p[1] - y) < 0.001);
    expect(onPath(f1.x, f1.y)).toBe(true);
    expect(onPath(f2.x, f2.y)).toBe(true);
  });

  it("closed arc path starts and ends on the trunk", () => {
    const graph = makeGraph();
    const branches = makeBranches();
    const result = computeArcLayout(graph, branches);
    const arc = result.arcs.find((a) => a.branchName === "feat/x")!;
    expect(arc.points[0]![1]).toBe(result.trunkY);
    expect(arc.points[arc.points.length - 1]![1]).toBe(result.trunkY);
  });

  it("open arc path starts on the trunk and ends at an off-trunk stub", () => {
    const graph: GitGraphData = {
      defaultBranch: "main",
      commits: [
        mkCommit("c2", ["c1"]),
        mkCommit("f1", ["c1"]),
        mkCommit("c1", []),
      ],
      branches: [
        { name: "main", laneIndex: 0, color: "#6470DC", tipSha: "c2" },
        { name: "feat/y", laneIndex: 1, color: "#4FB67E", tipSha: "f1" },
      ],
    };
    const base: Omit<GitBranchInfo, "name" | "lastCommitSha"> = {
      isLocal: true, isRemote: true, aheadCount: 0, behindCount: 0,
      lastCommitMessage: "", lastCommitAt: "2024-01-01T00:00:00Z", lastCommitAuthor: "test",
      linkedWorkspaceId: null, linkedIssueId: null, linkedIssueIdentifier: null,
      linkedIssueTitle: null, linkedIssueStatus: null, linkedIssueWorkMode: null,
      pr: null, overlays: { hasConflicts: false, isDiverged: false, isBehindRemote: false }, tags: [],
    };
    const branches: GitBranchInfo[] = [
      { ...base, name: "main", lastCommitSha: "c2" },
      { ...base, name: "feat/y", lastCommitSha: "f1" },
    ];
    const result = computeArcLayout(graph, branches);
    const arc = result.arcs.find((a) => a.branchName === "feat/y")!;
    expect(arc.isOpen).toBe(true);
    expect(arc.points[0]![1]).toBe(result.trunkY);
    expect(arc.points[arc.points.length - 1]![1]).not.toBe(result.trunkY);
    expect(arc.points.length).toBeGreaterThanOrEqual(2);
  });

  it("renders feature arcs in neutral grey, not the branch palette colour", () => {
    const graph = makeGraph();
    const branches = makeBranches();
    const result = computeArcLayout(graph, branches);
    const arc = result.arcs.find((a) => a.branchName === "feat/x")!;
    expect(arc.color).toBe("#7E8AA8");
  });

  it("renders every commit dot (trunk and feature) in neutral grey", () => {
    const graph = makeGraph();
    const branches = makeBranches();
    const result = computeArcLayout(graph, branches);
    for (const n of result.nodes) {
      expect(n.laneColor).toBe("#7E8AA8");
    }
  });
});

// ---------------------------------------------------------------------------
// getLayoutBounds
// ---------------------------------------------------------------------------

describe("getLayoutBounds", () => {
  it("covers all node X positions plus right-side padding for cards/badges", () => {
    const graph = makeGraph();
    const branches = makeBranches();
    const layout = computeArcLayout(graph, branches);
    const b = getLayoutBounds(layout);
    const xs = layout.nodes.map((n) => n.x);
    // minX is padded left of the leftmost node; maxX padded well right of the
    // rightmost node (room for card + badges + label).
    expect(b.minX).toBeLessThan(Math.min(...xs));
    expect(b.maxX).toBeGreaterThan(Math.max(...xs) + 100);
  });

  it("vertical bounds span above and below the trunk (arcs go both ways)", () => {
    const graph = makeGraph();
    const branches = makeBranches();
    const layout = computeArcLayout(graph, branches);
    const b = getLayoutBounds(layout);
    expect(b.minY).toBeLessThan(layout.trunkY);
    expect(b.maxY).toBeGreaterThan(layout.trunkY);
  });

  it("with visibleBranchNames, excludes hidden arcs from vertical bounds", () => {
    // feat/x arcs up; if we hide it, bounds should not extend to its apex.
    const graph = makeGraph();
    const branches = makeBranches();
    const layout = computeArcLayout(graph, branches);
    const all = getLayoutBounds(layout);
    const trunkOnly = getLayoutBounds(layout, new Set(["main"]));
    // Hiding feat/x should shrink the vertical span (its apex no longer counts).
    const allSpan = all.maxY - all.minY;
    const trunkSpan = trunkOnly.maxY - trunkOnly.minY;
    expect(trunkSpan).toBeLessThan(allSpan);
  });

  it("falls back to totalWidth/Height for an empty layout", () => {
    const empty: GitGraphData = {
      defaultBranch: "main",
      commits: [],
      branches: [],
    };
    const layout = computeArcLayout(empty, []);
    const b = getLayoutBounds(layout);
    expect(b.minX).toBe(0);
    expect(b.maxX).toBe(layout.totalWidth);
    expect(b.minY).toBe(0);
    expect(b.maxY).toBe(layout.totalHeight);
  });
});

// ---------------------------------------------------------------------------
// computeFitTransform
// ---------------------------------------------------------------------------

describe("computeFitTransform", () => {
  const tallBounds: LayoutBounds = { minX: 0, maxX: 200, minY: 0, maxY: 300 };

  it("centers horizontally when content fits the viewport width", () => {
    // Wide viewport, narrow content → should center, not right-align.
    const t = computeFitTransform({ minX: 0, maxX: 200, minY: 0, maxY: 200 }, 1000, 400);
    // Content width at scale k must be centered: left gap == right gap.
    const k = t.k;
    const contentW = 200 * k;
    const leftGap = t.x; // minX is 0, pad cancels into centering
    const rightGap = 1000 - (t.x + contentW);
    expect(Math.abs(leftGap - rightGap)).toBeLessThan(1);
  });

  it("right-aligns when content is wider than the viewport", () => {
    // Very wide content, narrow viewport → right edge of content near viewport
    // right edge (minus pad), so newest commits + HEAD stay visible.
    const wide: LayoutBounds = { minX: 0, maxX: 5000, minY: 0, maxY: 300 };
    const vw = 800;
    const pad = 32;
    const t = computeFitTransform(wide, vw, 400, pad);
    const rightEdgeOfContent = t.x + wide.maxX * t.k;
    expect(rightEdgeOfContent).toBeCloseTo(vw - pad, 5);
  });

  it("scales on height so arcs keep a readable height (clamped ≤ 1.4)", () => {
    // Short content in a tall viewport would over-zoom without the clamp.
    const t = computeFitTransform({ minX: 0, maxX: 100, minY: 0, maxY: 50 }, 1000, 1000);
    expect(t.k).toBeLessThanOrEqual(1.4);
    expect(t.k).toBeGreaterThan(0);
  });

  it("never scales below the 0.2 floor", () => {
    const t = computeFitTransform({ minX: 0, maxX: 100, minY: 0, maxY: 100000 }, 800, 400);
    expect(t.k).toBeGreaterThanOrEqual(0.2);
  });

  it("returns a safe default for a degenerate (zero-size) box", () => {
    const t = computeFitTransform({ minX: 0, maxX: 0, minY: 0, maxY: 0 }, 800, 400);
    expect(Number.isFinite(t.k)).toBe(true);
    expect(Number.isFinite(t.x)).toBe(true);
    expect(Number.isFinite(t.y)).toBe(true);
  });

  it("uses the tall-bounds height to drive scale", () => {
    const t = computeFitTransform(tallBounds, 1000, 364);
    // (364 - 64) / 300 = 1.0 → k clamps to 1.0
    expect(t.k).toBeCloseTo(1.0, 5);
  });
});

// ---------------------------------------------------------------------------
// computeHeadFocusTransform
// ---------------------------------------------------------------------------

describe("computeHeadFocusTransform", () => {
  it("positions the default-branch tip near 70% of viewport width", () => {
    const graph = makeGraph();
    const branches = makeBranches();
    const layout = computeArcLayout(graph, branches);
    const head = layout.nodes.find((n) => n.isDefault && n.branchName === "main")!;
    const t = computeHeadFocusTransform(layout, "main", 1000, 600);
    const headScreenX = head.x * t.k + t.x;
    expect(headScreenX).toBeCloseTo(700, 0);
  });

  it("falls back to a finite transform when there is no default tip", () => {
    const graph = makeGraph();
    const branches = makeBranches();
    const layout = computeArcLayout(graph, branches);
    const t = computeHeadFocusTransform(layout, "does-not-exist", 1000, 600);
    expect(Number.isFinite(t.k)).toBe(true);
    expect(Number.isFinite(t.x)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// polylinePointAt
// ---------------------------------------------------------------------------

describe("polylinePointAt", () => {
  const line: Array<[number, number]> = [[0, 0], [10, 0], [10, 10]];

  it("returns the first point at t=0 and last at t=1", () => {
    expect(polylinePointAt(line, 0)).toEqual([0, 0]);
    expect(polylinePointAt(line, 1)).toEqual([10, 10]);
  });

  it("returns the midpoint of total length at t=0.5", () => {
    expect(polylinePointAt(line, 0.5)).toEqual([10, 0]);
  });

  it("clamps t outside [0,1]", () => {
    expect(polylinePointAt(line, -1)).toEqual([0, 0]);
    expect(polylinePointAt(line, 2)).toEqual([10, 10]);
  });

  it("handles empty, single-point, and zero-length inputs without throwing", () => {
    expect(polylinePointAt([], 0.5)).toEqual([0, 0]);
    expect(polylinePointAt([[5, 5]], 0.5)).toEqual([5, 5]);
    expect(polylinePointAt([[3, 3], [3, 3]], 0.5)).toEqual([3, 3]);
  });
});

describe("computeArcLayout tipStacks", () => {
  function taskBranch(
    name: string,
    sha: string,
    issueId: string | null,
    identifier: string | null = null,
  ): GitBranchInfo {
    return {
      name, lastCommitSha: sha,
      isLocal: true, isRemote: true, aheadCount: 0, behindCount: 0,
      lastCommitMessage: "", lastCommitAt: "2024-01-01T00:00:00Z", lastCommitAuthor: "t",
      linkedWorkspaceId: null, linkedIssueId: issueId,
      linkedIssueIdentifier: identifier, linkedIssueTitle: null,
      linkedIssueStatus: null, linkedIssueWorkMode: null,
      pr: null, overlays: { hasConflicts: false, isDiverged: false, isBehindRemote: false }, tags: [],
    };
  }

  const graph: GitGraphData = {
    defaultBranch: "main",
    commits: [mkCommit("c2", ["c1"]), mkCommit("c1", [])],
    branches: [
      { name: "main",   laneIndex: 0, color: "#6470DC", tipSha: "c2" },
      { name: "feat/a", laneIndex: 1, color: "#4FB67E", tipSha: "c2" },
      { name: "feat/b", laneIndex: 2, color: "#D9A938", tipSha: "c2" },
    ],
  };

  it("groups multiple task branches sharing a tip commit", () => {
    const branches = [
      taskBranch("main", "c2", null),
      taskBranch("feat/a", "c2", "i1", "AOA-1"),
      taskBranch("feat/b", "c2", "i2", "AOA-2"),
    ];
    const result = computeArcLayout(graph, branches);
    expect(result.tipStacks).toHaveLength(1);
    expect(result.tipStacks[0]!.sha).toBe("c2");
    expect([...result.tipStacks[0]!.branchNames].sort()).toEqual(["feat/a", "feat/b"]);
  });

  it("does not create a stack for a single task branch at a commit", () => {
    const branches = [
      taskBranch("main", "c2", null),
      taskBranch("feat/a", "c2", "i1", "AOA-1"),
    ];
    expect(computeArcLayout(graph, branches).tipStacks).toHaveLength(0);
  });
});

describe("computeStackCardLayout", () => {
  it("fans up to STACK_MAX_CARDS cards upward and to the right", () => {
    const stack = { sha: "x", x: 100, y: 200, branchNames: ["a", "b", "c", "d", "e"] };
    const cards = computeStackCardLayout(stack);
    expect(cards).toHaveLength(STACK_MAX_CARDS);
    expect(cards[0]!.x).toBe(100 + STACK_DX);
    expect(cards[0]!.y).toBeLessThan(200);          // above the commit
    expect(cards[1]!.y).toBeLessThan(cards[0]!.y);  // each higher than the last
  });
});

describe("findTrunkShas full-walk (no 500 guard)", () => {
  function linear(n: number) {
    const commits = Array.from({ length: n }, (_, i) => ({
      sha: "c" + i, parentShas: i < n - 1 ? ["c" + (i + 1)] : [], shortSha: "c" + i,
      message: "m", author: "a", committedAt: new Date(Date.now() - i * 1000).toISOString(),
      branchNames: [], isMerge: false, tags: [],
    }));
    return { commits, branches: [{ name: "main", laneIndex: 0, color: "#000", tipSha: "c0" }], defaultBranch: "main" } as any;
  }
  it("recognizes ALL trunk commits beyond 500", () => {
    expect(findTrunkShas(linear(1200)).size).toBe(1200);
  });
  it("a branch off an old commit resolves a real branch point + bounded feature walk", () => {
    const g = linear(1000);
    g.commits.unshift({ sha: "f0", parentShas: ["c800"], shortSha: "f0", message: "f", author: "a", committedAt: new Date().toISOString(), branchNames: [], isMerge: false, tags: [] });
    g.commits.unshift({ sha: "f1", parentShas: ["f0"], shortSha: "f1", message: "f", author: "a", committedAt: new Date().toISOString(), branchNames: [], isMerge: false, tags: [] });
    const commitMap = new Map(g.commits.map((c: any) => [c.sha, c]));
    const trunk = findTrunkShas(g);
    expect(getFeatureCommitShas(commitMap, trunk, "f1")).toEqual(["f1", "f0"]);
    expect(findBranchPoint(commitMap, trunk, "f1")).toBe("c800");
  });
});

describe("assignArcDirections stability", () => {
  it("adding a branch does not change existing branches' directions", () => {
    const base = ["a", "b", "c", "d", "e"].map((name) => ({ name }));
    const d1 = assignArcDirections(base);
    const d2 = assignArcDirections([{ name: "NEW" }, ...base]);
    for (const { name } of base) expect(d2.get(name)).toBe(d1.get(name));
  });
});

describe("commitClusters absorb plain branches (Phase 2A/2C)", () => {
  function broom(nTasks: number, nPlain: number) {
    const commits = [{ sha: "c0", parentShas: [], shortSha: "c0", message: "m", author: "a", committedAt: new Date().toISOString(), branchNames: [], isMerge: false, tags: [] }];
    const gb = [{ name: "main", laneIndex: 0, color: "#000", tipSha: "c0" }];
    const bi = (name: string, task: boolean) => ({
      name, isLocal: true, isRemote: true, aheadCount: 0, behindCount: 0,
      lastCommitSha: "c0", lastCommitMessage: "m", lastCommitAt: new Date().toISOString(), lastCommitAuthor: "a",
      linkedWorkspaceId: null, linkedIssueId: task ? "i" + name : null, linkedIssueIdentifier: task ? "AOA-" + name : null,
      linkedIssueTitle: null, linkedIssueStatus: task ? "in_progress" : null, linkedIssueWorkMode: null,
      pr: null, overlays: { hasConflicts: false, isDiverged: false, isBehindRemote: false }, tags: [],
    });
    const branches = [bi("main", false)];
    for (let i = 0; i < nTasks; i++) { const n = "feat/t" + i; gb.push({ name: n, laneIndex: gb.length, color: "#000", tipSha: "c0" }); branches.push(bi(n, true)); }
    for (let i = 0; i < nPlain; i++) { const n = "feat/p" + i; gb.push({ name: n, laneIndex: gb.length, color: "#000", tipSha: "c0" }); branches.push(bi(n, false)); }
    return { graph: { commits, branches: gb, defaultBranch: "main" } as any, branches: branches as any };
  }
  it("a task stack absorbs co-located plain branches into extraNames (not the default branch)", () => {
    const { graph, branches } = broom(2, 3);
    const layout = computeArcLayout(graph, branches);
    expect(layout.tipStacks.length).toBe(1);
    expect(layout.tipStacks[0]!.branchNames.length).toBe(2);
    expect(layout.tipStacks[0]!.extraNames?.length).toBe(3);
    expect(layout.tipStacks[0]!.extraNames).not.toContain("main");
  });
});

describe("assignArcLanes (multi-lane packing)", () => {
  it("overlapping same-direction arcs get distinct lanes", () => {
    const m = assignArcLanes([
      { branchName: "a", direction: "down", startX: 0, endX: 100 },
      { branchName: "b", direction: "down", startX: 50, endX: 150 },
      { branchName: "c", direction: "down", startX: 80, endX: 200 },
    ]);
    expect(new Set([m.get("a"), m.get("b"), m.get("c")]).size).toBe(3);
  });
  it("non-overlapping arcs reuse lane 0", () => {
    const m = assignArcLanes([
      { branchName: "a", direction: "down", startX: 0, endX: 50 },
      { branchName: "b", direction: "down", startX: 60, endX: 100 },
    ]);
    expect(m.get("a")).toBe(0);
    expect(m.get("b")).toBe(0);
  });
  it("up and down lanes are independent", () => {
    const m = assignArcLanes([
      { branchName: "u", direction: "up", startX: 0, endX: 100 },
      { branchName: "d", direction: "down", startX: 0, endX: 100 },
    ]);
    expect(m.get("u")).toBe(0);
    expect(m.get("d")).toBe(0);
  });
});

describe("done-branch aging (Phase 4A)", () => {
  function g(statuses: Array<string | null>) {
    const commits = [{ sha: "c0", parentShas: [], shortSha: "c0", message: "m", author: "a", committedAt: new Date().toISOString(), branchNames: [], isMerge: false, tags: [] }];
    // each feature branch gets a unique commit off c0 so it forms a real arc
    const gb = [{ name: "main", laneIndex: 0, color: "#000", tipSha: "c0" }];
    const bs: any[] = [{ name: "main", isLocal: true, isRemote: true, aheadCount: 0, behindCount: 0, lastCommitSha: "c0", lastCommitMessage: "m", lastCommitAt: "", lastCommitAuthor: "a", linkedWorkspaceId: null, linkedIssueId: null, linkedIssueIdentifier: null, linkedIssueTitle: null, linkedIssueStatus: null, linkedIssueWorkMode: null, pr: null, overlays: { hasConflicts: false, isDiverged: false, isBehindRemote: false }, tags: [] }];
    statuses.forEach((st, i) => {
      const fsha = "f" + i;
      commits.unshift({ sha: fsha, parentShas: ["c0"], shortSha: fsha, message: "m", author: "a", committedAt: new Date().toISOString(), branchNames: [], isMerge: false, tags: [] });
      const name = "feat/" + i;
      gb.push({ name, laneIndex: i + 1, color: "#000", tipSha: fsha });
      bs.push({ name, isLocal: true, isRemote: true, aheadCount: 1, behindCount: 0, lastCommitSha: fsha, lastCommitMessage: "m", lastCommitAt: "", lastCommitAuthor: "a", linkedWorkspaceId: null, linkedIssueId: "i" + i, linkedIssueIdentifier: "AOA-" + i, linkedIssueTitle: null, linkedIssueStatus: st, linkedIssueWorkMode: null, pr: null, overlays: { hasConflicts: false, isDiverged: false, isBehindRemote: false }, tags: [] });
    });
    return { graph: { commits, branches: gb, defaultBranch: "main" } as any, branches: bs };
  }
  it("excludes done/cancelled branches from arcs by default", () => {
    const { graph, branches } = g(["in_progress", "done", "cancelled"]);
    const arcs = computeArcLayout(graph, branches).arcs.map((a) => a.branchName);
    expect(arcs).toContain("feat/0");
    expect(arcs).not.toContain("feat/1");
    expect(arcs).not.toContain("feat/2");
  });
  it("includes them when includeDone is set (Merged filter)", () => {
    const { graph, branches } = g(["in_progress", "done"]);
    const arcs = computeArcLayout(graph, branches, { includeDone: true }).arcs.map((a) => a.branchName);
    expect(arcs).toContain("feat/0");
    expect(arcs).toContain("feat/1");
  });
});
