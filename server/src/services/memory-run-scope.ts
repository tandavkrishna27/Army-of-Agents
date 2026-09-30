/**
 * Pure scope derivation for run-path memory retrieval (enterprise memory model, P1).
 * A task's department (only when its project is a 'department') + its goal become the
 * `searchMultiPath` scope filters — the fix for today's company-wide, goal-less dump.
 * Shared by the ORG (heartbeat) and CREW (crew-context-bundle) builders.
 */
export interface RunIssueScopeInput {
  projectId: string | null;
  projectType: string | null;
  goalId: string | null;
}

export function resolveRunMemoryScope(
  issue: RunIssueScopeInput | null,
): { departmentId?: string; goalId?: string } {
  const scope: { departmentId?: string; goalId?: string } = {};
  if (!issue) return scope;
  if (issue.projectId && issue.projectType === "department") scope.departmentId = issue.projectId;
  if (issue.goalId) scope.goalId = issue.goalId;
  return scope;
}
