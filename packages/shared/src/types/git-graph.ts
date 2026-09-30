/**
 * Shared types for the Git Command Centre — project-level git graph
 * visualization with branch tracking, task linking, PR state, and CI status.
 *
 * Endpoints:
 *   GET /companies/:cid/projects/:pid/git/graph  — fast, git-only
 *   GET /companies/:cid/projects/:pid/git/enrich — slow, GitHub PR+CI
 */

// ---------------------------------------------------------------------------
// Primitive state types
// ---------------------------------------------------------------------------

/**
 * PR review state as shown in the Git Command Centre.
 * Maps to GitHub's per-reviewer latest review logic (not newest-overall).
 */
export type GitPrReviewState =
  | "draft"
  | "open"
  | "changes_requested"
  | "approved"
  | "merged"
  | "closed";

export type GitCIStatus = "pending" | "passing" | "failing" | null;

/** The 5-dot git pipeline stage shown in branch tooltips and pipeline view. */
export type GitPipelineStage =
  | "dirty"       // uncommitted local changes
  | "committed"   // committed locally, not pushed
  | "pushed"      // pushed to remote, no PR
  | "pr_open"     // PR exists (any review state)
  | "merged";     // PR merged

// ---------------------------------------------------------------------------
// Branch info (returned by /git/graph + merged with /git/enrich)
// ---------------------------------------------------------------------------

export interface GitBranchInfo {
  name: string;
  isLocal: boolean;
  isRemote: boolean;
  /** Commits ahead of remote upstream (0 = in sync). */
  aheadCount: number;
  /** Commits behind remote upstream (0 = in sync). */
  behindCount: number;
  lastCommitSha: string;
  lastCommitMessage: string;
  lastCommitAt: string;       // ISO 8601
  lastCommitAuthor: string;

  // Task linking — joined from execution_workspaces.sourceIssueId (NOT .issueId)
  linkedWorkspaceId: string | null;
  linkedIssueId: string | null;
  linkedIssueIdentifier: string | null;   // e.g. "AUTH-47"
  linkedIssueTitle: string | null;
  linkedIssueStatus: string | null;       // "in_progress" | "in_review" | "blocked" | "done" etc.
  linkedIssueWorkMode: "standard" | "planning" | null;

  /**
   * PR data — null until /git/enrich completes.
   * The canvas renders immediately with null; badges populate after enrichment.
   */
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

  overlays: {
    /** True if git detects merge conflicts on this branch. */
    hasConflicts: boolean;
    /** aheadCount > 0 && behindCount > 0 — branch has diverged from remote. */
    isDiverged: boolean;
    /** behindCount > 0 && aheadCount === 0 — branch is strictly behind remote. */
    isBehindRemote: boolean;
  };

  /** Version tag names whose commit is this branch tip. */
  tags: string[];
}

// ---------------------------------------------------------------------------
// Commit graph (returned by /git/graph)
// ---------------------------------------------------------------------------

export interface GitCommitNode {
  sha: string;
  parentShas: string[];
  shortSha: string;
  message: string;
  author: string;
  committedAt: string;   // ISO 8601
  /** Branch names whose tip is this commit. */
  branchNames: string[];
  /** True if this commit has more than one parent (merge commit). */
  isMerge: boolean;
  /** Version tags pointing at this commit. */
  tags: string[];
}

export interface GitGraphData {
  commits: GitCommitNode[];
  branches: Array<{
    name: string;
    /** Lane index for D3 layout (0 = main/default branch). */
    laneIndex: number;
    /** Hex color from the 6-color data palette. */
    color: string;
    tipSha: string;
  }>;
  defaultBranch: string;
}

// ---------------------------------------------------------------------------
// API response shapes
// ---------------------------------------------------------------------------

export interface GitProjectGraphResponse {
  branches: GitBranchInfo[];
  graph: GitGraphData;
  repoUrl: string | null;
  /** True when no GitHub PAT or App installation is configured — PR/CI fields will remain null. */
  hasGitHubConnection: boolean;
  /** True when no project_workspaces row with cwd exists — show empty state. */
  noWorkspaceYet: boolean;
}

/** Single-branch enrichment patch returned by /git/enrich. */
export interface GitBranchEnrichment {
  branchName: string;
  pr: GitBranchInfo["pr"];
}

export interface GitProjectEnrichResponse {
  hasGitHubConnection: boolean;
  enrichments: GitBranchEnrichment[];
}
