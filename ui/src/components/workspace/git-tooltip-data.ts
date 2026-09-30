/**
 * git-tooltip-data.ts — pure content helpers for GitHoverCard.
 *
 * No React, no canvas — fully unit-testable. Both the merge/trunk/remote
 * tooltip variants and any future consumer derive their display data here so
 * the logic has a single source.
 */
import type { GitBranchInfo, GitCommitNode, GitGraphData } from "@armyofagents/shared";

export interface MergeInfo {
  /** Branch merged IN (the source), or null if unparseable. */
  source: string | null;
  /** Branch merged INTO (the target); falls back to defaultBranch. */
  target: string | null;
  /** GitHub PR number when the message is a PR merge, else null. */
  prNumber: number | null;
}

/** Parse a git merge commit message into source/target/PR. Best-effort; the
 * three forms below cover GitHub squash/merge + CLI merges. Unknown → all null. */
export function parseMergeMessage(message: string, defaultBranch: string): MergeInfo {
  const pr = message.match(/Merge pull request #(\d+) from \S+?\/(\S+)/);
  if (pr) return { source: pr[2]!, target: defaultBranch, prNumber: Number(pr[1]) };

  const rt = message.match(/Merge remote-tracking branch '([^']+)'(?:\s+into\s+'?([^'\s]+)'?)?/);
  if (rt) return { source: rt[1]!, target: rt[2] ?? defaultBranch, prNumber: null };

  const br = message.match(/Merge branch '([^']+)'(?:\s+into\s+'?([^'\s]+)'?)?/);
  if (br) return { source: br[1]!, target: br[2] ?? defaultBranch, prNumber: null };

  return { source: null, target: null, prNumber: null };
}

/** A branch that exists on the remote but is not checked out locally. */
export function isRemoteOnly(b: GitBranchInfo): boolean {
  return b.isRemote && !b.isLocal;
}

export interface TrunkSummary {
  commitCount: number;
  contributorCount: number;
  /** Non-default branches that are not done/cancelled. */
  activeBranchCount: number;
  latestCommit: GitCommitNode | null;
}

/** Default-branch summary for the trunk-line tooltip. */
export function buildTrunkSummary(graph: GitGraphData, branches: GitBranchInfo[]): TrunkSummary {
  const authors = new Set<string>();
  for (const c of graph.commits) if (c.author) authors.add(c.author);
  const isDone = (s: string | null) => s === "done" || s === "cancelled";
  const activeBranchCount = branches.filter(
    (b) => b.name !== graph.defaultBranch && !isDone(b.linkedIssueStatus),
  ).length;
  const tipSha = graph.branches.find((b) => b.name === graph.defaultBranch)?.tipSha;
  const latestCommit =
    (tipSha ? graph.commits.find((c) => c.sha === tipSha) : undefined) ?? graph.commits[0] ?? null;
  return { commitCount: graph.commits.length, contributorCount: authors.size, activeBranchCount, latestCommit };
}

/** Which branch a commit sits on (first tip name), or null for interior commits. */
export function commitBranchContext(commit: GitCommitNode): string | null {
  return commit.branchNames.length > 0 ? commit.branchNames[0]! : null;
}

export const STAGE_LABELS = ["Changes", "Committed", "Pushed", "PR", "Merged"] as const;

/** Branch → pipeline stage index 0..4. SINGLE SOURCE for the tooltip pipeline
 * steps, the GitPipelineView dots, and the sort "pipeline" key. */
export function pipelineStageRank(b: GitBranchInfo): number {
  if (b.pr?.reviewState === "merged") return 4;
  if (b.pr) return 3;
  if (b.isRemote && b.aheadCount === 0) return 2;
  if (b.aheadCount > 0) return 1;
  return 0;
}
