/**
 * git-pipeline-sort.ts — pure sort logic for the Git Command Centre Pipeline.
 *
 * No React. The default ("status") puts what-needs-you first (blocked → review
 * → in-progress …), tie-broken by most-recent activity, per the locked design.
 *
 * Pipeline stage rank is sourced from git-tooltip-data.ts (A1 amendment) so
 * there is exactly one copy of the stage-rank rule across the tooltip, the
 * Pipeline dots, and this sort key.
 */
import type { GitBranchInfo } from "@armyofagents/shared";
import { pipelineStageRank } from "./git-tooltip-data";

export type SortKey = "status" | "pipeline" | "ahead" | "who" | "activity" | "id";
export type SortDir = "asc" | "desc";

/** Lower = higher priority (rendered first) under the default status sort. */
export const STATUS_PRIORITY: Record<string, number> = {
  blocked: 0,
  in_review: 1,
  in_progress: 2,
  todo: 3,
  backlog: 4,
  done: 6,
  cancelled: 7,
};
/** Unknown statuses sort between todo/backlog and done. */
const STATUS_UNKNOWN = 5;

/** Per-column natural starting direction when a header is first clicked. */
export const DEFAULT_DIR: Record<SortKey, SortDir> = {
  status: "asc",
  pipeline: "desc",
  ahead: "desc",
  who: "asc",
  activity: "desc",
  id: "asc",
};

export function statusRank(status: string | null): number {
  if (status != null && status in STATUS_PRIORITY) return STATUS_PRIORITY[status]!;
  return STATUS_UNKNOWN;
}

function activityMs(b: GitBranchInfo): number {
  const t = new Date(b.lastCommitAt).getTime();
  return Number.isNaN(t) ? 0 : t;
}

export function compareBranches(
  a: GitBranchInfo,
  b: GitBranchInfo,
  key: SortKey,
  dir: SortDir,
): number {
  let r = 0;
  switch (key) {
    case "status":
      r = statusRank(a.linkedIssueStatus) - statusRank(b.linkedIssueStatus);
      break;
    case "pipeline":
      r = pipelineStageRank(a) - pipelineStageRank(b);
      break;
    case "ahead":
      r = (a.aheadCount - a.behindCount) - (b.aheadCount - b.behindCount);
      break;
    case "who":
      r = (a.lastCommitAuthor ?? "").localeCompare(b.lastCommitAuthor ?? "");
      break;
    case "activity":
      r = activityMs(a) - activityMs(b);
      break;
    case "id":
      r = (a.linkedIssueIdentifier ?? a.name).localeCompare(
        b.linkedIssueIdentifier ?? b.name,
      );
      break;
  }
  const primary = dir === "asc" ? r : -r;
  if (primary !== 0) return primary;
  // Stable tie-break: most-recent activity desc, then name (direction-independent).
  const byRecency = activityMs(b) - activityMs(a);
  if (byRecency !== 0) return byRecency;
  return a.name.localeCompare(b.name);
}

export function sortBranches(
  branches: GitBranchInfo[],
  key: SortKey,
  dir: SortDir,
): GitBranchInfo[] {
  return [...branches].sort((a, b) => compareBranches(a, b, key, dir));
}

/**
 * Return branches sorted newest-first (by lastCommitAt), capped to `cap`.
 * Does NOT mutate the input array. Used by GitGraphCanvas.visibleBranches
 * for the running/blocked/prs/merged filter views (A3 amendment).
 */
export function sortByRecency(branches: GitBranchInfo[], cap: number): GitBranchInfo[] {
  return [...branches]
    .sort((a, b) => (b.lastCommitAt ?? "").localeCompare(a.lastCommitAt ?? ""))
    .slice(0, cap);
}
