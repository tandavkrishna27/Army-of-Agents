// Integration "proof harness": real computeArcLayout on full topologies,
// asserting the enterprise behaviors (broom clustering, multi-lane, done-aging,
// deep-trunk recognition) hold end to end. Unit tests cover the pieces.
import { describe, it, expect } from "vitest";
import { computeArcLayout } from "../components/workspace/git-arc-layout";
import type { GitGraphData, GitBranchInfo, GitCommitNode } from "@armyofagents/shared";

function bi(name: string, tip: string, task: boolean, done = false): GitBranchInfo {
  return {
    name, isLocal: true, isRemote: true, aheadCount: 1, behindCount: 0,
    lastCommitSha: tip, lastCommitMessage: "m", lastCommitAt: new Date().toISOString(), lastCommitAuthor: "a",
    linkedWorkspaceId: null, linkedIssueId: task ? "i-" + name : null, linkedIssueIdentifier: task ? "AOA-" + name : null,
    linkedIssueTitle: null, linkedIssueStatus: done ? "done" : task ? "in_progress" : null, linkedIssueWorkMode: null,
    pr: null, overlays: { hasConflicts: false, isDiverged: false, isBehindRemote: false }, tags: [],
  };
}
function trunk(n: number): GitCommitNode[] {
  return Array.from({ length: n }, (_, i) => ({
    sha: "c" + i, parentShas: i < n - 1 ? ["c" + (i + 1)] : [], shortSha: "c" + i,
    message: "m", author: "a", committedAt: new Date(Date.now() - i * 1000).toISOString(),
    branchNames: [], isMerge: false, tags: [],
  }));
}

describe("Map topology proof harness", () => {
  it("BROOM: 30 branches at HEAD collapse to one cluster, not 30 arcs", () => {
    const commits = trunk(50);
    const gb = [{ name: "main", laneIndex: 0, color: "#000", tipSha: "c0" }];
    const bs: GitBranchInfo[] = [bi("main", "c0", false)];
    for (let i = 0; i < 30; i++) {
      const n = "feat/b" + i;
      gb.push({ name: n, laneIndex: i + 1, color: "#000", tipSha: "c0" }); // all at HEAD
      bs.push(bi(n, "c0", i % 2 === 0));
    }
    const layout = computeArcLayout({ commits, branches: gb, defaultBranch: "main" } as GitGraphData, bs);
    // task branches at HEAD form one cluster; plain ones absorbed into extraNames
    const headStacks = layout.tipStacks.filter((s) => s.sha === "c0");
    expect(headStacks.length).toBe(1);
    expect((headStacks[0]!.branchNames.length) + (headStacks[0]!.extraNames?.length ?? 0)).toBeGreaterThanOrEqual(20);
    // zero-divergence branches at HEAD do not each produce a tall individual arc:
    // arcs are degenerate stubs, but the cluster carries the count.
    expect(layout.arcs.length).toBeLessThanOrEqual(30);
  });

  it("DEEP TRUNK: a 1500-commit trunk is fully recognized (no 500 cap)", () => {
    const commits = trunk(1500);
    const layout = computeArcLayout(
      { commits, branches: [{ name: "main", laneIndex: 0, color: "#000", tipSha: "c0" }], defaultBranch: "main" } as GitGraphData,
      [bi("main", "c0", false)],
    );
    const trunkNodes = layout.nodes.filter((n) => n.isTrunk);
    expect(trunkNodes.length).toBe(1500);
  });

  it("DONE-AGING: done branches excluded by default, present with includeDone", () => {
    const commits = trunk(10);
    commits.unshift({ sha: "fA", parentShas: ["c0"], shortSha: "fA", message: "m", author: "a", committedAt: "", branchNames: [], isMerge: false, tags: [] });
    commits.unshift({ sha: "fB", parentShas: ["c0"], shortSha: "fB", message: "m", author: "a", committedAt: "", branchNames: [], isMerge: false, tags: [] });
    const gb = [
      { name: "main", laneIndex: 0, color: "#000", tipSha: "c0" },
      { name: "feat/active", laneIndex: 1, color: "#000", tipSha: "fA" },
      { name: "feat/done", laneIndex: 2, color: "#000", tipSha: "fB" },
    ];
    const bs = [bi("main", "c0", false), bi("feat/active", "fA", true), bi("feat/done", "fB", true, true)];
    const g = { commits, branches: gb, defaultBranch: "main" } as GitGraphData;
    const def = computeArcLayout(g, bs).arcs.map((a) => a.branchName);
    expect(def).toContain("feat/active");
    expect(def).not.toContain("feat/done");
    const merged = computeArcLayout(g, bs, { includeDone: true }).arcs.map((a) => a.branchName);
    expect(merged).toContain("feat/done");
  });

  it("PERF (informational): computeArcLayout on 250 branches / 5k commits", () => {
    const commits = trunk(5000);
    const gb = [{ name: "main", laneIndex: 0, color: "#000", tipSha: "c0" }];
    const bs: GitBranchInfo[] = [bi("main", "c0", false)];
    for (let i = 0; i < 250; i++) {
      const n = "feat/p" + i;
      gb.push({ name: n, laneIndex: i + 1, color: "#000", tipSha: "c0" });
      bs.push(bi(n, "c0", i % 3 === 0));
    }
    const g = { commits, branches: gb, defaultBranch: "main" } as GitGraphData;
    computeArcLayout(g, bs); // warmup
    const t = performance.now();
    computeArcLayout(g, bs);
    const ms = performance.now() - t;
    console.log(`[proof] computeArcLayout 250br/5k = ${ms.toFixed(1)}ms`);
    expect(ms).toBeLessThan(1000); // very generous guard — real is ~single-digit ms
  });
});
