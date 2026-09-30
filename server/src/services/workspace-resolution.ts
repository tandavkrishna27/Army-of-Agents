import fs from "node:fs/promises";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { issues, projects, projectWorkspaces } from "@armyofagents/db";
import type {
  IssueExecutionWorkspaceSettings,
  ProjectExecutionWorkspacePolicy,
} from "@armyofagents/shared";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";
import type { ResolvedWorkspaceForRun } from "./heartbeat-session.js";
import {
  gateProjectExecutionWorkspacePolicy,
  parseIssueExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
  resolveExecutionWorkspaceMode,
} from "./execution-workspace-policy.js";
import { instanceSettingsService } from "./instance-settings.js";

// AoA canonical name. Rows still using the legacy paperclip name are read
// transparently via isRepoOnlySentinel below.
const REPO_ONLY_CWD_SENTINEL = "/__aoa_repo_only__";
const LEGACY_REPO_ONLY_CWD_SENTINEL = "/__paperclip_repo_only__";

/**
 * True if `cwd` is the "repo-only / no-local-cwd" sentinel,
 * regardless of whether the row holds the legacy or new value.
 */
export function isRepoOnlySentinel(cwd: string | null | undefined): boolean {
  return cwd === REPO_ONLY_CWD_SENTINEL || cwd === LEGACY_REPO_ONLY_CWD_SENTINEL;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export type ExecutionWorkspacePolicyInputs = {
  /** Instance experimental flag; gates issue settings + the project policy. */
  isolatedWorkspacesEnabled: boolean;
  /** Parsed issue-level settings, or null when isolated workspaces are off. */
  issueExecutionWorkspaceSettings: IssueExecutionWorkspaceSettings | null;
  /** Gated project policy; null when isolated workspaces are off or there is no project. */
  projectExecutionWorkspacePolicy: ProjectExecutionWorkspacePolicy | null;
  /**
   * The project's `env` column, returned for the caller's downstream env merge.
   * The merge itself is NOT part of this block (see divergence 2 below) — the
   * caller decides whether to consume this. null for a project-less run.
   */
  projectEnv: unknown;
  /** The resolved execution-workspace mode fed to `resolveWorkspaceForRun`. */
  executionWorkspaceMode: ReturnType<typeof resolveExecutionWorkspaceMode>;
  /** Echoed back unchanged — the project id the policy was read against. */
  executionProjectId: string | null;
};

/**
 * Resolve the execution-workspace POLICY INPUTS that precede
 * `resolveWorkspaceForRun`: the instance flag, the parsed issue settings, the
 * gated project policy, and the resolved mode.
 *
 * UNIFIES the block that heartbeat (`heartbeat.ts`, the "Execution workspace
 * policy resolution" section) and the crew runner (`crew-workspace.ts`)
 * previously implemented twice. The two paths read overlapping-but-different
 * inputs; those differences are handled OUTSIDE this function, so the block
 * itself is now identical for both callers:
 *
 *   1. Per-assignee legacy `useProjectWorkspace` override — a PARAMETER
 *      (`legacyUseProjectWorkspace`). Heartbeat passes the issue-assignee
 *      adapter override; crew has no such concept and passes null.
 *   2. `projects.env` merge — DOWNSTREAM of this block. This function always
 *      reads and returns `projectEnv`; the caller decides whether to merge it
 *      into the adapter config (heartbeat does; crew does not). Reading the
 *      extra column is inert for the crew path (it ignores the value).
 *   3. `buildExecutionWorkspaceAdapterConfig` — DOWNSTREAM of this block, run
 *      only by heartbeat after the resolver. This function returns the policy +
 *      settings + mode it needs; crew never calls it.
 *   4. Project derivation — the CALLER resolves `executionProjectId` and the raw
 *      issue settings before calling. Heartbeat takes them from its in-memory
 *      issue context / wake context; crew reads the task's project or the
 *      thread's scope. Both feed the same identical policy read here.
 *
 * Company-scoped, so a caller-supplied project id can never select another
 * tenant's row.
 */
export async function resolveExecutionWorkspacePolicyInputs(
  db: Db,
  input: {
    companyId: string;
    /** Resolved by the caller (task project, thread scope, or wake context). */
    executionProjectId: string | null;
    /** Raw `issues.executionWorkspaceSettings`; parsed + gated here. */
    rawIssueExecutionWorkspaceSettings: unknown;
    /** Divergence 1: heartbeat's assignee override, or null for crew. */
    legacyUseProjectWorkspace: boolean | null;
  },
): Promise<ExecutionWorkspacePolicyInputs> {
  const { companyId, executionProjectId, rawIssueExecutionWorkspaceSettings, legacyUseProjectWorkspace } =
    input;

  const isolatedWorkspacesEnabled = (await instanceSettingsService(db).getExperimental())
    .enableIsolatedWorkspaces;

  const issueExecutionWorkspaceSettings = isolatedWorkspacesEnabled
    ? parseIssueExecutionWorkspaceSettings(rawIssueExecutionWorkspaceSettings)
    : null;

  const projectRow = executionProjectId
    ? await db
        .select({ executionWorkspacePolicy: projects.executionWorkspacePolicy, env: projects.env })
        .from(projects)
        .where(and(eq(projects.id, executionProjectId), eq(projects.companyId, companyId)))
        .then((rows) => rows[0] ?? null)
    : null;

  const projectExecutionWorkspacePolicy = projectRow
    ? gateProjectExecutionWorkspacePolicy(
        parseProjectExecutionWorkspacePolicy(projectRow.executionWorkspacePolicy),
        isolatedWorkspacesEnabled,
      )
    : null;

  const projectEnv = projectRow?.env ?? null;

  const executionWorkspaceMode = resolveExecutionWorkspaceMode({
    projectPolicy: projectExecutionWorkspacePolicy,
    issueSettings: issueExecutionWorkspaceSettings,
    legacyUseProjectWorkspace,
  });

  return {
    isolatedWorkspacesEnabled,
    issueExecutionWorkspaceSettings,
    projectExecutionWorkspacePolicy,
    projectEnv,
    executionWorkspaceMode,
    executionProjectId,
  };
}

/**
 * Resolve the directory a run executes in.
 *
 * EXTRACTED from `heartbeatService()`'s inner closure (T5) so the CREW runner
 * can reuse the exact org resolution instead of duplicating it — a divergence
 * between the two paths is a bug, and the crew path previously had NO
 * resolution at all (cwd fell through to `process.cwd()`, the AoA server's own
 * repository — Decision #110 clause 7). The body is unchanged apart from `db`
 * moving from the closure to a parameter and the agent shape narrowing to the
 * two fields it actually reads.
 *
 * Precedence:
 *   1. an existing project workspace directory (`project_primary`)
 *   2. the previous session's cwd, if it still exists (`task_session`)
 *   3. the per-agent home under the AoA instance root (`agent_home`)
 *
 * It NEVER returns nothing: (3) is a floor, created eagerly. That floor is what
 * keeps `process.cwd()` unreachable for callers that populate
 * `context.paperclipWorkspace` from this result.
 */
export async function resolveWorkspaceForRun(
  db: Db,
  agent: { id: string; companyId: string },
  context: Record<string, unknown>,
  previousSessionParams: Record<string, unknown> | null,
  opts?: { useProjectWorkspace?: boolean | null },
): Promise<ResolvedWorkspaceForRun> {
  const issueId = readNonEmptyString(context.issueId);
  const contextProjectId = readNonEmptyString(context.projectId);
  const issueProjectId = issueId
    ? await db
        .select({ projectId: issues.projectId })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
        .then((rows) => rows[0]?.projectId ?? null)
    : null;
  const resolvedProjectId = issueProjectId ?? contextProjectId;
  const useProjectWorkspace = opts?.useProjectWorkspace !== false;
  const workspaceProjectId = useProjectWorkspace ? resolvedProjectId : null;

  const projectWorkspaceRows = workspaceProjectId
    ? await db
        .select()
        .from(projectWorkspaces)
        .where(
          and(
            eq(projectWorkspaces.companyId, agent.companyId),
            eq(projectWorkspaces.projectId, workspaceProjectId),
          ),
        )
        .orderBy(asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id))
    : [];

  const workspaceHints = projectWorkspaceRows.map((workspace) => ({
    workspaceId: workspace.id,
    cwd: readNonEmptyString(workspace.cwd),
    repoUrl: readNonEmptyString(workspace.repoUrl),
    repoRef: readNonEmptyString(workspace.repoRef),
  }));

  if (projectWorkspaceRows.length > 0) {
    const missingProjectCwds: string[] = [];
    let hasConfiguredProjectCwd = false;
    for (const workspace of projectWorkspaceRows) {
      const projectCwd = readNonEmptyString(workspace.cwd);
      if (!projectCwd || isRepoOnlySentinel(projectCwd)) {
        continue;
      }
      hasConfiguredProjectCwd = true;
      const projectCwdExists = await fs
        .stat(projectCwd)
        .then((stats) => stats.isDirectory())
        .catch(() => false);
      if (projectCwdExists) {
        return {
          cwd: projectCwd,
          source: "project_primary" as const,
          projectId: resolvedProjectId,
          workspaceId: workspace.id,
          repoUrl: workspace.repoUrl,
          repoRef: workspace.repoRef,
          workspaceHints,
          warnings: [],
        };
      }
      missingProjectCwds.push(projectCwd);
    }

    const fallbackCwd = resolveDefaultAgentWorkspaceDir(agent.id);
    await fs.mkdir(fallbackCwd, { recursive: true });
    const warnings: string[] = [];
    if (missingProjectCwds.length > 0) {
      const firstMissing = missingProjectCwds[0];
      const extraMissingCount = Math.max(0, missingProjectCwds.length - 1);
      warnings.push(
        extraMissingCount > 0
          ? `Project workspace path "${firstMissing}" and ${extraMissingCount} other configured path(s) are not available yet. Using fallback workspace "${fallbackCwd}" for this run.`
          : `Project workspace path "${firstMissing}" is not available yet. Using fallback workspace "${fallbackCwd}" for this run.`,
      );
    } else if (!hasConfiguredProjectCwd) {
      warnings.push(
        `Project workspace has no local cwd configured. Using fallback workspace "${fallbackCwd}" for this run.`,
      );
    }
    return {
      cwd: fallbackCwd,
      source: "project_primary" as const,
      projectId: resolvedProjectId,
      workspaceId: projectWorkspaceRows[0]?.id ?? null,
      repoUrl: projectWorkspaceRows[0]?.repoUrl ?? null,
      repoRef: projectWorkspaceRows[0]?.repoRef ?? null,
      workspaceHints,
      warnings,
    };
  }

  const sessionCwd = readNonEmptyString(previousSessionParams?.cwd);
  if (sessionCwd) {
    const sessionCwdExists = await fs
      .stat(sessionCwd)
      .then((stats) => stats.isDirectory())
      .catch(() => false);
    if (sessionCwdExists) {
      return {
        cwd: sessionCwd,
        source: "task_session" as const,
        projectId: resolvedProjectId,
        workspaceId: readNonEmptyString(previousSessionParams?.workspaceId),
        repoUrl: readNonEmptyString(previousSessionParams?.repoUrl),
        repoRef: readNonEmptyString(previousSessionParams?.repoRef),
        workspaceHints,
        warnings: [],
      };
    }
  }

  const cwd = resolveDefaultAgentWorkspaceDir(agent.id);
  await fs.mkdir(cwd, { recursive: true });
  const warnings: string[] = [];
  if (sessionCwd) {
    warnings.push(
      `Saved session workspace "${sessionCwd}" is not available. Using fallback workspace "${cwd}" for this run.`,
    );
  } else if (resolvedProjectId) {
    warnings.push(
      `No project workspace directory is currently available for this issue. Using fallback workspace "${cwd}" for this run.`,
    );
  } else {
    warnings.push(
      `No project or prior session workspace was available. Using fallback workspace "${cwd}" for this run.`,
    );
  }
  return {
    cwd,
    source: "agent_home" as const,
    projectId: resolvedProjectId,
    workspaceId: null,
    repoUrl: null,
    repoRef: null,
    workspaceHints,
    warnings,
  };
}
