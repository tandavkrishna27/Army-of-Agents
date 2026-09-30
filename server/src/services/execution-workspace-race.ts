import path from "node:path";

export interface ExecutionWorkspaceRaceCandidate {
  id: string;
  cwd: string | null;
  providerRef: string | null;
  branchName: string | null;
  status: string;
  updatedAt?: Date;
  metadata?: Record<string, unknown> | null;
}

export interface RealizedExecutionWorkspaceRaceRef {
  cwd: string;
  worktreePath: string | null;
  branchName: string | null;
  created: boolean;
}

function samePath(left: string | null | undefined, right: string | null | undefined) {
  if (!left || !right) return false;
  return path.resolve(left) === path.resolve(right);
}

export function selectConcurrentPersistedExecutionWorkspace(input: {
  realizedWorkspace: RealizedExecutionWorkspaceRaceRef;
  candidates: ExecutionWorkspaceRaceCandidate[];
}): ExecutionWorkspaceRaceCandidate | null {
  const { realizedWorkspace } = input;
  if (realizedWorkspace.created) return null;

  return input.candidates.find((candidate) => {
    if (!["active", "idle", "in_review"].includes(candidate.status)) return false;
    if (realizedWorkspace.branchName && candidate.branchName !== realizedWorkspace.branchName) {
      return false;
    }
    return (
      samePath(candidate.cwd, realizedWorkspace.cwd) ||
      samePath(candidate.providerRef, realizedWorkspace.worktreePath) ||
      samePath(candidate.providerRef, realizedWorkspace.cwd)
    );
  }) ?? null;
}
