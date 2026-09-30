import type { CommanderContextScope } from "@armyofagents/shared";

export interface NormalizedCommanderContextScope {
  surface: NonNullable<CommanderContextScope["surface"]>;
  route: string | null;
  departmentId: string | null;
  projectId: string | null;
  goalId: string | null;
  taskId: string | null;
  memoryFolderPath: string | null;
  conversationId: string | null;
}

export function normalizeCommanderContextScope(input: {
  contextScope?: CommanderContextScope | NormalizedCommanderContextScope | null;
  departmentContext?: string | null;
  conversationId?: string | null;
}): NormalizedCommanderContextScope {
  const scope: Partial<CommanderContextScope & NormalizedCommanderContextScope> = input.contextScope ?? {};
  return {
    surface: scope.surface ?? "commander",
    route: scope.route ?? null,
    departmentId: scope.departmentId ?? input.departmentContext ?? null,
    projectId: scope.projectId ?? null,
    goalId: scope.goalId ?? null,
    taskId: scope.taskId ?? null,
    memoryFolderPath: scope.memoryFolderPath ?? null,
    conversationId: input.conversationId ?? scope.conversationId ?? null,
  };
}

export function parseCommanderContextScopeJson(raw: string | undefined): NormalizedCommanderContextScope | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CommanderContextScope;
    return normalizeCommanderContextScope({ contextScope: parsed });
  } catch {
    return null;
  }
}
