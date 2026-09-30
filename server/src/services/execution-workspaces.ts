import fs from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  executionWorkspaces,
  issues,
  projects,
  projectWorkspaces,
  workspaceRuntimeServices,
} from "@armyofagents/db";
import type {
  ExecutionWorkspace,
  ExecutionWorkspaceCloseAction,
  ExecutionWorkspaceCloseGitReadiness,
  ExecutionWorkspaceCloseLinkedIssue,
  ExecutionWorkspaceCloseReadiness,
  ExecutionWorkspaceConfig,
  ExecutionWorkspaceSummary,
  WorkspaceRuntimeDesiredState,
  WorkspaceRuntimeService,
  WorkspaceRuntimeServiceStateMap,
} from "@armyofagents/shared";
import { parseProjectExecutionWorkspacePolicy } from "./execution-workspace-policy.js";
import {
  listCurrentRuntimeServicesForExecutionWorkspaces,
  listCurrentRuntimeServicesForProjectWorkspaces,
} from "./workspace-runtime-read-model.js";
import {
  buildRuntimeServicePreviewUrl,
  classifyRuntimeServiceTarget,
  isAllowedPreviewUpstream,
} from "./preview-url.js";
import { runGit as runGitService } from "./git.js";
import { isUniqueViolation } from "./db-errors.js";
import { emitBranchTaskOutput } from "./task-output-emitters.js";
import { assertLocalWorkspaceCommandAllowed } from "./local-workspace-command-guard.js";
import { isRuntimeProcessOwnedByCurrentReplica } from "./runtime-process-owner.js";

type ExecutionWorkspaceRow = typeof executionWorkspaces.$inferSelect;
type WorkspaceRuntimeServiceRow = typeof workspaceRuntimeServices.$inferSelect;

const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);

/**
 * How long (in ms) a workspace lock is considered fresh.  After this interval
 * a lock is "stale" and a new caller may reclaim it atomically, which handles
 * the case where the process that acquired the lock crashed without releasing.
 *
 * Default: 30 minutes.  Callers may pass a custom staleMs to tryClaimWorkspaceRun
 * (useful in tests and for workloads with known shorter/longer build times).
 */
export const WORKSPACE_RUN_LOCK_STALE_MS = 30 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cloneRecord(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return { ...value };
}

export function mergeExecutionWorkspaceMetadataPatch(input: {
  existingMetadata: unknown;
  incomingMetadata: unknown;
}): Record<string, unknown> | null {
  const incoming = cloneRecord(input.incomingMetadata) ?? {};
  delete incoming.config;

  const existingConfig = cloneRecord(input.existingMetadata)?.config;
  if (existingConfig !== undefined) {
    incoming.config = existingConfig;
  }

  return Object.keys(incoming).length > 0 ? incoming : null;
}

async function pathExists(value: string | null | undefined) {
  if (!value) return false;
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Thin adapter preserving the `{ stdout }` shape the close-readiness callers expect.
 * Delegates to the consolidated git service which returns trimmed stdout directly.
 */
async function runGit(args: string[], cwd: string): Promise<{ stdout: string }> {
  const stdout = await runGitService(args, cwd);
  return { stdout };
}

async function inspectGitCloseReadiness(workspace: ExecutionWorkspace): Promise<{
  git: ExecutionWorkspaceCloseGitReadiness | null;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const workspacePath = readNullableString(workspace.providerRef) ?? readNullableString(workspace.cwd);
  const createdByRuntime = workspace.metadata?.createdByRuntime === true;
  const expectsGitInspection =
    workspace.providerType === "git_worktree" ||
    Boolean(workspace.repoUrl || workspace.baseRef || workspace.branchName || workspacePath);

  if (!expectsGitInspection) {
    return { git: null, warnings };
  }

  if (!workspacePath) {
    warnings.push(
      "Workspace has no local path, so we cannot inspect git status before close.",
    );
    return { git: null, warnings };
  }

  if (!(await pathExists(workspacePath))) {
    warnings.push(
      `Workspace path "${workspacePath}" does not exist, so we cannot inspect git status before close.`,
    );
    return {
      git: {
        repoRoot: null,
        workspacePath,
        branchName: workspace.branchName,
        baseRef: workspace.baseRef,
        hasDirtyTrackedFiles: false,
        hasUntrackedFiles: false,
        dirtyEntryCount: 0,
        untrackedEntryCount: 0,
        aheadCount: null,
        behindCount: null,
        isMergedIntoBase: null,
        createdByRuntime,
      },
      warnings,
    };
  }

  assertLocalWorkspaceCommandAllowed("workspace Git close-readiness command");

  let repoRoot: string | null = null;
  try {
    repoRoot = (await runGit(["rev-parse", "--show-toplevel"], workspacePath)).stdout.trim() || null;
  } catch (error) {
    warnings.push(
      `Could not inspect git status for "${workspacePath}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let branchName = workspace.branchName;
  if (repoRoot && !branchName) {
    try {
      branchName = (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], workspacePath)).stdout.trim() || null;
    } catch {
      branchName = workspace.branchName;
    }
  }

  let dirtyEntryCount = 0;
  let untrackedEntryCount = 0;
  if (repoRoot) {
    try {
      const statusOutput = (await runGit(["status", "--porcelain=v1", "--untracked-files=all"], workspacePath)).stdout;
      for (const line of statusOutput.split(/\r?\n/)) {
        if (!line) continue;
        if (line.startsWith("??")) {
          untrackedEntryCount += 1;
          continue;
        }
        dirtyEntryCount += 1;
      }
    } catch (error) {
      warnings.push(
        `Could not read git working tree status for "${workspacePath}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  let aheadCount: number | null = null;
  let behindCount: number | null = null;
  let isMergedIntoBase: boolean | null = null;
  const baseRef = workspace.baseRef;

  if (repoRoot && baseRef) {
    try {
      const counts = (await runGit(["rev-list", "--left-right", "--count", `${baseRef}...HEAD`], workspacePath)).stdout.trim();
      const [behindRaw, aheadRaw] = counts.split(/\s+/);
      behindCount = behindRaw ? Number.parseInt(behindRaw, 10) : 0;
      aheadCount = aheadRaw ? Number.parseInt(aheadRaw, 10) : 0;
    } catch (error) {
      warnings.push(
        `Could not compare this workspace against ${baseRef}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      await runGit(["merge-base", "--is-ancestor", "HEAD", baseRef], workspacePath);
      isMergedIntoBase = true;
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? (error as { code?: unknown }).code : null;
      if (code === 1) isMergedIntoBase = false;
      else {
        warnings.push(
          `Could not determine whether this workspace is merged into ${baseRef}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  return {
    git: {
      repoRoot,
      workspacePath,
      branchName,
      baseRef,
      hasDirtyTrackedFiles: dirtyEntryCount > 0,
      hasUntrackedFiles: untrackedEntryCount > 0,
      dirtyEntryCount,
      untrackedEntryCount,
      aheadCount,
      behindCount,
      isMergedIntoBase,
      createdByRuntime,
    },
    warnings,
  };
}

export function readExecutionWorkspaceConfig(metadata: Record<string, unknown> | null | undefined): ExecutionWorkspaceConfig | null {
  const raw = isRecord(metadata) && isRecord(metadata.config) ? metadata.config : null;
  if (!raw) return null;

  const rawDesired = raw.desiredState;
  const desiredState: WorkspaceRuntimeDesiredState | null =
    rawDesired === "running" || rawDesired === "stopped" ? rawDesired : null;

  let serviceStates: WorkspaceRuntimeServiceStateMap | null = null;
  if (isRecord(raw.serviceStates)) {
    const entries = Object.entries(raw.serviceStates).filter(
      ([, state]) => state === "running" || state === "stopped",
    ) as [string, WorkspaceRuntimeDesiredState][];
    serviceStates = Object.fromEntries(entries);
  }

  const config: ExecutionWorkspaceConfig = {
    provisionCommand: readNullableString(raw.provisionCommand),
    teardownCommand: readNullableString(raw.teardownCommand),
    cleanupCommand: readNullableString(raw.cleanupCommand),
    workspaceRuntime: cloneRecord(raw.workspaceRuntime),
    desiredState,
    serviceStates,
  };

  const hasConfig = Object.values(config).some((value) => {
    if (value === null) return false;
    if (typeof value === "object") return Object.keys(value).length > 0;
    return true;
  });

  return hasConfig ? config : null;
}

export function mergeExecutionWorkspaceConfig(
  metadata: Record<string, unknown> | null | undefined,
  patch: Partial<ExecutionWorkspaceConfig> | null,
): Record<string, unknown> | null {
  const nextMetadata = isRecord(metadata) ? { ...metadata } : {};
  const current = readExecutionWorkspaceConfig(metadata) ?? {
    provisionCommand: null,
    teardownCommand: null,
    cleanupCommand: null,
    workspaceRuntime: null,
    desiredState: null,
    serviceStates: null,
  };

  if (patch === null) {
    delete nextMetadata.config;
    return Object.keys(nextMetadata).length > 0 ? nextMetadata : null;
  }

  let mergedServiceStates: WorkspaceRuntimeServiceStateMap | null;
  if (patch.serviceStates !== undefined) {
    if (isRecord(patch.serviceStates)) {
      const entries = Object.entries(patch.serviceStates).filter(
        ([, state]) => state === "running" || state === "stopped",
      ) as [string, WorkspaceRuntimeDesiredState][];
      mergedServiceStates = Object.fromEntries(entries);
    } else {
      mergedServiceStates = null;
    }
  } else {
    mergedServiceStates = current.serviceStates ?? null;
  }

  const nextConfig: ExecutionWorkspaceConfig = {
    provisionCommand:
      patch.provisionCommand !== undefined
        ? readNullableString(patch.provisionCommand)
        : current.provisionCommand,
    teardownCommand:
      patch.teardownCommand !== undefined
        ? readNullableString(patch.teardownCommand)
        : current.teardownCommand,
    cleanupCommand:
      patch.cleanupCommand !== undefined
        ? readNullableString(patch.cleanupCommand)
        : current.cleanupCommand,
    workspaceRuntime:
      patch.workspaceRuntime !== undefined ? cloneRecord(patch.workspaceRuntime) : current.workspaceRuntime,
    desiredState:
      patch.desiredState !== undefined
        ? patch.desiredState === "running" || patch.desiredState === "stopped"
          ? patch.desiredState
          : null
        : current.desiredState,
    serviceStates: mergedServiceStates,
  };

  const hasConfig = Object.values(nextConfig).some((value) => {
    if (value === null) return false;
    if (typeof value === "object") return Object.keys(value).length > 0;
    return true;
  });

  if (hasConfig) {
    nextMetadata.config = {
      provisionCommand: nextConfig.provisionCommand,
      teardownCommand: nextConfig.teardownCommand,
      cleanupCommand: nextConfig.cleanupCommand,
      workspaceRuntime: nextConfig.workspaceRuntime,
      desiredState: nextConfig.desiredState,
      serviceStates: nextConfig.serviceStates ?? null,
    };
  } else {
    delete nextMetadata.config;
  }

  return Object.keys(nextMetadata).length > 0 ? nextMetadata : null;
}

export function toWorkspaceRuntimeService(row: WorkspaceRuntimeServiceRow): WorkspaceRuntimeService {
  const target = classifyRuntimeServiceTarget(row.url ?? null);
  const linkedToWorkspace = Boolean(row.executionWorkspaceId || row.projectWorkspaceId);
  const availableOnThisHost = isRuntimeProcessOwnedByCurrentReplica(row);
  const canProxy =
    linkedToWorkspace &&
    availableOnThisHost &&
    row.status === "running" &&
    row.healthStatus !== "unhealthy" &&
    isAllowedPreviewUpstream(row.url ?? null);

  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId ?? null,
    projectWorkspaceId: row.projectWorkspaceId ?? null,
    executionWorkspaceId: row.executionWorkspaceId ?? null,
    issueId: row.issueId ?? null,
    scopeType: row.scopeType as WorkspaceRuntimeService["scopeType"],
    scopeId: row.scopeId ?? null,
    serviceName: row.serviceName,
    status: row.status as WorkspaceRuntimeService["status"],
    lifecycle: row.lifecycle as WorkspaceRuntimeService["lifecycle"],
    reuseKey: row.reuseKey ?? null,
    command: row.command ?? null,
    cwd: row.cwd ?? null,
    port: row.port ?? null,
    url: availableOnThisHost ? (row.url ?? null) : null,
    previewUrl: canProxy ? buildRuntimeServicePreviewUrl(row.id) : null,
    previewAccess: canProxy ? target.access : null,
    localTargetUrl: availableOnThisHost ? target.localTargetUrl : null,
    provider: row.provider as WorkspaceRuntimeService["provider"],
    providerRef: row.providerRef ?? null,
    ownerAgentId: row.ownerAgentId ?? null,
    startedByRunId: row.startedByRunId ?? null,
    lastUsedAt: row.lastUsedAt,
    startedAt: row.startedAt,
    stoppedAt: row.stoppedAt ?? null,
    stopPolicy: (row.stopPolicy as Record<string, unknown> | null) ?? null,
    healthStatus: row.healthStatus as WorkspaceRuntimeService["healthStatus"],
    healthCheckedAt: row.healthCheckedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toExecutionWorkspace(row: ExecutionWorkspaceRow): ExecutionWorkspace {
  const metadata = (row.metadata as Record<string, unknown> | null) ?? null;
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId,
    projectWorkspaceId: row.projectWorkspaceId ?? null,
    sourceIssueId: row.sourceIssueId ?? null,
    mode: row.mode as ExecutionWorkspace["mode"],
    strategyType: row.strategyType as ExecutionWorkspace["strategyType"],
    name: row.name,
    status: row.status as ExecutionWorkspace["status"],
    cwd: row.cwd ?? null,
    repoUrl: row.repoUrl ?? null,
    baseRef: row.baseRef ?? null,
    branchName: row.branchName ?? null,
    providerType: row.providerType as ExecutionWorkspace["providerType"],
    providerRef: row.providerRef ?? null,
    derivedFromExecutionWorkspaceId: row.derivedFromExecutionWorkspaceId ?? null,
    lastUsedAt: row.lastUsedAt,
    openedAt: row.openedAt,
    closedAt: row.closedAt ?? null,
    cleanupEligibleAt: row.cleanupEligibleAt ?? null,
    cleanupReason: row.cleanupReason ?? null,
    config: readExecutionWorkspaceConfig(metadata),
    metadata,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function usesInheritedProjectRuntimeServices(row: ExecutionWorkspaceRow) {
  if (row.mode !== "shared_workspace" || !row.projectWorkspaceId) return false;
  return !readExecutionWorkspaceConfig((row.metadata as Record<string, unknown> | null) ?? null)?.workspaceRuntime;
}

export async function loadEffectiveRuntimeServicesByExecutionWorkspace(
  db: Db,
  companyId: string,
  rows: ExecutionWorkspaceRow[],
) {
  const executionRuntimeServices = await listCurrentRuntimeServicesForExecutionWorkspaces(
    db,
    companyId,
    rows.map((row) => row.id),
  );
  const projectWorkspaceIds = rows
    .filter((row) => usesInheritedProjectRuntimeServices(row))
    .map((row) => row.projectWorkspaceId)
    .filter((value): value is string => Boolean(value));
  const projectRuntimeServices = await listCurrentRuntimeServicesForProjectWorkspaces(
    db,
    companyId,
    [...new Set(projectWorkspaceIds)],
  );

  return new Map(
    rows.map((row) => [
      row.id,
      usesInheritedProjectRuntimeServices(row)
        ? (projectRuntimeServices.get(row.projectWorkspaceId!) ?? [])
        : (executionRuntimeServices.get(row.id) ?? []),
    ]),
  );
}

export function executionWorkspaceService(db: Db) {
  async function findActiveTaskOwned(companyId: string, issueId: string) {
    const rows = await db
      .select()
      .from(executionWorkspaces)
      .where(
        and(
          eq(executionWorkspaces.companyId, companyId),
          eq(executionWorkspaces.sourceIssueId, issueId),
          ne(executionWorkspaces.status, "archived"),
        ),
      )
      .orderBy(desc(executionWorkspaces.lastUsedAt), desc(executionWorkspaces.createdAt));
    return rows[0] ? toExecutionWorkspace(rows[0]) : null;
  }

  async function create(data: typeof executionWorkspaces.$inferInsert) {
    const row = await db
      .insert(executionWorkspaces)
      .values(data)
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const workspace = toExecutionWorkspace(row);
    await emitBranchTaskOutput(db, workspace);
    return workspace;
  }

  async function update(id: string, patch: Partial<typeof executionWorkspaces.$inferInsert>) {
    const row = await db
      .update(executionWorkspaces)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(executionWorkspaces.id, id))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const workspace = toExecutionWorkspace(row);
    await emitBranchTaskOutput(db, workspace);
    return workspace;
  }

  async function updateIfVersion(
    id: string,
    expectedUpdatedAt: Date,
    patch: Partial<typeof executionWorkspaces.$inferInsert>,
    allowedStatuses?: ExecutionWorkspace["status"][],
    projectWorkspaceFence?: { id: string; expectedUpdatedAt: Date } | null,
  ) {
    const updateRow = async (tx: Db) => {
      if (projectWorkspaceFence) {
        // A same-value optimistic update obtains a row lock without advancing
        // the generation. Project config updates either land before this fence
        // (and make it fail) or wait until the execution-state commit finishes.
        const fencedProjectRows = await tx
          .update(projectWorkspaces)
          .set({ updatedAt: projectWorkspaceFence.expectedUpdatedAt })
          .where(and(
            eq(projectWorkspaces.id, projectWorkspaceFence.id),
            eq(projectWorkspaces.updatedAt, projectWorkspaceFence.expectedUpdatedAt),
          ))
          .returning({ id: projectWorkspaces.id });
        if (fencedProjectRows.length === 0) return null;
      }
      return await tx
        .update(executionWorkspaces)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(
          eq(executionWorkspaces.id, id),
          eq(executionWorkspaces.updatedAt, expectedUpdatedAt),
          ...(allowedStatuses?.length
            ? [inArray(executionWorkspaces.status, allowedStatuses)]
            : []),
        ))
        .returning()
        .then((rows) => rows[0] ?? null);
    };
    const row = projectWorkspaceFence
      ? await db.transaction(async (tx) => await updateRow(tx as unknown as Db))
      : await updateRow(db);
    if (!row) return null;
    const workspace = toExecutionWorkspace(row);
    await emitBranchTaskOutput(db, workspace);
    return workspace;
  }

  async function archiveIfVersion(input: {
    id: string;
    companyId: string;
    expectedUpdatedAt: Date;
    patch: Partial<typeof executionWorkspaces.$inferInsert>;
    detachLinkedIssues: boolean;
  }) {
    const row = await db.transaction(async (tx) => {
      const archivedRows = await tx
        .update(executionWorkspaces)
        .set({ ...input.patch, status: "archived", updatedAt: new Date() })
        .where(and(
          eq(executionWorkspaces.id, input.id),
          eq(executionWorkspaces.companyId, input.companyId),
          eq(executionWorkspaces.updatedAt, input.expectedUpdatedAt),
          inArray(executionWorkspaces.status, ["active", "idle", "in_review"]),
        ))
        .returning();
      const archived = archivedRows[0] ?? null;
      if (!archived) return null;
      if (input.detachLinkedIssues) {
        await tx
          .update(issues)
          .set({ executionWorkspaceId: null })
          .where(and(
            eq(issues.companyId, input.companyId),
            eq(issues.executionWorkspaceId, input.id),
          ));
      }
      return archived;
    });
    if (!row) return null;
    const workspace = toExecutionWorkspace(row);
    await emitBranchTaskOutput(db, workspace);
    return workspace;
  }

  async function createTaskOwnedIdempotent(data: typeof executionWorkspaces.$inferInsert) {
    if (!data.sourceIssueId) return create(data);
    const existing = await findActiveTaskOwned(data.companyId, data.sourceIssueId);
    if (existing) return update(existing.id, data);
    try {
      return await create(data);
    } catch (error) {
      if (!isUniqueViolation(error, "execution_workspaces_active_task_workspace_uq")) throw error;
      const raced = await findActiveTaskOwned(data.companyId, data.sourceIssueId);
      if (!raced) throw error;
      return update(raced.id, data);
    }
  }

  return {
    list: async (companyId: string, filters?: {
      projectId?: string;
      projectWorkspaceId?: string;
      issueId?: string;
      status?: string;
      reuseEligible?: boolean;
    }) => {
      const conditions = [eq(executionWorkspaces.companyId, companyId)];
      if (filters?.projectId) conditions.push(eq(executionWorkspaces.projectId, filters.projectId));
      if (filters?.projectWorkspaceId) {
        conditions.push(eq(executionWorkspaces.projectWorkspaceId, filters.projectWorkspaceId));
      }
      if (filters?.issueId) conditions.push(eq(executionWorkspaces.sourceIssueId, filters.issueId));
      if (filters?.status) {
        const statuses = filters.status.split(",").map((value) => value.trim()).filter(Boolean);
        if (statuses.length === 1) conditions.push(eq(executionWorkspaces.status, statuses[0]!));
        else if (statuses.length > 1) conditions.push(inArray(executionWorkspaces.status, statuses));
      }
      if (filters?.reuseEligible) {
        conditions.push(inArray(executionWorkspaces.status, ["active", "idle", "in_review"]));
      }

      const rows = await db
        .select()
        .from(executionWorkspaces)
        .where(and(...conditions))
        .orderBy(desc(executionWorkspaces.lastUsedAt), desc(executionWorkspaces.createdAt));
      return rows.map(toExecutionWorkspace);
    },

    listSummaries: async (companyId: string, filters?: {
      projectId?: string;
      projectWorkspaceId?: string;
      issueId?: string;
      status?: string;
      reuseEligible?: boolean;
    }): Promise<ExecutionWorkspaceSummary[]> => {
      const conditions = [eq(executionWorkspaces.companyId, companyId)];
      if (filters?.projectId) conditions.push(eq(executionWorkspaces.projectId, filters.projectId));
      if (filters?.projectWorkspaceId) {
        conditions.push(eq(executionWorkspaces.projectWorkspaceId, filters.projectWorkspaceId));
      }
      if (filters?.issueId) conditions.push(eq(executionWorkspaces.sourceIssueId, filters.issueId));
      if (filters?.status) {
        const statuses = filters.status.split(",").map((value) => value.trim()).filter(Boolean);
        if (statuses.length === 1) conditions.push(eq(executionWorkspaces.status, statuses[0]!));
        else if (statuses.length > 1) conditions.push(inArray(executionWorkspaces.status, statuses));
      }
      if (filters?.reuseEligible) {
        conditions.push(ne(executionWorkspaces.status, "archived"));
        conditions.push(inArray(executionWorkspaces.mode, ["shared_workspace", "isolated_workspace"]));
      }
      const rows = await db
        .select({
          id: executionWorkspaces.id,
          name: executionWorkspaces.name,
          branchName: executionWorkspaces.branchName,
          status: executionWorkspaces.status,
          mode: executionWorkspaces.mode,
          strategyType: executionWorkspaces.strategyType,
          sourceIssueId: executionWorkspaces.sourceIssueId,
          lastUsedAt: executionWorkspaces.lastUsedAt,
        })
        .from(executionWorkspaces)
        .where(and(...conditions))
        .orderBy(desc(executionWorkspaces.lastUsedAt));
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        branchName: row.branchName ?? null,
        status: row.status as ExecutionWorkspaceSummary["status"],
        mode: row.mode as ExecutionWorkspaceSummary["mode"],
        strategyType: row.strategyType as ExecutionWorkspaceSummary["strategyType"],
        sourceIssueId: row.sourceIssueId ?? null,
        lastUsedAt: row.lastUsedAt,
      }));
    },

    getById: async (id: string) => {
      const row = await db
        .select()
        .from(executionWorkspaces)
        .where(eq(executionWorkspaces.id, id))
        .then((rows) => rows[0] ?? null);
      return row ? toExecutionWorkspace(row) : null;
    },

    loadEffectiveRuntimeServicesByExecutionWorkspace: async (id: string) => {
      const row = await db
        .select()
        .from(executionWorkspaces)
        .where(eq(executionWorkspaces.id, id))
        .then((rows) => rows[0] ?? null);
      if (!row) return [];
      const grouped = await loadEffectiveRuntimeServicesByExecutionWorkspace(db, row.companyId, [row]);
      return (grouped.get(row.id) ?? []).map(toWorkspaceRuntimeService);
    },

    usesInheritedProjectRuntimeServices: async (id: string) => {
      const row = await db
        .select()
        .from(executionWorkspaces)
        .where(eq(executionWorkspaces.id, id))
        .then((rows) => rows[0] ?? null);
      if (!row) return false;
      return usesInheritedProjectRuntimeServices(row);
    },

    getCloseReadiness: async (id: string): Promise<ExecutionWorkspaceCloseReadiness | null> => {
      const row = await db
        .select()
        .from(executionWorkspaces)
        .where(eq(executionWorkspaces.id, id))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;

      const executionWorkspace = toExecutionWorkspace(row);

      const runtimeServiceRows = await db
        .select()
        .from(workspaceRuntimeServices)
        .where(
          and(
            eq(workspaceRuntimeServices.companyId, executionWorkspace.companyId),
            eq(workspaceRuntimeServices.executionWorkspaceId, executionWorkspace.id),
          ),
        );
      const runtimeServices = runtimeServiceRows.map(toWorkspaceRuntimeService);

      const linkedIssueRows = await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, executionWorkspace.companyId),
            eq(issues.executionWorkspaceId, executionWorkspace.id),
          ),
        );

      const linkedIssueSummaries: ExecutionWorkspaceCloseLinkedIssue[] = linkedIssueRows.map((issue) => ({
        id: issue.id,
        identifier: issue.identifier ?? null,
        title: issue.title,
        status: issue.status,
        isTerminal: TERMINAL_ISSUE_STATUSES.has(issue.status),
      }));

      const projectWorkspace = executionWorkspace.projectWorkspaceId
        ? await db
            .select({
              id: projectWorkspaces.id,
              cwd: projectWorkspaces.cwd,
              cleanupCommand: projectWorkspaces.cleanupCommand,
              isPrimary: projectWorkspaces.isPrimary,
            })
            .from(projectWorkspaces)
            .where(
              and(
                eq(projectWorkspaces.companyId, executionWorkspace.companyId),
                eq(projectWorkspaces.id, executionWorkspace.projectWorkspaceId),
              ),
            )
            .then((rows) => rows[0] ?? null)
        : null;

      const primaryProjectWorkspace = executionWorkspace.projectId
        ? await db
            .select({
              id: projectWorkspaces.id,
            })
            .from(projectWorkspaces)
            .where(
              and(
                eq(projectWorkspaces.companyId, executionWorkspace.companyId),
                eq(projectWorkspaces.projectId, executionWorkspace.projectId),
                eq(projectWorkspaces.isPrimary, true),
              ),
            )
            .then((rows) => rows[0] ?? null)
        : null;

      const projectPolicy = executionWorkspace.projectId
        ? await db
            .select({
              executionWorkspacePolicy: projects.executionWorkspacePolicy,
            })
            .from(projects)
            .where(
              and(
                eq(projects.id, executionWorkspace.projectId),
                eq(projects.companyId, executionWorkspace.companyId),
              ),
            )
            .then((rows) => parseProjectExecutionWorkspacePolicy(rows[0]?.executionWorkspacePolicy))
        : null;

      const config = executionWorkspace.config;
      const { git, warnings: gitWarnings } = await inspectGitCloseReadiness(executionWorkspace);
      const warnings = [...gitWarnings];
      const blockingReasons: string[] = [];
      const isSharedWorkspace = executionWorkspace.mode === "shared_workspace";
      const workspacePath = readNullableString(executionWorkspace.providerRef) ?? readNullableString(executionWorkspace.cwd);
      const resolvedWorkspacePath = workspacePath ? path.resolve(workspacePath) : null;
      const resolvedPrimaryWorkspacePath = projectWorkspace?.cwd ? path.resolve(projectWorkspace.cwd) : null;
      const isProjectPrimaryWorkspace =
        executionWorkspace.projectWorkspaceId != null
        && executionWorkspace.projectWorkspaceId === primaryProjectWorkspace?.id
        && resolvedWorkspacePath != null
        && resolvedPrimaryWorkspacePath != null
        && resolvedWorkspacePath === resolvedPrimaryWorkspacePath;

      const blockingIssues = linkedIssueSummaries.filter((issue) => !issue.isTerminal);
      if (blockingIssues.length > 0) {
        const linkedIssueMessage =
          blockingIssues.length === 1
            ? "This workspace is still linked to an open task."
            : `This workspace is still linked to ${blockingIssues.length} open tasks.`;
        if (isSharedWorkspace) {
          warnings.push(
            `${linkedIssueMessage} Archiving it will detach this shared workspace session from those tasks, but keep the underlying project workspace available.`,
          );
        } else {
          blockingReasons.push(linkedIssueMessage);
        }
      }

      if (isSharedWorkspace) {
        warnings.push(
          "This shared workspace session points at project workspace infrastructure. Archiving it only removes the session record.",
        );
      }

      if (runtimeServices.some((service) => service.status !== "stopped")) {
        warnings.push(
          runtimeServices.length === 1
            ? "Closing this workspace will stop 1 attached runtime service."
            : `Closing this workspace will stop ${runtimeServices.length} attached runtime services.`,
        );
      }

      if (git?.hasDirtyTrackedFiles) {
        warnings.push(
          git.dirtyEntryCount === 1
            ? "The workspace has 1 modified tracked file."
            : `The workspace has ${git.dirtyEntryCount} modified tracked files.`,
        );
      }
      if (git?.hasUntrackedFiles) {
        warnings.push(
          git.untrackedEntryCount === 1
            ? "The workspace has 1 untracked file."
            : `The workspace has ${git.untrackedEntryCount} untracked files.`,
        );
      }
      if (git?.aheadCount && git.aheadCount > 0 && git.isMergedIntoBase === false) {
        warnings.push(
          git.aheadCount === 1
            ? `This workspace is 1 commit ahead of ${git.baseRef ?? "the base ref"} and is not merged.`
            : `This workspace is ${git.aheadCount} commits ahead of ${git.baseRef ?? "the base ref"} and is not merged.`,
        );
      }
      if (git?.behindCount && git.behindCount > 0) {
        warnings.push(
          git.behindCount === 1
            ? `This workspace is 1 commit behind ${git.baseRef ?? "the base ref"}.`
            : `This workspace is ${git.behindCount} commits behind ${git.baseRef ?? "the base ref"}.`,
        );
      }

      const plannedActions: ExecutionWorkspaceCloseAction[] = [
        {
          kind: "archive_record",
          label: "Archive workspace record",
          description: "Keep the execution workspace history and task linkage, but remove it from active workspace lists.",
          command: null,
        },
      ];

      if (runtimeServices.some((service) => service.status !== "stopped")) {
        plannedActions.push({
          kind: "stop_runtime_services",
          label: runtimeServices.length === 1 ? "Stop attached runtime service" : "Stop attached runtime services",
          description:
            runtimeServices.length === 1
              ? `${runtimeServices[0]?.serviceName ?? "A runtime service"} will be stopped before cleanup.`
              : `${runtimeServices.length} runtime services will be stopped before cleanup.`,
          command: null,
        });
      }

      const configuredCleanupCommands: ExecutionWorkspaceCloseAction[] = [
        {
          kind: "cleanup_command",
          label: "Run workspace cleanup command",
          description: "Workspace-specific cleanup runs before teardown.",
          command: config?.cleanupCommand ?? null,
        },
        {
          kind: "cleanup_command",
          label: "Run project workspace cleanup command",
          description: "Project workspace cleanup runs before execution workspace teardown.",
          command: projectWorkspace?.cleanupCommand ?? null,
        },
      ];
      for (const action of configuredCleanupCommands) {
        if (!action.command) continue;
        plannedActions.push(action);
      }

      const teardownCommand = config?.teardownCommand ?? projectPolicy?.workspaceStrategy?.teardownCommand ?? null;
      if (teardownCommand) {
        plannedActions.push({
          kind: "teardown_command",
          label: "Run teardown command",
          description: "Teardown runs after cleanup commands during workspace close.",
          command: teardownCommand,
        });
      }

      if (executionWorkspace.providerType === "git_worktree" && workspacePath) {
        plannedActions.push({
          kind: "git_worktree_remove",
          label: "Remove git worktree",
          description: `We will run git worktree cleanup for ${workspacePath}.`,
          command: `git worktree remove --force ${workspacePath}`,
        });
      }

      if (git?.createdByRuntime && executionWorkspace.branchName) {
        plannedActions.push({
          kind: "git_branch_delete",
          label: "Delete runtime-created branch",
          description: "We will try to delete the runtime-created branch after removing the worktree.",
          command: `git branch -d ${executionWorkspace.branchName}`,
        });
      }

      if (executionWorkspace.providerType === "local_fs" && git?.createdByRuntime && workspacePath) {
        const resolvedPath = path.resolve(workspacePath);
        const resolvedProjectWorkspacePath = projectWorkspace?.cwd ? path.resolve(projectWorkspace.cwd) : null;
        const containsProjectWorkspace = resolvedProjectWorkspacePath
          ? (
              resolvedPath === resolvedProjectWorkspacePath ||
              resolvedProjectWorkspacePath.startsWith(`${resolvedPath}${path.sep}`)
            )
          : false;
        if (containsProjectWorkspace) {
          warnings.push(`We will archive this workspace but keep "${workspacePath}" because it contains the project workspace.`);
        } else {
          plannedActions.push({
            kind: "remove_local_directory",
            label: "Remove runtime-created directory",
            description: `We will remove the runtime-created directory at ${workspacePath}.`,
            command: `rm -rf ${workspacePath}`,
          });
        }
      }

      const state =
        blockingReasons.length > 0
          ? "blocked"
          : warnings.length > 0
            ? "ready_with_warnings"
            : "ready";

      return {
        workspaceId: executionWorkspace.id,
        state,
        blockingReasons,
        warnings,
        linkedIssues: linkedIssueSummaries,
        plannedActions,
        isDestructiveCloseAllowed: blockingReasons.length === 0,
        isSharedWorkspace,
        isProjectPrimaryWorkspace,
        git,
        runtimeServices,
      };
    },

    findActiveTaskOwned,

    create,

    createTaskOwnedIdempotent,

    update,
    updateIfVersion,
    archiveIfVersion,

    /**
     * Atomically claim the per-workspace run lock for `runId`.
     *
     * The claim succeeds (returns the claimed workspace row) when either:
     *   a) the workspace has no current lock  (active_run_id IS NULL), OR
     *   b) the existing lock is stale         (locked_at < now - staleMs).
     *
     * SQL shape:
     *   UPDATE execution_workspaces
     *     SET active_run_id = <runId>, locked_at = now()
     *   WHERE id = <workspaceId>
     *     AND (active_run_id IS NULL OR locked_at < now() - <staleMs> interval)
     *   RETURNING id, active_run_id, locked_at
     *
     * Returns the updated row when the lock was acquired, or `null` when the
     * workspace is currently locked by another run.
     */
    tryClaimWorkspaceRun: async (
      workspaceId: string,
      runId: string,
      opts?: { staleMs?: number },
    ): Promise<{ id: string; activeRunId: string; lockedAt: Date } | null> => {
      const staleMs = opts?.staleMs ?? WORKSPACE_RUN_LOCK_STALE_MS;
      // Build the stale-interval literal.  We express it as `now() - interval
      // '<N> milliseconds'` so it works on any PostgreSQL version without
      // needing a cast.  Drizzle's `sql` template is used to keep this
      // side-effect-free and injectable into the WHERE clause.
      const staleThreshold = sql`now() - interval '${sql.raw(String(staleMs))} milliseconds'`;

      const [row] = await db
        .update(executionWorkspaces)
        .set({
          activeRunId: runId,
          lockedAt: new Date(), // Drizzle serialises this to a timestamptz literal
        })
        .where(
          and(
            eq(executionWorkspaces.id, workspaceId),
            sql`(${executionWorkspaces.activeRunId} IS NULL OR ${executionWorkspaces.lockedAt} < ${staleThreshold})`,
          ),
        )
        .returning({
          id: executionWorkspaces.id,
          activeRunId: executionWorkspaces.activeRunId,
          lockedAt: executionWorkspaces.lockedAt,
        });

      if (!row || !row.activeRunId || !row.lockedAt) return null;
      return { id: row.id, activeRunId: row.activeRunId, lockedAt: row.lockedAt };
    },

    /**
     * Release the per-workspace run lock.
     *
     * Clears active_run_id and locked_at ONLY when the workspace is currently
     * locked by `runId`.  A lock held by a different run is never disturbed —
     * this is intentional: if a stale-timeout reclaim happened while the
     * original holder was still running, the original holder must not
     * accidentally clear the new owner's lock on completion.
     *
     * SQL shape:
     *   UPDATE execution_workspaces
     *     SET active_run_id = NULL, locked_at = NULL
     *   WHERE id = <workspaceId>
     *     AND active_run_id = <runId>
     */
    releaseWorkspaceRun: async (
      workspaceId: string,
      runId: string,
    ): Promise<boolean> => {
      const [row] = await db
        .update(executionWorkspaces)
        .set({ activeRunId: null, lockedAt: null })
        .where(
          and(
            eq(executionWorkspaces.id, workspaceId),
            eq(executionWorkspaces.activeRunId, runId),
          ),
        )
        .returning({ id: executionWorkspaces.id });
      return Boolean(row);
    },

    /**
     * Release every workspace lease still owned by a terminal heartbeat run.
     * The activeRunId predicate is the ownership fence: a late cleanup can
     * never clear a lease that has already been reclaimed by another run.
     */
    releaseWorkspaceRunsForRun: async (runId: string): Promise<string[]> => {
      const rows = await db
        .update(executionWorkspaces)
        .set({ activeRunId: null, lockedAt: null })
        .where(eq(executionWorkspaces.activeRunId, runId))
        .returning({ id: executionWorkspaces.id });
      return rows.map((row) => row.id);
    },
  };
}

export { toExecutionWorkspace, inspectGitCloseReadiness };
