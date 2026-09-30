import path from "node:path";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";

export type ResolvedWorkspaceForRun = {
  cwd: string;
  source: "project_primary" | "task_session" | "agent_home";
  projectId: string | null;
  workspaceId: string | null;
  repoUrl: string | null;
  repoRef: string | null;
  workspaceHints: Array<{
    workspaceId: string;
    cwd: string | null;
    repoUrl: string | null;
    repoRef: string | null;
  }>;
  warnings: string[];
};

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function resolveRuntimeSessionParamsForWorkspace(input: {
  agentId: string;
  previousSessionParams: Record<string, unknown> | null;
  resolvedWorkspace: ResolvedWorkspaceForRun;
}) {
  const { agentId, previousSessionParams, resolvedWorkspace } = input;
  const previousSessionId = readNonEmptyString(previousSessionParams?.sessionId);
  const previousCwd = readNonEmptyString(previousSessionParams?.cwd);
  if (!previousSessionId || !previousCwd) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  if (resolvedWorkspace.source !== "project_primary") {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  const projectCwd = readNonEmptyString(resolvedWorkspace.cwd);
  if (!projectCwd) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  const fallbackAgentHomeCwd = resolveDefaultAgentWorkspaceDir(agentId);
  if (path.resolve(previousCwd) !== path.resolve(fallbackAgentHomeCwd)) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  if (path.resolve(projectCwd) === path.resolve(previousCwd)) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  const previousWorkspaceId = readNonEmptyString(previousSessionParams?.workspaceId);
  if (
    previousWorkspaceId &&
    resolvedWorkspace.workspaceId &&
    previousWorkspaceId !== resolvedWorkspace.workspaceId
  ) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }

  const migratedSessionParams: Record<string, unknown> = {
    ...(previousSessionParams ?? {}),
    cwd: projectCwd,
  };
  if (resolvedWorkspace.workspaceId) migratedSessionParams.workspaceId = resolvedWorkspace.workspaceId;
  if (resolvedWorkspace.repoUrl) migratedSessionParams.repoUrl = resolvedWorkspace.repoUrl;
  if (resolvedWorkspace.repoRef) migratedSessionParams.repoRef = resolvedWorkspace.repoRef;

  return {
    sessionParams: migratedSessionParams,
    warning:
      `Project workspace "${projectCwd}" is now available. ` +
      `Attempting to resume session "${previousSessionId}" that was previously saved in fallback workspace "${previousCwd}".`,
  };
}

export function shouldResetTaskSessionForWake(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (wakeReason === "issue_assigned") return true;

  const wakeSource = readNonEmptyString(contextSnapshot?.wakeSource);
  if (wakeSource === "timer") return true;

  const wakeTriggerDetail = readNonEmptyString(contextSnapshot?.wakeTriggerDetail);
  return wakeSource === "on_demand" && wakeTriggerDetail === "manual";
}
