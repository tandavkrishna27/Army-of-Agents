/**
 * Eager workspace creation — provisions an execution workspace at task creation
 * time instead of waiting for a heartbeat agent pickup.
 *
 * This makes workspaces immediately visible in the UI after task creation.
 * The heartbeat still handles reuse / re-provisioning on subsequent runs.
 */
import fs from "node:fs/promises";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { issues, projects, projectWorkspaces } from "@armyofagents/db";
import { instanceSettingsService } from "./instance-settings.js";
import {
  parseProjectExecutionWorkspacePolicy,
  parseIssueExecutionWorkspaceSettings,
  gateProjectExecutionWorkspacePolicy,
  resolveExecutionWorkspaceMode,
} from "./execution-workspace-policy.js";
import { realizeExecutionWorkspace } from "./workspace-runtime.js";
import { executionWorkspaceService } from "./execution-workspaces.js";
import { workspaceOperationService } from "./workspace-operations.js";
import { parseObject, asString } from "../adapters/utils.js";
import { logger } from "../middleware/logger.js";

interface EagerWorkspaceInput {
  companyId: string;
  issueId: string;
  issueIdentifier: string;
  issueTitle: string | null;
  projectId: string;
  issueExecutionWorkspaceId?: string | null;
  issueExecutionWorkspacePreference?: string | null;
  issueExecutionWorkspaceSettings?: Record<string, unknown> | null;
}

interface EagerWorkspaceResult {
  workspaceId: string;
  branchName: string | null;
  strategy: string;
}

/**
 * Attempt to create an execution workspace eagerly when a task is created.
 *
 * Returns the workspace ID if creation succeeded, null if the project
 * doesn't support workspaces or if anything fails (failures are logged
 * but never propagate — task creation must not be blocked).
 */
export async function createEagerWorkspaceForIssue(
  db: Db,
  input: EagerWorkspaceInput,
): Promise<EagerWorkspaceResult | null> {
  const { companyId, issueId, issueIdentifier, issueTitle, projectId } = input;

  // ── Gate: instance-level isolated workspaces must be enabled ─────────
  const isolatedWorkspacesEnabled = (
    await instanceSettingsService(db).getExperimental()
  ).enableIsolatedWorkspaces;
  if (!isolatedWorkspacesEnabled) return null;

  // ── Gate: project must have executionWorkspacePolicy.enabled ─────────
  const projectRow = await db
    .select({
      executionWorkspacePolicy: projects.executionWorkspacePolicy,
    })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!projectRow) return null;

  const projectPolicy = gateProjectExecutionWorkspacePolicy(
    parseProjectExecutionWorkspacePolicy(projectRow.executionWorkspacePolicy),
    isolatedWorkspacesEnabled,
  );
  if (!projectPolicy?.enabled) return null;

  // Resolve the effective workspace mode from the project default plus any task override.
  const issueSettings = parseIssueExecutionWorkspaceSettings(input.issueExecutionWorkspaceSettings ?? null);
  if (
    input.issueExecutionWorkspacePreference === "reuse_existing" ||
    issueSettings?.mode === "reuse_existing" ||
    input.issueExecutionWorkspaceId
  ) {
    return null;
  }

  const executionWorkspaceMode = resolveExecutionWorkspaceMode({
    projectPolicy,
    issueSettings,
    legacyUseProjectWorkspace: null,
  });
  if (executionWorkspaceMode === "agent_default") return null;
  if (
    (executionWorkspaceMode === "isolated_workspace" || executionWorkspaceMode === "operator_branch") &&
    projectPolicy.workspaceStrategy?.type !== "git_worktree"
  ) {
    return null;
  }

  // ── Resolve project workspace (baseCwd, repoUrl, repoRef) ──────────
  const projectWorkspaceRows = await db
    .select()
    .from(projectWorkspaces)
    .where(
      and(
        eq(projectWorkspaces.companyId, companyId),
        eq(projectWorkspaces.projectId, projectId),
      ),
    )
    .orderBy(asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id));

  if (projectWorkspaceRows.length === 0) return null;

  // Find the first project workspace with a valid cwd
  let baseCwd: string | null = null;
  let repoUrl: string | null = null;
  let repoRef: string | null = null;
  let projectWorkspaceId: string | null = null;

  for (const pw of projectWorkspaceRows) {
    const cwd = typeof pw.cwd === "string" && pw.cwd.trim() ? pw.cwd.trim() : null;
    if (!cwd) continue;
    // Verify the directory exists
    try {
      const stats = await fs.stat(cwd);
      if (stats.isDirectory()) {
        baseCwd = cwd;
        repoUrl = typeof pw.repoUrl === "string" ? pw.repoUrl : null;
        repoRef = typeof pw.repoRef === "string" ? pw.repoRef : null;
        projectWorkspaceId = pw.id;
        break;
      }
    } catch {
      continue;
    }
  }

  if (!baseCwd) return null;

  // ── Build config for realizeExecutionWorkspace ──────────────────────
  const policyObj = parseObject(projectRow.executionWorkspacePolicy);
  const workspaceStrategy = parseObject(policyObj.workspaceStrategy);
  const config: Record<string, unknown> = {};
  if (executionWorkspaceMode === "isolated_workspace" || executionWorkspaceMode === "operator_branch") {
    config.workspaceStrategy = workspaceStrategy;
  }

  const issueRef = {
    id: issueId,
    identifier: issueIdentifier,
    title: issueTitle,
  };

  // Synthetic agent ref — eager workspaces are created before agent assignment.
  // The branch template only uses issue.identifier / slug by default.
  const agentRef = {
    id: null,
    name: "eager",
    companyId,
  };

  // ── Realize the workspace (create git worktree, etc.) ──────────────
  const realized = await realizeExecutionWorkspace({
    base: {
      baseCwd,
      source: "project_primary",
      projectId,
      workspaceId: projectWorkspaceId,
      repoUrl,
      repoRef,
    },
    config,
    issue: issueRef,
    agent: agentRef,
    recorder: null,
  });

  // ── Persist the execution workspace record ─────────────────────────
  const ewSvc = executionWorkspaceService(db);

  const workspaceRuntimeObj = parseObject(policyObj.workspaceRuntime);
  const configSnapshot = {
    provisionCommand:
      typeof workspaceStrategy.provisionCommand === "string"
        ? workspaceStrategy.provisionCommand
        : null,
    teardownCommand:
      typeof workspaceStrategy.teardownCommand === "string"
        ? workspaceStrategy.teardownCommand
        : null,
    cleanupCommand:
      typeof workspaceStrategy.cleanupCommand === "string"
        ? workspaceStrategy.cleanupCommand
        : null,
    workspaceRuntime:
      Object.keys(workspaceRuntimeObj).length > 0 ? workspaceRuntimeObj : null,
    desiredState: null as "running" | "stopped" | null,
    serviceStates: null as Record<string, "running" | "stopped"> | null,
  };
  const hasConfigSnapshot =
    configSnapshot.provisionCommand !== null ||
    configSnapshot.teardownCommand !== null ||
    configSnapshot.cleanupCommand !== null ||
    configSnapshot.workspaceRuntime !== null;

  const modeValue =
    executionWorkspaceMode === "isolated_workspace"
      ? "isolated_workspace"
      : executionWorkspaceMode === "operator_branch"
        ? "operator_branch"
        : "shared_workspace";

  const persisted = await ewSvc.createTaskOwnedIdempotent({
    companyId,
    projectId,
    projectWorkspaceId,
    sourceIssueId: issueId,
    mode: modeValue,
    strategyType:
      realized.strategy === "git_worktree" ? "git_worktree" : "project_primary",
    name:
      realized.branchName ?? issueIdentifier ?? `workspace-${issueId.slice(0, 8)}`,
    status: "active",
    cwd: realized.cwd,
    repoUrl: realized.repoUrl,
    baseRef: realized.repoRef,
    branchName: realized.branchName,
    providerType:
      realized.strategy === "git_worktree" ? "git_worktree" : "local_fs",
    providerRef: realized.worktreePath,
    lastUsedAt: new Date(),
    openedAt: new Date(),
    metadata: {
      source: realized.source,
      createdByRuntime: false,
      eagerCreation: true,
      ...(hasConfigSnapshot ? { config: configSnapshot } : {}),
    },
  });

  if (!persisted) return null;

  // ── Link workspace to the issue + set reuse_existing preference ────
  const shouldSwitchIssueToExistingWorkspace =
    executionWorkspaceMode === "isolated_workspace" ||
    executionWorkspaceMode === "operator_branch";
  const issuePatch: Record<string, unknown> = {
    executionWorkspaceId: persisted.id,
    updatedAt: new Date(),
  };
  if (shouldSwitchIssueToExistingWorkspace) {
    issuePatch.executionWorkspacePreference = "reuse_existing";
    issuePatch.executionWorkspaceSettings = {
      ...(issueSettings ?? {}),
      mode: modeValue,
    };
  }

  await db
    .update(issues)
    .set(issuePatch)
    .where(eq(issues.id, issueId));

  logger.info(
    {
      issueId,
      issueIdentifier,
      workspaceId: persisted.id,
      strategy: realized.strategy,
      branchName: realized.branchName,
    },
    "eager workspace created for new task",
  );

  return {
    workspaceId: persisted.id,
    branchName: realized.branchName,
    strategy: realized.strategy,
  };
}
