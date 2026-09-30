/**
 * heartbeat-thread-workspace.ts
 *
 * Helpers that route a deliverable task (issues.sourceDiscussionId set) to a
 * THREAD-SCOPED shared execution workspace when the resolved deliverable mode
 * is "reuse_thread".
 *
 * Design principles:
 *   1. GATED — every entry point checks sourceDiscussionId and resolvedMode
 *      before touching anything.  Non-deliverable tasks are completely
 *      unaffected: none of these functions are called for them.
 *   2. MINIMAL surface area — the exported interface is three thin functions
 *      that heartbeat.ts can compose without inlining large logic blobs into
 *      the hot path.
 *   3. NO real I/O here — all DB / git / workspace operations are delegated
 *      to the primitives already proven in execution-workspaces.ts and
 *      workspace-runtime.ts.  This file is pure orchestration.
 */

import type { executionWorkspaceService } from "./execution-workspaces.js";
import type { WORKSPACE_RUN_LOCK_STALE_MS } from "./execution-workspaces.js";
import {
  ensurePersistedExecutionWorkspaceAvailable,
  realizeExecutionWorkspace,
} from "./workspace-runtime.js";
import { resetWorkspaceToCleanState } from "./workspace-runtime.js";
import { isUniqueViolation } from "./db-errors.js";
import { logger } from "../middleware/logger.js";
import type { Db } from "@armyofagents/db";
import { executionWorkspaces } from "@armyofagents/db";
import { and, eq, ne } from "drizzle-orm";

/**
 * DB index name backing the (companyId, threadId) partial unique constraint.
 * Kept as a named constant so the create-race handler and any future caller
 * detect the exact violation rather than string-matching the PG message.
 */
const ACTIVE_THREAD_WORKSPACE_UQ = "execution_workspaces_active_thread_workspace_uq";

// Re-export for callers that import constants alongside the helpers.
export type { WORKSPACE_RUN_LOCK_STALE_MS };

// ─── Types ───────────────────────────────────────────────────────────────────

type ExecutionWorkspacesSvc = ReturnType<typeof executionWorkspaceService>;

/**
 * Parameters shared by all helpers in this module.
 */
export interface ThreadDeliverableWorkspaceInput {
  /** DB instance (passed through to any service that needs it). */
  db: Db;
  executionWorkspacesSvc: ExecutionWorkspacesSvc;
  companyId: string;
  /** issues.sourceDiscussionId – the thread this deliverable belongs to. */
  sourceDiscussionId: string;
  /** Heartbeat run id — used as the lock owner token. */
  runId: string;
  /**
   * Project id resolved for this run (executionProjectId from heartbeat).
   * Required to create a new workspace row.
   */
  resolvedProjectId: string | null;
  /**
   * Workspace base config passed to realizeExecutionWorkspace / ensurePersistedExecutionWorkspaceAvailable.
   * The `source` field must be a valid ExecutionWorkspaceInput source literal.
   */
  realizeBase: {
    baseCwd: string;
    source: "project_primary" | "task_session" | "agent_home";
    projectId: string | null;
    workspaceId: string | null;
    repoUrl: string | null;
    repoRef: string | null;
  };
  /**
   * Full resolved adapter config (for realizeExecutionWorkspace).
   */
  resolvedConfig: Record<string, unknown>;
  /**
   * Agent info (for realizeExecutionWorkspace).
   */
  agent: {
    id: string;
    name: string;
    companyId: string;
  };
  /**
   * Optional workspace operation recorder (mirrors heartbeat.ts usage).
   */
  recorder?: Parameters<typeof ensurePersistedExecutionWorkspaceAvailable>[2];
}

/**
 * Outcome returned by resolveThreadDeliverableWorkspace.
 */
export type ThreadDeliverableWorkspaceOutcome =
  | {
      kind: "workspace_busy";
      /** Human-readable reason for the busy state. */
      reason: string;
    }
  | {
      kind: "resolved";
      /** The realized workspace descriptor (same shape as realizeExecutionWorkspace output). */
      realizedWorkspace: Awaited<ReturnType<typeof realizeExecutionWorkspace>>;
      /** The persisted execution workspace row id – caller must persist/update it. */
      persistedWorkspaceId: string;
      /**
       * The workspace row from DB (full ExecutionWorkspace shape) so the caller
       * can pass it to executionWorkspacesSvc.update / createTaskOwnedIdempotent
       * in the same way the existing path does.
       */
      existingWorkspaceRow: Awaited<ReturnType<ExecutionWorkspacesSvc["getById"]>>;
      /** True when this is a freshly created workspace (realizeExecutionWorkspace created a worktree). */
      created: boolean;
    };

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Look up the active (non-archived) thread-scoped workspace for the given
 * (companyId, threadId) pair, if one exists.
 *
 * Uses a direct DB query rather than routing through executionWorkspaceService
 * because the service's `list` filter does not expose threadId yet.
 */
export async function findActiveThreadWorkspace(
  db: Db,
  companyId: string,
  threadId: string,
): Promise<(typeof executionWorkspaces.$inferSelect) | null> {
  const rows = await db
    .select()
    .from(executionWorkspaces)
    .where(
      and(
        eq(executionWorkspaces.companyId, companyId),
        eq(executionWorkspaces.threadId, threadId),
        ne(executionWorkspaces.status, "archived"),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Run post-claim work with a structural lock-leak guard.
 *
 * The per-workspace run lock is claimed INSIDE this module, but the caller
 * (heartbeat.ts) only records it for its `finally` AFTER `resolveThreadDeliverableWorkspace`
 * returns "resolved".  That means ANY throw between claiming the lock and
 * returning would leak the lock until the 30-minute stale-timeout reclaim —
 * the thread workspace would be unusable for half an hour.
 *
 * Rather than wrap each individual fallible op (reset, etc.) in its own
 * try/catch — which is fragile because a future edit could add a fallible op
 * outside the guard — every claim site funnels its post-claim work through
 * this wrapper.  If `work()` throws, the lock is released (best-effort) and the
 * original error is re-thrown, so the caller's catch path still marks the run
 * failed and the workspace is immediately free for the retried run.
 */
async function runPostClaimGuarded<T>(
  svc: ExecutionWorkspacesSvc,
  workspaceId: string,
  runId: string,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (err) {
    // Release the lock we just claimed before propagating so the workspace is
    // not held until the stale-timeout. Swallow release errors — the original
    // error is what matters, and the stale-timeout is the backstop.
    await svc.releaseWorkspaceRun(workspaceId, runId).catch((releaseErr: unknown) => {
      logger.warn(
        { workspaceId, runId, err: releaseErr },
        "heartbeat-thread-workspace: failed to release lock after post-claim error",
      );
    });
    throw err;
  }
}

// ─── Primary orchestration helper ─────────────────────────────────────────────

/**
 * Resolve (or create) the thread-scoped workspace for a deliverable task, then
 * attempt to claim the per-workspace run lock.
 *
 * DOES NOT execute the adapter.  Returns one of two outcomes:
 *   "workspace_busy" — another run is currently holding the lock; the caller
 *                      should throw a descriptive error so the heartbeat catch
 *                      path marks the run as failed, releases the issue lock,
 *                      and leaves the task retriggerable for the next wakeup.
 *   "resolved"       — lock acquired; the caller must call
 *                      releaseWorkspaceRun(id, runId) in a `finally` block.
 *
 * The "resolved" path guarantees:
 *   • The thread workspace DB row exists (created or reused).
 *   • The git worktree is present on disk (provisioned or reattached).
 *   • resetWorkspaceToCleanState has been called on the worktree (reuse only).
 *   • The run lock is held.
 */
export async function resolveThreadDeliverableWorkspace(
  input: ThreadDeliverableWorkspaceInput,
): Promise<ThreadDeliverableWorkspaceOutcome> {
  const {
    db,
    executionWorkspacesSvc,
    companyId,
    sourceDiscussionId,
    runId,
    resolvedProjectId,
    realizeBase,
    resolvedConfig,
    agent,
    recorder,
  } = input;

  // ── 1. Look up existing thread workspace ──────────────────────────────────
  const existingRow = await findActiveThreadWorkspace(db, companyId, sourceDiscussionId);

  let realizedWorkspace: Awaited<ReturnType<typeof realizeExecutionWorkspace>>;
  let persistedWorkspaceId: string;
  let existingWorkspaceRow: Awaited<ReturnType<ExecutionWorkspacesSvc["getById"]>>;

  if (existingRow) {
    // ── 2a. Reuse existing thread workspace ──────────────────────────────────
    // Build the full ExecutionWorkspace shape from the raw row so we can pass
    // it to ensurePersistedExecutionWorkspaceAvailable (which accepts the
    // service-layer type).
    existingWorkspaceRow = await executionWorkspacesSvc.getById(existingRow.id);
    if (!existingWorkspaceRow) {
      // Should not happen (row was just found), but guard defensively.
      throw new Error(
        `Thread workspace ${existingRow.id} disappeared between lookup and reuse; aborting`,
      );
    }

    // Reattach / verify the git worktree on disk.
    realizedWorkspace = await ensurePersistedExecutionWorkspaceAvailable(
      existingWorkspaceRow,
      realizeBase,
      recorder,
    );

    // Claim the lock BEFORE resetting the working tree so that if we can't
    // claim it we never mutate the working tree for another run.
    const claimed = await executionWorkspacesSvc.tryClaimWorkspaceRun(existingRow.id, runId);
    if (!claimed) {
      logger.info(
        { companyId, threadId: sourceDiscussionId, workspaceId: existingRow.id, runId },
        "heartbeat-thread-workspace: thread workspace lock busy — deferring run",
      );
      return {
        kind: "workspace_busy",
        reason: `Thread workspace ${existingRow.id} is locked by another run; this run will be retried on next wakeup`,
      };
    }

    // Lock acquired — all subsequent fallible work runs inside the guard so a
    // throw releases the lock instead of leaking it to the stale-timeout.
    await runPostClaimGuarded(executionWorkspacesSvc, existingRow.id, runId, async () => {
      // Reset the working tree to a clean state (reuse only — a freshly created
      // worktree has nothing to reset).
      if (realizedWorkspace.worktreePath) {
        await resetWorkspaceToCleanState(realizedWorkspace.worktreePath);
      }
    });

    persistedWorkspaceId = existingRow.id;
  } else {
    // ── 2b. Create a new thread-scoped workspace ─────────────────────────────
    if (!resolvedProjectId) {
      throw new Error(
        "Cannot create thread-scoped workspace: no projectId resolved for this run",
      );
    }

    // Provision a real git worktree via the same realizeExecutionWorkspace path
    // the task-owned path uses.  issueRef is null because this workspace is
    // owned by the thread, not by any single task.
    realizedWorkspace = await realizeExecutionWorkspace({
      base: realizeBase,
      config: resolvedConfig,
      issue: null,
      agent,
      recorder,
    });

    // Persist the thread workspace row.  Idempotent against
    // activeThreadWorkspaceUq — if two deliverables race to create the
    // workspace simultaneously, the loser will catch the unique violation,
    // re-query, and proceed to reuse the winner's row.
    let persistedRow: Awaited<ReturnType<ExecutionWorkspacesSvc["create"]>>;
    try {
      persistedRow = await executionWorkspacesSvc.create({
        companyId,
        projectId: resolvedProjectId,
        threadId: sourceDiscussionId,
        sourceIssueId: null,
        mode: "shared_workspace",
        strategyType: realizedWorkspace.strategy === "git_worktree" ? "git_worktree" : "project_primary",
        name: `thread-${sourceDiscussionId.slice(0, 8)}`,
        status: "active",
        cwd: realizedWorkspace.cwd,
        repoUrl: realizedWorkspace.repoUrl,
        baseRef: realizedWorkspace.repoRef,
        branchName: realizedWorkspace.branchName,
        providerType: realizedWorkspace.strategy === "git_worktree" ? "git_worktree" : "local_fs",
        providerRef: realizedWorkspace.worktreePath,
        lastUsedAt: new Date(),
        openedAt: new Date(),
        metadata: {
          source: realizedWorkspace.source,
          createdByRuntime: realizedWorkspace.created,
        },
      });
    } catch (createErr) {
      // Unique violation on activeThreadWorkspaceUq — another deliverable raced
      // us and won.  Re-query and fall back to reuse.  Use the canonical
      // detector (checks SQLSTATE 23505 on both the error and `err.cause`,
      // plus the specific constraint name) rather than string-matching the
      // PG message, which is not a stable contract.
      if (!isUniqueViolation(createErr, ACTIVE_THREAD_WORKSPACE_UQ)) throw createErr;

      logger.info(
        { companyId, threadId: sourceDiscussionId, runId },
        "heartbeat-thread-workspace: raced on thread workspace creation — re-querying existing row",
      );
      const racedRow = await findActiveThreadWorkspace(db, companyId, sourceDiscussionId);
      if (!racedRow) throw createErr;

      existingWorkspaceRow = await executionWorkspacesSvc.getById(racedRow.id);
      if (!existingWorkspaceRow) throw createErr;

      // Reattach the worktree provisioned by the winner.
      realizedWorkspace = await ensurePersistedExecutionWorkspaceAvailable(
        existingWorkspaceRow,
        realizeBase,
        recorder,
      );

      const claimed = await executionWorkspacesSvc.tryClaimWorkspaceRun(racedRow.id, runId);
      if (!claimed) {
        return {
          kind: "workspace_busy",
          reason: `Thread workspace ${racedRow.id} is locked by another run after race; this run will be retried on next wakeup`,
        };
      }

      // Lock acquired — guard all post-claim work so a throw releases it.
      await runPostClaimGuarded(executionWorkspacesSvc, racedRow.id, runId, async () => {
        if (realizedWorkspace.worktreePath) {
          await resetWorkspaceToCleanState(realizedWorkspace.worktreePath);
        }
      });

      return {
        kind: "resolved",
        realizedWorkspace,
        persistedWorkspaceId: racedRow.id,
        existingWorkspaceRow,
        created: false,
      };
    }

    if (!persistedRow) {
      throw new Error("Thread workspace DB insert returned no row");
    }

    // Claim the lock for the newly created workspace.
    const claimed = await executionWorkspacesSvc.tryClaimWorkspaceRun(persistedRow.id, runId);
    if (!claimed) {
      // Theoretically impossible for a brand-new row (activeRunId starts NULL),
      // but handle it defensively.
      return {
        kind: "workspace_busy",
        reason: `Thread workspace ${persistedRow.id} could not be locked after creation; this run will be retried on next wakeup`,
      };
    }

    // A freshly provisioned worktree has nothing to reset, so there is NO
    // fallible post-claim work on this path: the only statements between the
    // claim above and the `return` below are the two assignments here (which
    // cannot throw).  If a future edit adds fallible work after the claim on
    // this path, it MUST be wrapped in runPostClaimGuarded (see the reuse and
    // race paths) so the lock is released on throw instead of leaking to the
    // 30-minute stale-timeout.
    existingWorkspaceRow = persistedRow;
    persistedWorkspaceId = persistedRow.id;
  }

  return {
    kind: "resolved",
    realizedWorkspace,
    persistedWorkspaceId,
    existingWorkspaceRow,
    created: !existingRow,
  };
}
