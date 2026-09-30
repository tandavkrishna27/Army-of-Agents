import { describe, it, expect } from "vitest";
import type { GitBranchInfo, GitGraphData, GitCommitNode } from "@armyofagents/shared";
import { resolveTarget } from "../components/workspace/GitGraphCanvas";
import type { HitTarget } from "../components/workspace/git-arc-hit";
import type { TrunkSummary } from "../components/workspace/git-tooltip-data";
import type { ArcCommitLayout } from "../components/workspace/git-arc-layout";

function mkBranch(p: Partial<GitBranchInfo> & { name: string }): GitBranchInfo {
  return {
    name: p.name, isLocal: p.isLocal ?? true, isRemote: p.isRemote ?? true,
    aheadCount: p.aheadCount ?? 0, behindCount: p.behindCount ?? 0,
    lastCommitSha: p.lastCommitSha ?? "s", lastCommitMessage: "", lastCommitAt: "",
    lastCommitAuthor: "", linkedWorkspaceId: null,
    linkedIssueId: p.linkedIssueId ?? null, linkedIssueIdentifier: null,
    linkedIssueTitle: null, linkedIssueStatus: null, linkedIssueWorkMode: null,
    pr: null, overlays: { hasConflicts: false, isDiverged: false, isBehindRemote: false }, tags: [],
  };
}

function mkCommit(p: Partial<GitCommitNode> & { sha: string }): GitCommitNode {
  return {
    sha: p.sha, parentShas: p.parentShas ?? [], shortSha: p.sha.slice(0, 7),
    message: p.message ?? "msg", author: p.author ?? "A", committedAt: p.committedAt ?? "",
    branchNames: p.branchNames ?? [], isMerge: p.isMerge ?? false, tags: p.tags ?? [],
  };
}

const minimalGraph: GitGraphData = {
  commits: [mkCommit({ sha: "c1", isMerge: false }), mkCommit({ sha: "m1", isMerge: true })],
  branches: [{ name: "main", laneIndex: 0, color: "#000", tipSha: "c1" }],
  defaultBranch: "main",
};

const trunkSummary: TrunkSummary = {
  commitCount: 10,
  contributorCount: 3,
  activeBranchCount: 5,
  latestCommit: mkCommit({ sha: "c1", message: "latest" }),
};

const layoutNodes: ArcCommitLayout[] = [];
const cx = 0;

describe("resolveTarget — trunkLine", () => {
  it("returns type trunk carrying the passed summary", () => {
    const branchByName = new Map([["main", mkBranch({ name: "main" })]]);
    const target: HitTarget = { kind: "trunkLine" };
    const result = resolveTarget(target, branchByName, minimalGraph, layoutNodes, cx, trunkSummary);
    expect(result.showMore).toBe(false);
    expect(result.hover?.type).toBe("trunk");
    if (result.hover?.type === "trunk") {
      expect(result.hover.summary).toBe(trunkSummary);
      expect(result.hover.summary.commitCount).toBe(10);
    }
  });

  it("handles missing default branch (branch: null)", () => {
    const branchByName = new Map<string, GitBranchInfo>();
    const target: HitTarget = { kind: "trunkLine" };
    const result = resolveTarget(target, branchByName, minimalGraph, layoutNodes, cx, trunkSummary);
    expect(result.hover?.type).toBe("trunk");
    if (result.hover?.type === "trunk") {
      expect(result.hover.branch).toBeNull();
    }
  });
});

describe("resolveTarget — showMore", () => {
  it("returns cluster hover with total=2 and showMore=true", () => {
    const branchByName = new Map([
      ["a", mkBranch({ name: "a" })],
      ["b", mkBranch({ name: "b" })],
    ]);
    const target: HitTarget = { kind: "showMore", branchNames: ["a", "b"] };
    const result = resolveTarget(target, branchByName, minimalGraph, layoutNodes, cx, trunkSummary);
    expect(result.showMore).toBe(true);
    expect(result.hover?.type).toBe("cluster");
    if (result.hover?.type === "cluster") {
      expect(result.hover.total).toBe(2);
      expect(result.hover.branches).toHaveLength(2);
    }
  });

  it("filters out branchNames that are not in branchByName", () => {
    const branchByName = new Map([["a", mkBranch({ name: "a" })]]);
    const target: HitTarget = { kind: "showMore", branchNames: ["a", "missing"] };
    const result = resolveTarget(target, branchByName, minimalGraph, layoutNodes, cx, trunkSummary);
    expect(result.hover?.type).toBe("cluster");
    if (result.hover?.type === "cluster") {
      expect(result.hover.total).toBe(2); // total = branchNames.length
      expect(result.hover.branches).toHaveLength(1); // only "a" found
    }
  });
});

describe("resolveTarget — plainTip (remote_marker vs plain_tip)", () => {
  it("remote-only branch (isLocal:false, isRemote:true) → remote_marker", () => {
    const branchByName = new Map([
      ["origin/hotfix", mkBranch({ name: "origin/hotfix", isLocal: false, isRemote: true })],
    ]);
    const target: HitTarget = { kind: "plainTip", branchName: "origin/hotfix" };
    const result = resolveTarget(target, branchByName, minimalGraph, layoutNodes, cx, trunkSummary);
    expect(result.hover?.type).toBe("remote_marker");
  });

  it("local branch (isLocal:true) → plain_tip", () => {
    const branchByName = new Map([
      ["feat/local", mkBranch({ name: "feat/local", isLocal: true, isRemote: false })],
    ]);
    const target: HitTarget = { kind: "plainTip", branchName: "feat/local" };
    const result = resolveTarget(target, branchByName, minimalGraph, layoutNodes, cx, trunkSummary);
    expect(result.hover?.type).toBe("plain_tip");
  });

  it("missing branch → hover null", () => {
    const target: HitTarget = { kind: "plainTip", branchName: "nonexistent" };
    const result = resolveTarget(target, new Map(), minimalGraph, layoutNodes, cx, trunkSummary);
    expect(result.hover).toBeNull();
    expect(result.showMore).toBe(false);
  });
});

describe("resolveTarget — merge", () => {
  it("carries defaultBranch from graph", () => {
    const branchByName = new Map<string, GitBranchInfo>();
    const target: HitTarget = { kind: "merge", sha: "m1" };
    const result = resolveTarget(target, branchByName, minimalGraph, layoutNodes, cx, trunkSummary);
    expect(result.hover?.type).toBe("merge");
    if (result.hover?.type === "merge") {
      expect(result.hover.defaultBranch).toBe("main");
      expect(result.hover.commit.sha).toBe("m1");
    }
  });

  it("returns null hover when sha not found", () => {
    const target: HitTarget = { kind: "merge", sha: "unknown" };
    const result = resolveTarget(target, new Map(), minimalGraph, layoutNodes, cx, trunkSummary);
    expect(result.hover).toBeNull();
  });
});
