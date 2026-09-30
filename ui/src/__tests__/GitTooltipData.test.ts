import { describe, it, expect } from "vitest";
import type { GitBranchInfo, GitCommitNode, GitGraphData } from "@armyofagents/shared";
import {
  parseMergeMessage,
  isRemoteOnly,
  buildTrunkSummary,
  commitBranchContext,
  pipelineStageRank,
} from "../components/workspace/git-tooltip-data";

function mkBranch(p: Partial<GitBranchInfo> & { name: string }): GitBranchInfo {
  return {
    name: p.name, isLocal: p.isLocal ?? true, isRemote: p.isRemote ?? true,
    aheadCount: p.aheadCount ?? 0, behindCount: p.behindCount ?? 0,
    lastCommitSha: p.lastCommitSha ?? "s", lastCommitMessage: "", lastCommitAt: p.lastCommitAt ?? "",
    lastCommitAuthor: p.lastCommitAuthor ?? "", linkedWorkspaceId: null,
    linkedIssueId: p.linkedIssueId ?? null, linkedIssueIdentifier: null, linkedIssueTitle: null,
    linkedIssueStatus: p.linkedIssueStatus ?? null, linkedIssueWorkMode: null, pr: p.pr ?? null,
    overlays: { hasConflicts: false, isDiverged: false, isBehindRemote: false }, tags: [],
  };
}
function mkCommit(p: Partial<GitCommitNode> & { sha: string }): GitCommitNode {
  return {
    sha: p.sha, parentShas: p.parentShas ?? [], shortSha: p.sha.slice(0, 7),
    message: p.message ?? "", author: p.author ?? "", committedAt: p.committedAt ?? "",
    branchNames: p.branchNames ?? [], isMerge: p.isMerge ?? false, tags: p.tags ?? [],
  };
}

describe("parseMergeMessage", () => {
  it("parses a GitHub PR merge (#num + source)", () => {
    expect(parseMergeMessage("Merge pull request #98 from MeteoriteLabs/feat/login-flow", "main"))
      .toEqual({ source: "feat/login-flow", target: "main", prNumber: 98 });
  });
  it("parses a CLI branch merge with explicit target", () => {
    expect(parseMergeMessage("Merge branch 'feat/x' into develop", "main"))
      .toEqual({ source: "feat/x", target: "develop", prNumber: null });
  });
  it("parses a CLI branch merge without target (defaults to defaultBranch)", () => {
    expect(parseMergeMessage("Merge branch 'feat/x'", "main"))
      .toEqual({ source: "feat/x", target: "main", prNumber: null });
  });
  it("returns nulls for an unrecognized message", () => {
    expect(parseMergeMessage("squash everything", "main"))
      .toEqual({ source: null, target: null, prNumber: null });
  });
});

describe("isRemoteOnly", () => {
  it("true when remote and not local", () => {
    expect(isRemoteOnly(mkBranch({ name: "x", isLocal: false, isRemote: true }))).toBe(true);
  });
  it("false when local", () => {
    expect(isRemoteOnly(mkBranch({ name: "x", isLocal: true, isRemote: true }))).toBe(false);
  });
});

describe("buildTrunkSummary", () => {
  const graph: GitGraphData = {
    commits: [
      mkCommit({ sha: "c2", author: "A" }),
      mkCommit({ sha: "c1", author: "B" }),
      mkCommit({ sha: "c0", author: "A" }),
    ],
    branches: [
      { name: "main", laneIndex: 0, color: "#000", tipSha: "c2" },
      { name: "feat/x", laneIndex: 1, color: "#111", tipSha: "c1" },
    ],
    defaultBranch: "main",
  };
  it("counts commits, unique authors, active (non-default, non-done) branches, and resolves the tip commit", () => {
    const branches = [
      mkBranch({ name: "main" }),
      mkBranch({ name: "feat/x", linkedIssueStatus: "in_progress" }),
      mkBranch({ name: "feat/done", linkedIssueStatus: "done" }),
    ];
    const s = buildTrunkSummary(graph, branches);
    expect(s.commitCount).toBe(3);
    expect(s.contributorCount).toBe(2);          // A, B
    expect(s.activeBranchCount).toBe(1);         // feat/x only (main excluded, feat/done excluded)
    expect(s.latestCommit?.sha).toBe("c2");      // main's tipSha
  });
});

describe("commitBranchContext", () => {
  it("returns the first branch name when present", () => {
    expect(commitBranchContext(mkCommit({ sha: "c1", branchNames: ["feat/a", "feat/b"] }))).toBe("feat/a");
  });
  it("returns null for an interior commit", () => {
    expect(commitBranchContext(mkCommit({ sha: "c1", branchNames: [] }))).toBeNull();
  });
});

describe("pipelineStageRank", () => {
  it("maps each stage", () => {
    expect(pipelineStageRank(mkBranch({ name: "x", isRemote: false }))).toBe(0); // dirty
    expect(pipelineStageRank(mkBranch({ name: "x", aheadCount: 2 }))).toBe(1); // committed
    expect(pipelineStageRank(mkBranch({ name: "x", isRemote: true, aheadCount: 0 }))).toBe(2); // pushed
    expect(pipelineStageRank(mkBranch({ name: "x", pr: { number: 1, url: "", reviewState: "open", ciStatus: null, ciUrl: null, commentCount: 0, labels: [] } }))).toBe(3); // pr
    expect(pipelineStageRank(mkBranch({ name: "x", pr: { number: 1, url: "", reviewState: "merged", ciStatus: null, ciUrl: null, commentCount: 0, labels: [] } }))).toBe(4); // merged
  });
});
