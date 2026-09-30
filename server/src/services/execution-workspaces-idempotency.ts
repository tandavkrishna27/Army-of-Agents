export interface TaskOwnedWorkspaceCandidate {
  id: string;
  sourceIssueId: string | null;
  status: string;
}

const NON_REUSABLE_STATUSES = new Set(["archived"]);

export function selectTaskOwnedReusableExecutionWorkspace<T extends TaskOwnedWorkspaceCandidate>(
  candidates: T[],
  issueId: string,
): T | null {
  return candidates.find(
    (candidate) => candidate.sourceIssueId === issueId && !NON_REUSABLE_STATUSES.has(candidate.status),
  ) ?? null;
}
