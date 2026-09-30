import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { GitBranchInfo, GitCommitNode } from "@armyofagents/shared";
import { GitHoverCard, type HoveredNode } from "../components/workspace/GitHoverCard";

afterEach(cleanup);

function mkBranch(p: Partial<GitBranchInfo> & { name: string }): GitBranchInfo {
  return {
    name: p.name, isLocal: p.isLocal ?? true, isRemote: p.isRemote ?? true,
    aheadCount: p.aheadCount ?? 0, behindCount: p.behindCount ?? 0, lastCommitSha: "s",
    lastCommitMessage: p.lastCommitMessage ?? "msg", lastCommitAt: p.lastCommitAt ?? new Date().toISOString(),
    lastCommitAuthor: p.lastCommitAuthor ?? "Claude", linkedWorkspaceId: null,
    linkedIssueId: p.linkedIssueId ?? null, linkedIssueIdentifier: p.linkedIssueIdentifier ?? null,
    linkedIssueTitle: p.linkedIssueTitle ?? null, linkedIssueStatus: p.linkedIssueStatus ?? null,
    linkedIssueWorkMode: null, pr: p.pr ?? null,
    overlays: { hasConflicts: false, isDiverged: false, isBehindRemote: false }, tags: p.tags ?? [],
  };
}
function mkCommit(p: Partial<GitCommitNode> & { sha: string }): GitCommitNode {
  return {
    sha: p.sha, parentShas: p.parentShas ?? [], shortSha: p.sha.slice(0, 7), message: p.message ?? "",
    author: p.author ?? "Claude", committedAt: p.committedAt ?? new Date().toISOString(),
    branchNames: p.branchNames ?? [], isMerge: p.isMerge ?? false, tags: p.tags ?? [],
  };
}
const pos = { x: 100, y: 100 };

describe("GitHoverCard variants", () => {
  it("task card shows id, author (who), and an Open PR action when a PR exists", () => {
    const branch = mkBranch({
      name: "feat/x", linkedIssueId: "i1", linkedIssueIdentifier: "AOA-7",
      linkedIssueTitle: "Do the thing", linkedIssueStatus: "in_progress", lastCommitAuthor: "Claude",
      pr: { number: 142, url: "https://gh/pr/142", reviewState: "open", ciStatus: "passing", ciUrl: null, commentCount: 0, labels: [] },
    });
    render(<GitHoverCard node={{ type: "task", branch }} position={pos} />);
    expect(screen.getByText("AOA-7")).toBeTruthy();
    expect(screen.getByText(/Claude/)).toBeTruthy();
    expect(screen.getByText(/Open PR/)).toBeTruthy();
  });

  it("merge card shows source → target and PR number", () => {
    const commit = mkCommit({ sha: "m1", isMerge: true, message: "Merge pull request #98 from org/feat/login" });
    render(<GitHoverCard node={{ type: "merge", commit, defaultBranch: "main" }} position={pos} />);
    expect(screen.getAllByText(/Merge/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/feat\/login/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/#98/).length).toBeGreaterThan(0);
  });

  it("remote-only card shows the not-checked-out badge and a Pull action", () => {
    const branch = mkBranch({ name: "origin/hotfix", isLocal: false, isRemote: true });
    render(<GitHoverCard node={{ type: "remote_marker", branch }} position={pos} />);
    expect(screen.getByText(/remote only/i)).toBeTruthy();
    expect(screen.getByText(/Pull/)).toBeTruthy();
  });

  it("trunk card shows the default-branch summary counts", () => {
    render(<GitHoverCard node={{
      type: "trunk", branch: mkBranch({ name: "main" }),
      summary: { commitCount: 204, contributorCount: 8, activeBranchCount: 13, latestCommit: mkCommit({ sha: "c2", message: "latest" }) },
    }} position={pos} />);
    expect(screen.getByText(/204 commits/)).toBeTruthy();
    expect(screen.getByText(/13 active/)).toBeTruthy();
  });

  it("cluster card lists branches and a total", () => {
    const branches = [mkBranch({ name: "AOA-21 a", linkedIssueIdentifier: "AOA-21" }), mkBranch({ name: "AOA-30 b", linkedIssueIdentifier: "AOA-30" })];
    render(<GitHoverCard node={{ type: "cluster", branches, total: 86 }} position={pos} />);
    expect(screen.getByText(/86 more branches/)).toBeTruthy();
    expect(screen.getByText(/AOA-21/)).toBeTruthy();
  });

  it("commit card shows relative time and 'on <branch>' context when branchNames is set (A4)", () => {
    const now = new Date().toISOString();
    const commit = mkCommit({ sha: "c1", author: "Taylor", committedAt: now, branchNames: ["feat/my-feature"] });
    render(<GitHoverCard node={{ type: "commit", commit }} position={pos} />);
    // relative time renders (e.g. "just now" or "Xm ago")
    expect(screen.getByText(/ago|just now|min|hour|sec/i)).toBeTruthy();
    // "on <branch>" context line
    expect(screen.getByText(/on/)).toBeTruthy();
    expect(screen.getByText(/feat\/my-feature/)).toBeTruthy();
  });
});
