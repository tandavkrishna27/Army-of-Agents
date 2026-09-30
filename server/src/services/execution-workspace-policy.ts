import type {
  ExecutionWorkspaceMode,
  ExecutionWorkspaceStrategy,
  IssueExecutionWorkspaceSettings,
  ProjectExecutionWorkspaceDefaultMode,
  ProjectExecutionWorkspacePolicy,
} from "@armyofagents/shared";
import { asString, parseObject } from "../adapters/utils.js";
import { unprocessable } from "../errors.js";

type ParsedExecutionWorkspaceMode = Exclude<ExecutionWorkspaceMode, "inherit" | "reuse_existing">;

function cloneRecord(value: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  return { ...value };
}

function parseExecutionWorkspaceStrategy(raw: unknown): ExecutionWorkspaceStrategy | null {
  const parsed = parseObject(raw);
  const type = asString(parsed.type, "");
  if (type !== "project_primary" && type !== "git_worktree" && type !== "adapter_managed" && type !== "cloud_sandbox") {
    return null;
  }
  return {
    type,
    ...(typeof parsed.baseRef === "string" ? { baseRef: parsed.baseRef } : {}),
    ...(typeof parsed.branchTemplate === "string" ? { branchTemplate: parsed.branchTemplate } : {}),
    ...(typeof parsed.worktreeParentDir === "string" ? { worktreeParentDir: parsed.worktreeParentDir } : {}),
    ...(typeof parsed.provisionCommand === "string" ? { provisionCommand: parsed.provisionCommand } : {}),
    ...(typeof parsed.teardownCommand === "string" ? { teardownCommand: parsed.teardownCommand } : {}),
  };
}

export function parseProjectExecutionWorkspacePolicy(raw: unknown): ProjectExecutionWorkspacePolicy | null {
  const parsed = parseObject(raw);
  if (Object.keys(parsed).length === 0) return null;
  const enabled = typeof parsed.enabled === "boolean" ? parsed.enabled : false;
  const workspaceStrategy = parseExecutionWorkspaceStrategy(parsed.workspaceStrategy);
  const defaultMode = asString(parsed.defaultMode, "");
  const defaultProjectWorkspaceId =
    typeof parsed.defaultProjectWorkspaceId === "string" ? parsed.defaultProjectWorkspaceId : undefined;
  const allowIssueOverride =
    typeof parsed.allowIssueOverride === "boolean" ? parsed.allowIssueOverride : undefined;
  const normalizedDefaultMode = (() => {
    if (
      defaultMode === "shared_workspace" ||
      defaultMode === "isolated_workspace" ||
      defaultMode === "operator_branch" ||
      defaultMode === "adapter_default"
    ) {
      return defaultMode as ProjectExecutionWorkspaceDefaultMode;
    }
    if (defaultMode === "project_primary") return "shared_workspace";
    if (defaultMode === "isolated") return "isolated_workspace";
    return undefined;
  })();
  const ttlDays = (() => {
    if (typeof parsed.ttlDays === "number" && Number.isFinite(parsed.ttlDays) && parsed.ttlDays > 0) {
      return Math.floor(parsed.ttlDays);
    }
    if (parsed.ttlDays === null) return null;
    return undefined;
  })();
  return {
    enabled,
    ...(normalizedDefaultMode ? { defaultMode: normalizedDefaultMode } : {}),
    ...(allowIssueOverride !== undefined ? { allowIssueOverride } : {}),
    ...(defaultProjectWorkspaceId ? { defaultProjectWorkspaceId } : {}),
    ...(workspaceStrategy ? { workspaceStrategy } : {}),
    ...(parsed.workspaceRuntime && typeof parsed.workspaceRuntime === "object" && !Array.isArray(parsed.workspaceRuntime)
      ? { workspaceRuntime: { ...(parsed.workspaceRuntime as Record<string, unknown>) } }
      : {}),
    ...(parsed.branchPolicy && typeof parsed.branchPolicy === "object" && !Array.isArray(parsed.branchPolicy)
      ? { branchPolicy: { ...(parsed.branchPolicy as Record<string, unknown>) } }
      : {}),
    ...(parsed.pullRequestPolicy && typeof parsed.pullRequestPolicy === "object" && !Array.isArray(parsed.pullRequestPolicy)
      ? { pullRequestPolicy: { ...(parsed.pullRequestPolicy as Record<string, unknown>) } }
      : {}),
    ...(parsed.runtimePolicy && typeof parsed.runtimePolicy === "object" && !Array.isArray(parsed.runtimePolicy)
      ? { runtimePolicy: { ...(parsed.runtimePolicy as Record<string, unknown>) } }
      : {}),
    ...(parsed.cleanupPolicy && typeof parsed.cleanupPolicy === "object" && !Array.isArray(parsed.cleanupPolicy)
      ? { cleanupPolicy: { ...(parsed.cleanupPolicy as Record<string, unknown>) } }
      : {}),
    ...(ttlDays !== undefined ? { ttlDays } : {}),
  };
}

export function gateProjectExecutionWorkspacePolicy(
  projectPolicy: ProjectExecutionWorkspacePolicy | null,
  isolatedWorkspacesEnabled: boolean,
): ProjectExecutionWorkspacePolicy | null {
  if (!isolatedWorkspacesEnabled) return null;
  return projectPolicy;
}

export function parseIssueExecutionWorkspaceSettings(raw: unknown): IssueExecutionWorkspaceSettings | null {
  const parsed = parseObject(raw);
  if (Object.keys(parsed).length === 0) return null;
  const workspaceStrategy = parseExecutionWorkspaceStrategy(parsed.workspaceStrategy);
  const mode = asString(parsed.mode, "");
  const reuseWorkspaceId =
    typeof parsed.reuseWorkspaceId === "string" && parsed.reuseWorkspaceId.trim().length > 0
      ? parsed.reuseWorkspaceId.trim()
      : parsed.reuseWorkspaceId === null
        ? null
        : undefined;
  const normalizedMode = (() => {
    if (
      mode === "inherit" ||
      mode === "shared_workspace" ||
      mode === "isolated_workspace" ||
      mode === "operator_branch" ||
      mode === "reuse_existing" ||
      mode === "agent_default"
    ) {
      return mode;
    }
    if (mode === "project_primary") return "shared_workspace";
    if (mode === "isolated") return "isolated_workspace";
    return "";
  })();
  return {
    ...(normalizedMode
      ? { mode: normalizedMode as IssueExecutionWorkspaceSettings["mode"] }
      : {}),
    ...(reuseWorkspaceId !== undefined ? { reuseWorkspaceId } : {}),
    ...(workspaceStrategy ? { workspaceStrategy } : {}),
    ...(parsed.workspaceRuntime && typeof parsed.workspaceRuntime === "object" && !Array.isArray(parsed.workspaceRuntime)
      ? { workspaceRuntime: { ...(parsed.workspaceRuntime as Record<string, unknown>) } }
      : {}),
  };
}

type IssueWorkspacePolicyPatch = {
  executionWorkspaceId?: string | null;
  executionWorkspacePreference?: string | null;
  executionWorkspaceSettings?: Record<string, unknown> | null;
};

type ReuseWorkspaceBoundary = {
  id: string;
  companyId: string;
  projectId: string;
  status: string;
};

function hasIssueWorkspaceCommand(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((entry) => hasIssueWorkspaceCommand(entry));
  }
  const record = value as Record<string, unknown>;
  for (const key of ["command", "provisionCommand", "teardownCommand", "cleanupCommand"]) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return true;
  }
  return Object.values(record).some((entry) => hasIssueWorkspaceCommand(entry));
}

export function enforceIssueExecutionWorkspaceOverridePolicy(input: {
  existingIssue: {
    companyId: string;
    projectId: string | null;
  };
  isolatedWorkspacesEnabled: boolean;
  projectPolicy: ProjectExecutionWorkspacePolicy | null;
  patch: IssueWorkspacePolicyPatch;
  reuseWorkspace: ReuseWorkspaceBoundary | null;
}): IssueWorkspacePolicyPatch {
  const hasWorkspaceOverride =
    input.patch.executionWorkspaceId !== undefined ||
    input.patch.executionWorkspacePreference !== undefined ||
    input.patch.executionWorkspaceSettings !== undefined;
  if (!hasWorkspaceOverride) return input.patch;

  if (!input.isolatedWorkspacesEnabled) {
    const { executionWorkspaceId, executionWorkspacePreference, executionWorkspaceSettings, ...rest } = input.patch;
    void executionWorkspaceId;
    void executionWorkspacePreference;
    void executionWorkspaceSettings;
    return rest;
  }

  if (input.projectPolicy?.enabled && input.projectPolicy.allowIssueOverride === false) {
    throw unprocessable("Project workspace policy does not allow task-level overrides");
  }

  if (hasIssueWorkspaceCommand(input.patch.executionWorkspaceSettings)) {
    throw unprocessable("Issue workspace overrides cannot include commands");
  }

  const parsedSettings = parseIssueExecutionWorkspaceSettings(input.patch.executionWorkspaceSettings) ?? null;
  const reuseWorkspaceId = parsedSettings?.reuseWorkspaceId ?? input.patch.executionWorkspaceId ?? null;

  if (input.patch.executionWorkspaceId) {
    if (!input.reuseWorkspace) {
      throw unprocessable("Execution workspace not found");
    }
    if (input.reuseWorkspace.companyId !== input.existingIssue.companyId) {
      throw unprocessable("Execution workspace must belong to the task company");
    }
    if (!input.existingIssue.projectId || input.reuseWorkspace.projectId !== input.existingIssue.projectId) {
      throw unprocessable("Execution workspace must belong to the task project");
    }
    if (input.reuseWorkspace.status === "archived") {
      throw unprocessable("Execution workspace is archived");
    }
  }

  if (parsedSettings?.mode === "reuse_existing" || input.patch.executionWorkspacePreference === "reuse_existing") {
    if (!reuseWorkspaceId || !input.reuseWorkspace) {
      throw unprocessable("Execution workspace not found");
    }
    if (input.reuseWorkspace.companyId !== input.existingIssue.companyId) {
      throw unprocessable("Execution workspace must belong to the task company");
    }
    if (!input.existingIssue.projectId || input.reuseWorkspace.projectId !== input.existingIssue.projectId) {
      throw unprocessable("Execution workspace must belong to the task project");
    }
    if (input.reuseWorkspace.status === "archived") {
      throw unprocessable("Execution workspace is archived");
    }
    return {
      ...input.patch,
      executionWorkspaceId: input.reuseWorkspace.id,
      executionWorkspacePreference: "reuse_existing",
      ...(parsedSettings ? { executionWorkspaceSettings: parsedSettings as Record<string, unknown> } : {}),
    };
  }

  return {
    ...input.patch,
    ...(parsedSettings ? { executionWorkspaceSettings: parsedSettings as Record<string, unknown> } : {}),
  };
}

export function defaultIssueExecutionWorkspaceSettingsForProject(
  projectPolicy: ProjectExecutionWorkspacePolicy | null,
): IssueExecutionWorkspaceSettings | null {
  if (!projectPolicy?.enabled) return null;
  return {
    mode:
      projectPolicy.defaultMode === "isolated_workspace"
        ? "isolated_workspace"
        : projectPolicy.defaultMode === "operator_branch"
          ? "operator_branch"
          : projectPolicy.defaultMode === "adapter_default"
            ? "agent_default"
            : "shared_workspace",
  };
}

export function issueExecutionWorkspaceModeForPersistedWorkspace(
  mode: string | null | undefined,
): IssueExecutionWorkspaceSettings["mode"] {
  if (mode === null || mode === undefined) {
    return "agent_default";
  }
  if (mode === "isolated_workspace" || mode === "operator_branch" || mode === "shared_workspace") {
    return mode;
  }
  if (mode === "adapter_managed" || mode === "cloud_sandbox") {
    return "agent_default";
  }
  return "shared_workspace";
}

export function resolveExecutionWorkspaceMode(input: {
  projectPolicy: ProjectExecutionWorkspacePolicy | null;
  issueSettings: IssueExecutionWorkspaceSettings | null;
  legacyUseProjectWorkspace: boolean | null;
}): ParsedExecutionWorkspaceMode {
  const issueMode = input.issueSettings?.mode;
  if (issueMode && issueMode !== "inherit" && issueMode !== "reuse_existing") {
    return issueMode;
  }
  if (input.projectPolicy?.enabled) {
    if (input.projectPolicy.defaultMode === "isolated_workspace") return "isolated_workspace";
    if (input.projectPolicy.defaultMode === "operator_branch") return "operator_branch";
    if (input.projectPolicy.defaultMode === "adapter_default") return "agent_default";
    return "shared_workspace";
  }
  if (input.legacyUseProjectWorkspace === false) {
    return "agent_default";
  }
  return "shared_workspace";
}

/**
 * Decide whether a deliverable task should reuse the thread's shared workspace
 * or get its own isolated worktree/branch.  This is a pure decision function
 * with no I/O — all context is passed in.
 *
 * Rules:
 *   • intent === "isolated"  → "isolated"
 *     The deliverable (or its proposal) explicitly requests an independent
 *     worktree / branch.  Always honoured regardless of threadHasWorkspace.
 *
 *   • otherwise (intent === "reuse" OR intent is absent)  → "reuse_thread"
 *     The deliverable shares the thread's workspace.  When threadHasWorkspace
 *     is false the caller is expected to create the thread workspace first;
 *     the returned mode is the same in both the "create-then-reuse" and
 *     "already-exists" cases because the distinction is a provisioning concern,
 *     not a mode concern.
 *
 * This function is intentionally kept next to resolveExecutionWorkspaceMode so
 * the two resolution paths for task-level vs deliverable-level workspace mode
 * remain easy to compare.
 */
export function resolveDeliverableWorkspaceMode(input: {
  intent?: "reuse" | "isolated";
  threadHasWorkspace: boolean;
}): "reuse_thread" | "isolated" {
  if (input.intent === "isolated") {
    return "isolated";
  }
  // Default (no intent) and explicit "reuse" both map to "reuse_thread".
  // threadHasWorkspace does not affect the resolved mode — it only affects
  // whether the caller must provision the workspace before attaching the
  // deliverable.
  return "reuse_thread";
}

export function buildExecutionWorkspaceAdapterConfig(input: {
  agentConfig: Record<string, unknown>;
  projectPolicy: ProjectExecutionWorkspacePolicy | null;
  issueSettings: IssueExecutionWorkspaceSettings | null;
  mode: ParsedExecutionWorkspaceMode;
  legacyUseProjectWorkspace: boolean | null;
}): Record<string, unknown> {
  const nextConfig = { ...input.agentConfig };
  const projectHasPolicy = Boolean(input.projectPolicy?.enabled);
  const issueHasWorkspaceOverrides = Boolean(
    input.issueSettings?.mode ||
    input.issueSettings?.workspaceStrategy ||
    input.issueSettings?.workspaceRuntime,
  );
  const hasWorkspaceControl = projectHasPolicy || issueHasWorkspaceOverrides || input.legacyUseProjectWorkspace === false;

  if (hasWorkspaceControl) {
    if (input.mode === "isolated_workspace") {
      const strategy =
        input.issueSettings?.workspaceStrategy ??
        input.projectPolicy?.workspaceStrategy ??
        parseExecutionWorkspaceStrategy(nextConfig.workspaceStrategy);
      if (strategy) {
        nextConfig.workspaceStrategy = strategy as unknown as Record<string, unknown>;
      } else {
        delete nextConfig.workspaceStrategy;
      }
    } else {
      delete nextConfig.workspaceStrategy;
    }

    if (input.mode === "agent_default") {
      delete nextConfig.workspaceRuntime;
    } else if (input.issueSettings?.workspaceRuntime) {
      nextConfig.workspaceRuntime = cloneRecord(input.issueSettings.workspaceRuntime) ?? undefined;
    } else if (input.projectPolicy?.workspaceRuntime) {
      nextConfig.workspaceRuntime = cloneRecord(input.projectPolicy.workspaceRuntime) ?? undefined;
    }
  }

  return nextConfig;
}
