import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import type { Db } from "@armyofagents/db";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  assets,
  authUsers,
  companies,
  companyMemberships,
  discussions,
  executionWorkspaces,
  goals,
  heartbeatRuns,
  internalAgentRuns,
  issueAttachments,
  issueLabels,
  issueComments,
  issueMonitors,
  issueReadStates,
  issues,
  labels,
  projectWorkspaces,
  projects,
  taskDependencies,
  userRoles,
  workQuestionContinuationRequests,
  workQuestions,
} from "@armyofagents/db";
import { extractProjectMentionIds, isUuidLike } from "@armyofagents/shared";
import type { AgentCompletionPolicy, AgentCompletionPolicySource } from "@armyofagents/shared";
import type { ResolvedAgentCompletionPolicy } from "./agent-completion-policy.js";
import type {
  IssueCommentAuthorType,
  IssueCommentMetadata,
  IssueCommentPresentation,
} from "@armyofagents/shared";
import { requestTrackedProcessTermination } from "@armyofagents/adapter-utils/server-utils";
import {
  dispatchCancel,
  getDistributedCancellationPort,
} from "./distributed-cancellation-port.js";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { dependencyService, TERMINAL_STATUSES } from "./dependencies.js";
import { enqueueIssueAssigneeWakeup } from "./issue-assignee-wakeup.js";
import { instanceSettingsService } from "./instance-settings.js";
import { deriveIssueUserContext } from "./issue-user-context.js";
import {
  enforceIssueExecutionWorkspaceOverridePolicy,
  issueExecutionWorkspaceModeForPersistedWorkspace,
  parseIssueExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
} from "./execution-workspace-policy.js";
import { hubItemsService } from "./hub-items.js";
import { enqueueCommentWakeupOutbox, markCommentWakeupsReady as markCommentWakeupsReadyOutbox, type CommentWakeupTarget } from "./comment-wakeup-outbox.js";
import { shouldDispatchIssueWakeup } from "../routes/issues-planning-mode-dispatch.js";
import {
  buildInitialIssueMonitorFields,
  buildIssueMonitorClearedPatch,
  normalizeIssueMonitorPolicy,
} from "./issue-execution-policy.js";
import {
  createIssueContextBundle,
  type CreateIssueContextBundleItemInput,
} from "./issue-context-bundles.js";
import { assertAgentStatusTransition } from "./issue-agent-status-guard.js";
import type { CompletionPolicyCreatorSource } from "./agent-completion-policy.js";
import { publishIssueStatusChanged } from "./live-events.js";
import {
  crewAssigneeExists,
  notCrewAssigned,
  resolveTaskScope,
  scopeUsesCrewJoin,
  type TaskScope,
} from "./issue-crew-scope.js";

const ALL_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"];

async function cancelActiveWorkQuestionsForIssue(
  tx: Db,
  input: {
    companyId: string;
    issueId: string;
    reason: "done" | "cancelled" | "deleted" | "reassigned";
  },
) {
  const now = new Date();
  const cancelledOpen = await tx.update(workQuestions).set({
    status: "cancelled",
    continuationStatus: "not_needed",
    continuationError: `Task ${input.reason}`,
    version: sql`${workQuestions.version} + 1`,
    updatedAt: now,
  }).where(and(
    eq(workQuestions.companyId, input.companyId),
    eq(workQuestions.issueId, input.issueId),
    eq(workQuestions.status, "open"),
  )).returning({ id: workQuestions.id });

  const stoppedAnswered = await tx.update(workQuestions).set({
    continuationStatus: "not_needed",
    continuationError: `Task ${input.reason}`,
    version: sql`${workQuestions.version} + 1`,
    updatedAt: now,
  }).where(and(
    eq(workQuestions.companyId, input.companyId),
    eq(workQuestions.issueId, input.issueId),
    eq(workQuestions.status, "answered"),
    inArray(workQuestions.continuationStatus, ["pending", "dispatched"]),
  )).returning({ id: workQuestions.id });

  const questionIds = [...new Set([...cancelledOpen, ...stoppedAnswered].map((row) => row.id))];
  if (questionIds.length === 0) return [] as string[];

  const continuationKeys = await tx
    .select({ key: workQuestionContinuationRequests.downstreamIdempotencyKey })
    .from(workQuestionContinuationRequests)
    .where(and(
      eq(workQuestionContinuationRequests.companyId, input.companyId),
      inArray(workQuestionContinuationRequests.questionId, questionIds),
    ));

  await tx.update(workQuestionContinuationRequests).set({
    status: "cancelled",
    claimedAt: null,
    lastError: `Task ${input.reason}`,
    updatedAt: now,
  }).where(and(
    eq(workQuestionContinuationRequests.companyId, input.companyId),
    inArray(workQuestionContinuationRequests.questionId, questionIds),
    inArray(workQuestionContinuationRequests.status, ["pending", "claimed", "dispatched"]),
  ));

  const wakeupKeys = [...new Set(continuationKeys.map((row) => row.key))];
  let runningRunIds: string[] = [];
  if (wakeupKeys.length > 0) {
    const wakeups = await tx
      .select({ id: agentWakeupRequests.id, runId: agentWakeupRequests.runId })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, input.companyId),
        inArray(agentWakeupRequests.idempotencyKey, wakeupKeys),
      ));
    const wakeupIds = wakeups.map((row) => row.id);
    const referencedRunIds = wakeups
      .map((row) => row.runId)
      .filter((runId): runId is string => Boolean(runId));
    if (wakeupIds.length > 0) {
      // Task closure and expired-wakeup recovery both lock wakeups before runs.
      // Keeping that order avoids a run <-> wakeup deadlock under concurrency.
      await tx.update(agentWakeupRequests).set({
        status: "cancelled",
        finishedAt: now,
        error: `Task ${input.reason}`,
        claimToken: null,
        leaseExpiresAt: null,
        updatedAt: now,
      }).where(and(
        eq(agentWakeupRequests.companyId, input.companyId),
        inArray(agentWakeupRequests.status, ["queued", "claimed", "processing", "deferred_issue_execution"]),
        inArray(agentWakeupRequests.id, wakeupIds),
      ));
      const activeRuns = await tx
        .select({ id: heartbeatRuns.id, status: heartbeatRuns.status, executionOwner: heartbeatRuns.executionOwner })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.companyId, input.companyId),
          or(
            inArray(heartbeatRuns.wakeupRequestId, wakeupIds),
            ...(referencedRunIds.length > 0 ? [inArray(heartbeatRuns.id, referencedRunIds)] : []),
          ),
          inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
        ));
      runningRunIds = activeRuns
        .filter((run) => run.status === "running")
        .map((run) => run.id);
      const activeRunIds = activeRuns.map((run) => run.id);
      // CLI-006 (H3) — the issue EXECUTION LOCK must not be handed back while a
      // distributed attempt is still executing. Releasing it lets a different
      // agent check the same task out and run it concurrently; the per-agent
      // concurrency clamp does not help, because it is a different agent. The
      // sibling path in `heartbeat.cancelRun` already gets this right.
      //
      // The earlier note "the release must cover both subsets" was wrong: it
      // assumed an ineligible task cannot be claimed, but for `reassigned` the
      // task stays perfectly eligible — just for someone else. The projector
      // releases the lock when the attempt's real terminal arrives.
      const legacyRunIds = activeRuns
        .filter((run) => run.executionOwner !== "distributed")
        .map((run) => run.id);
      if (activeRunIds.length > 0) {
        // CLI-006 (4-D2) — this is a BULK terminal write that bypasses
        // `setRunStatus` entirely, so the CLI-006 terminal latch does not protect
        // it. Exclude distributed-owned runs IN THE PREDICATE rather than
        // partitioning in JS: the attempt is their terminal authority, and
        // latching `cancelled` here would make the projector discard the real
        // terminal when it arrives. The `or(isNull, ne)` shape mirrors
        // `resolveCancelRoute` — an unrecognised owner value reads as legacy, so
        // a future owner kind this build does not understand is still cancelled
        // normally rather than silently skipped.
        await tx.update(heartbeatRuns).set({
          status: "cancelled",
          finishedAt: now,
          error: `Task ${input.reason}`,
          errorCode: "task_no_longer_eligible",
          updatedAt: now,
        }).where(and(
          eq(heartbeatRuns.companyId, input.companyId),
          inArray(heartbeatRuns.id, activeRunIds),
          inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
          or(isNull(heartbeatRuns.executionOwner), ne(heartbeatRuns.executionOwner, "distributed")),
        ));
        await tx.update(issues).set({
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: now,
        }).where(and(
          eq(issues.companyId, input.companyId),
          eq(issues.id, input.issueId),
          inArray(issues.executionRunId, legacyRunIds),
        ));
      }
    }
    const crewRunMatch = or(
      inArray(internalAgentRuns.continuationIdempotencyKey, wakeupKeys),
      ...(referencedRunIds.length > 0 ? [inArray(internalAgentRuns.id, referencedRunIds)] : []),
      ...wakeupKeys.map((key) => sql<boolean>`starts_with(
        ${internalAgentRuns.continuationIdempotencyKey},
        ${`${key}:crew-attempt:`}
      )`),
    );
    const activeCrewRuns = await tx
      .select({ id: internalAgentRuns.id })
      .from(internalAgentRuns)
      .where(and(
        eq(internalAgentRuns.companyId, input.companyId),
        crewRunMatch,
        eq(internalAgentRuns.status, "running"),
      ));
    if (activeCrewRuns.length > 0) {
      const activeCrewRunIds = activeCrewRuns.map((run) => run.id);
      runningRunIds = [...new Set([...runningRunIds, ...activeCrewRunIds])];
      await tx.update(internalAgentRuns).set({
        status: "cancelled",
        errorMessage: `Task ${input.reason}`,
        completedAt: now,
      }).where(and(
        eq(internalAgentRuns.companyId, input.companyId),
        inArray(internalAgentRuns.id, activeCrewRunIds),
        eq(internalAgentRuns.status, "running"),
      ));
    }
  }

  for (const questionId of questionIds) {
    await tx.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "system",
      actorId: "task-lifecycle",
      action: "work_question.cancelled_by_task",
      entityType: "work_question",
      entityId: questionId,
      details: { issueId: input.issueId, reason: input.reason },
    });
    await hubItemsService(tx).reconcile(input.companyId, {
      sourceType: "work_question",
      sourceId: questionId,
    });
  }
  return runningRunIds;
}

function terminateTrackedRuns(runIds: string[]) {
  for (const runId of runIds) {
    requestTrackedProcessTermination(runId);
  }
}

/**
 * CLI-006 (4-D2) — the distributed half of the same stop.
 *
 * `terminateTrackedRuns` signals an in-process child, which a distributed attempt
 * never has, so without this a task going ineligible left the worker running with
 * nothing to stop it. Runs AFTER the transaction commits, deliberately: the fence
 * revoke goes through `runInTenant` on a different pool and must not be entangled
 * with this transaction's lifetime, and reading the rows post-commit sees the
 * state that actually landed.
 *
 * Best-effort and never throws into the caller — the task change has already
 * committed, and `onError:"skip"` keeps one unreachable attempt from aborting the
 * rest of the batch.
 */
async function routeDistributedCancelsForRuns(
  db: Db,
  runIds: string[],
  reason: string,
): Promise<void> {
  if (runIds.length === 0) return;
  // NO `if (!port) return;` HERE — that guard defeated the handling written for exactly this
  // case. `dispatchCancel` takes `port: DistributedCancellationPort | undefined` by design and
  // answers LEGACY with `writeLegacyTerminal: true`, documented as "the legacy write is the only
  // convergent outcome" for "a control-plane restart with the distributed flag off leaves marked
  // runs behind and no port". Returning early meant this fifth writer never reached that — in
  // precisely the post-rollback state it exists for — so the H1 convergence block below (latch
  // `cancelled`, release the execution lock) was dead when it mattered, pinning the run at
  // `running` and, at the permanent concurrency default of 1, stopping that agent dispatching
  // again. Found by the Wave-3→4 gate clause-3 review.
  //
  // Cost of removing it: one indexed SELECT on terminate paths. The query filters on
  // `executionOwner = "distributed"`, so a deployment that never enabled distributed execution
  // matches zero rows and the loop body never runs.
  const port = getDistributedCancellationPort();
  const unprojectedRunIds: string[] = [];
  const rows = await db
    .select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      executionOwner: heartbeatRuns.executionOwner,
      distributedJobId: heartbeatRuns.distributedJobId,
    })
    .from(heartbeatRuns)
    .where(and(inArray(heartbeatRuns.id, runIds), eq(heartbeatRuns.executionOwner, "distributed")));
  for (const row of rows) {
    const outcome = await dispatchCancel({
      run: row,
      companyId: row.companyId,
      reason,
      graceful: true,
      port,
      onError: "skip",
    });
    if (outcome.degraded) {
      logger.warn(
        { runId: row.id, jobId: row.distributedJobId, degraded: outcome.degraded },
        "[CLI-006] distributed cancel degraded for ineligible task",
      );
    }
    // H1 made this flag load-bearing: `true` means NOTHING will ever project a
    // terminal for this attempt (the repo finalized it directly with row updates
    // and wrote no `job_events` row, or it was already terminal / not found), so
    // THIS caller owns the terminal. The four heartbeat writers consume it via
    // `routeRunCancellation`; this fifth one used to read only `.degraded` and
    // drop it, which pinned the run at `running` with no convergence path —
    // no worker event, the reaper standing down on the marker, and the stale-lock
    // breaker covering only queued/scheduled_retry. Worse than a stranded row:
    // `countRunningRunsForAgent` counts it with no owner filter, so at the
    // permanent HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT of 1 the canary agent then
    // never dispatches again.
    if (outcome.writeLegacyTerminal) unprojectedRunIds.push(row.id);
  }

  // Post-commit, and only for the subset nothing will project. Latching here is
  // safe precisely BECAUSE those statuses mean no projector terminal is coming,
  // so the in-transaction block's "latching would discard the real terminal"
  // reasoning does not apply to them.
  if (unprojectedRunIds.length > 0) {
    const now = new Date();
    await db.update(heartbeatRuns).set({
      status: "cancelled",
      finishedAt: now,
      error: `Task ${reason}`,
      errorCode: "task_no_longer_eligible",
      updatedAt: now,
    }).where(and(
      inArray(heartbeatRuns.id, unprojectedRunIds),
      inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
    ));
    // Release the execution lock the in-transaction block deliberately withheld.
    // On the delete path this is a harmless no-op — the issue is already gone.
    await db.update(issues).set({
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
      updatedAt: now,
    }).where(inArray(issues.executionRunId, unprojectedRunIds));
  }
}

function monitorClearReasonForIssue(input: {
  status: string;
  assigneeAgentId: string | null;
  previousAssigneeAgentId?: string | null;
}) {
  if (input.status === "done") return "done";
  if (input.status === "cancelled") return "cancelled";
  if (!["in_progress", "in_review"].includes(input.status)) return "invalid_status";
  if (!input.assigneeAgentId) return "invalid_assignee";
  if (
    input.previousAssigneeAgentId !== undefined &&
    input.assigneeAgentId !== input.previousAssigneeAgentId
  ) {
    return "invalid_assignee";
  }
  return null;
}

function assertTransition(from: string, to: string) {
  if (from === to) return;
  if (!ALL_ISSUE_STATUSES.includes(to)) {
    throw conflict(`Unknown issue status: ${to}`);
  }
}

function applyStatusSideEffects(
  status: string | undefined,
  patch: Partial<typeof issues.$inferInsert>,
): Partial<typeof issues.$inferInsert> {
  if (!status) return patch;

  if (status === "in_progress" && !patch.startedAt) {
    patch.startedAt = new Date();
  }
  if (status === "done") {
    patch.completedAt = new Date();
  }
  if (status === "cancelled") {
    patch.cancelledAt = new Date();
  }
  return patch;
}

export interface IssueFilters {
  status?: string;
  assigneeAgentId?: string;
  assigneeUserId?: string;
  responsibleUserId?: string;
  createdByUserId?: string;
  touchedByUserId?: string;
  unreadForUserId?: string;
  projectId?: string;
  labelId?: string;
  q?: string;
  /**
   * Filter by parent task. Use `null` to select only top-level tasks (no parent).
   * Use a UUID string to select children of a specific parent.
   * Omit to include all tasks regardless of parentage.
   */
  parentId?: string | null;
  /**
   * Board-surface scope (2026-06-02 unified crew/org separation, T-A). The ONE
   * dial that decides whether a list query shows crew-agent tasks, org/human
   * tasks, or both. Resolved by `resolveTaskScope()` with a **fail-safe default
   * of `'org'`** when undefined.
   *  - `'org'`  (default): org agents + humans + unassigned. Pushes
   *    `notCrewAssigned`. Every generic `list(companyId)` caller is org/human-only
   *    with zero per-call changes; a forgotten filter now HIDES crew (safe).
   *  - `'crew'` : active-crew-assigned tasks only. The Crew Board. Pushes
   *    `crewAssigneeExists` AND opts into the `sourceThreadTitle` LEFT JOIN.
   *  - `'all'`  : no scope predicate. The task GRAPH (deps, goal rollups, search,
   *    delete-safety, portability) and explicit admin/debug/Commander paths.
   */
  taskScope?: TaskScope;
  /**
   * @deprecated Back-compat alias for `taskScope: 'crew'`. `crewBoard === true`
   * resolves to the crew scope (keeps the existing CrewBoard UI param working).
   * If both are passed, `taskScope` wins. Prefer `taskScope` in new code.
   *
   * Unified Crew Board (2026-06-02): the crew scope is the flat tracker for ALL
   * crew-agent work — tasks from discussions, goals, routines, MCP, and direct
   * capture. The crew predicate is "assignee is an active `kind='aoa'` agent that
   * is not terminated", and it enables the LEFT JOIN that populates the
   * `sourceThreadTitle` denormalization so discussion-sourced cards keep their
   * source-thread label.
   */
  crewBoard?: boolean;
}

export function pickWorkspaceInheritanceSourceIssueId(input: {
  inheritExecutionWorkspaceFromIssueId?: string | null;
  parentId?: string | null;
}): string | null {
  return input.inheritExecutionWorkspaceFromIssueId ?? input.parentId ?? null;
}

export interface WorkspaceInheritanceSource {
  executionWorkspaceId: string | null;
  executionWorkspaceSettings: Record<string, unknown> | null;
}

export interface WorkspaceInheritanceWorkspace {
  mode: string | null;
  companyId: string;
  projectId: string | null;
  status: string;
}

export interface ResolvedWorkspaceInheritance {
  executionWorkspaceId: string;
  executionWorkspacePreference: "reuse_existing";
  executionWorkspaceSettings: Record<string, unknown>;
}

type IssueWorkspaceFields = {
  executionWorkspaceId?: string | null;
  executionWorkspacePreference?: string | null;
  executionWorkspaceSettings?: Record<string, unknown> | null;
};

export function resolveExecutionWorkspaceInheritance(input: {
  sourceIssue: WorkspaceInheritanceSource | null;
  sourceWorkspace: WorkspaceInheritanceWorkspace | null;
  targetCompanyId: string;
  targetProjectId: string | null;
  isolatedWorkspacesEnabled: boolean;
  hasExplicitOverride: boolean;
}): ResolvedWorkspaceInheritance | null {
  if (!input.sourceIssue) return null;
  if (!input.isolatedWorkspacesEnabled) return null;
  if (input.hasExplicitOverride) return null;
  if (!input.sourceIssue.executionWorkspaceId) return null;
  if (!input.sourceWorkspace) return null;
  if (input.sourceWorkspace.companyId !== input.targetCompanyId) return null;
  if (input.sourceWorkspace.projectId !== input.targetProjectId) return null;
  if (input.sourceWorkspace.status === "archived") return null;
  return {
    executionWorkspaceId: input.sourceIssue.executionWorkspaceId,
    executionWorkspacePreference: "reuse_existing",
    executionWorkspaceSettings: {
      ...((input.sourceIssue.executionWorkspaceSettings as Record<string, unknown> | null | undefined) ?? {}),
      mode: issueExecutionWorkspaceModeForPersistedWorkspace(input.sourceWorkspace.mode),
    },
  };
}

export function shouldClearExecutionWorkspaceForProjectChange(input: {
  projectChanged: boolean;
  companyId: string;
  nextProjectId: string | null;
  workspace: {
    companyId: string;
    projectId: string | null;
    status: string;
  } | null;
}): boolean {
  if (!input.projectChanged) return false;
  if (!input.workspace) return true;
  if (input.workspace.companyId !== input.companyId) return true;
  if (input.workspace.projectId !== input.nextProjectId) return true;
  return input.workspace.status === "archived";
}

export function resolveCreateIssueExecutionWorkspaceFields(input: {
  explicitPatch: IssueWorkspaceFields;
  inherited: ResolvedWorkspaceInheritance | null;
  existingIssue: {
    companyId: string;
    projectId: string | null;
  };
  isolatedWorkspacesEnabled: boolean;
  projectPolicy: ReturnType<typeof parseProjectExecutionWorkspacePolicy>;
  reuseWorkspace: {
    id: string;
    companyId: string;
    projectId: string;
    status: string;
  } | null;
}): IssueWorkspaceFields {
  const hasExplicitOverride =
    input.explicitPatch.executionWorkspaceId !== undefined ||
    input.explicitPatch.executionWorkspacePreference !== undefined ||
    input.explicitPatch.executionWorkspaceSettings !== undefined;

  if (hasExplicitOverride) {
    return enforceIssueExecutionWorkspaceOverridePolicy({
      existingIssue: input.existingIssue,
      isolatedWorkspacesEnabled: input.isolatedWorkspacesEnabled,
      projectPolicy: input.projectPolicy,
      patch: input.explicitPatch,
      reuseWorkspace: input.reuseWorkspace,
    });
  }

  if (!input.inherited) return {};
  return {
    executionWorkspaceId: input.inherited.executionWorkspaceId,
    executionWorkspacePreference: input.inherited.executionWorkspacePreference,
    executionWorkspaceSettings: input.inherited.executionWorkspaceSettings,
  };
}

type IssueRow = typeof issues.$inferSelect & {
  /**
   * Phase 1 Phase E batch 3 (T21): denormalized title of the source discussion
   * thread. Populated only when the issues list endpoint is called with the
   * `crewBoard=true` filter (which opts the query into a LEFT JOIN against
   * `discussions`). Absent or `null` otherwise.
   */
  sourceThreadTitle?: string | null;
};
type IssueLabelRow = typeof labels.$inferSelect;
type IssueActiveRunRow = {
  id: string;
  status: string;
  agentId: string;
  invocationSource: string;
  triggerDetail: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
};
type IssueWithLabels = IssueRow & { labels: IssueLabelRow[]; labelIds: string[] };
type IssueWithLabelsAndRun = IssueWithLabels & { activeRun: IssueActiveRunRow | null };
type IssueUserCommentStats = {
  issueId: string;
  myLastCommentAt: Date | null;
  lastExternalCommentAt: Date | null;
};
function sameRunLock(checkoutRunId: string | null, actorRunId: string | null) {
  if (actorRunId) return checkoutRunId === actorRunId;
  return checkoutRunId == null;
}

const TERMINAL_HEARTBEAT_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const TERMINAL_INTERNAL_AGENT_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/** Escape a string for safe literal use inside a RegExp (round-9 #4). */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function touchedByUserCondition(companyId: string, userId: string) {
  return sql<boolean>`
    (
      ${issues.createdByUserId} = ${userId}
      OR ${issues.assigneeUserId} = ${userId}
      OR EXISTS (
        SELECT 1
        FROM ${issueReadStates}
        WHERE ${issueReadStates.issueId} = ${issues.id}
          AND ${issueReadStates.companyId} = ${companyId}
          AND ${issueReadStates.userId} = ${userId}
      )
      OR EXISTS (
        SELECT 1
        FROM ${issueComments}
        WHERE ${issueComments.issueId} = ${issues.id}
          AND ${issueComments.companyId} = ${companyId}
          AND ${issueComments.authorUserId} = ${userId}
      )
    )
  `;
}

function myLastCommentAtExpr(companyId: string, userId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${issueComments.createdAt})
      FROM ${issueComments}
      WHERE ${issueComments.issueId} = ${issues.id}
        AND ${issueComments.companyId} = ${companyId}
        AND ${issueComments.authorUserId} = ${userId}
    )
  `;
}

function myLastReadAtExpr(companyId: string, userId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${issueReadStates.lastReadAt})
      FROM ${issueReadStates}
      WHERE ${issueReadStates.issueId} = ${issues.id}
        AND ${issueReadStates.companyId} = ${companyId}
        AND ${issueReadStates.userId} = ${userId}
    )
  `;
}

function myLastTouchAtExpr(companyId: string, userId: string) {
  const myLastCommentAt = myLastCommentAtExpr(companyId, userId);
  const myLastReadAt = myLastReadAtExpr(companyId, userId);
  return sql<Date | null>`
    GREATEST(
      COALESCE(${myLastCommentAt}, to_timestamp(0)),
      COALESCE(${myLastReadAt}, to_timestamp(0)),
      COALESCE(CASE WHEN ${issues.createdByUserId} = ${userId} THEN ${issues.createdAt} ELSE NULL END, to_timestamp(0)),
      COALESCE(CASE WHEN ${issues.assigneeUserId} = ${userId} THEN ${issues.updatedAt} ELSE NULL END, to_timestamp(0))
    )
  `;
}

function unreadForUserCondition(companyId: string, userId: string) {
  const touchedCondition = touchedByUserCondition(companyId, userId);
  const myLastTouchAt = myLastTouchAtExpr(companyId, userId);
  return sql<boolean>`
    (
      ${touchedCondition}
      AND EXISTS (
        SELECT 1
        FROM ${issueComments}
        WHERE ${issueComments.issueId} = ${issues.id}
          AND ${issueComments.companyId} = ${companyId}
          AND (
            ${issueComments.authorUserId} IS NULL
            OR ${issueComments.authorUserId} <> ${userId}
          )
          AND ${issueComments.createdAt} > ${myLastTouchAt}
      )
    )
  `;
}

export { deriveIssueUserContext } from "./issue-user-context.js";

async function labelMapForIssues(dbOrTx: any, issueIds: string[]): Promise<Map<string, IssueLabelRow[]>> {
  const map = new Map<string, IssueLabelRow[]>();
  if (issueIds.length === 0) return map;
  const rows = await dbOrTx
    .select({
      issueId: issueLabels.issueId,
      label: labels,
    })
    .from(issueLabels)
    .innerJoin(labels, eq(issueLabels.labelId, labels.id))
    .where(inArray(issueLabels.issueId, issueIds))
    .orderBy(asc(labels.name), asc(labels.id));

  for (const row of rows) {
    const existing = map.get(row.issueId);
    if (existing) existing.push(row.label);
    else map.set(row.issueId, [row.label]);
  }
  return map;
}

async function withIssueLabels(dbOrTx: any, rows: IssueRow[]): Promise<IssueWithLabels[]> {
  if (rows.length === 0) return [];
  const labelsByIssueId = await labelMapForIssues(dbOrTx, rows.map((row) => row.id));
  return rows.map((row) => {
    const issueLabels = labelsByIssueId.get(row.id) ?? [];
    return {
      ...row,
      labels: issueLabels,
      labelIds: issueLabels.map((label) => label.id),
    };
  });
}

const ACTIVE_RUN_STATUSES = ["queued", "running"];

async function activeRunMapForIssues(
  dbOrTx: any,
  issueRows: IssueWithLabels[],
): Promise<Map<string, IssueActiveRunRow>> {
  const map = new Map<string, IssueActiveRunRow>();
  const runIds = issueRows
    .map((row) => row.executionRunId)
    .filter((id): id is string => id != null);
  if (runIds.length === 0) return map;

  const rows = await dbOrTx
    .select({
      id: heartbeatRuns.id,
      status: heartbeatRuns.status,
      agentId: heartbeatRuns.agentId,
      invocationSource: heartbeatRuns.invocationSource,
      triggerDetail: heartbeatRuns.triggerDetail,
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
      createdAt: heartbeatRuns.createdAt,
    })
    .from(heartbeatRuns)
    .where(
      and(
        inArray(heartbeatRuns.id, runIds),
        inArray(heartbeatRuns.status, ACTIVE_RUN_STATUSES),
      ),
    );

  for (const row of rows) {
    map.set(row.id, row);
  }
  return map;
}

function withActiveRuns(
  issueRows: IssueWithLabels[],
  runMap: Map<string, IssueActiveRunRow>,
): IssueWithLabelsAndRun[] {
  return issueRows.map((row) => ({
    ...row,
    activeRun: row.executionRunId ? (runMap.get(row.executionRunId) ?? null) : null,
  }));
}

export function issueService(db: Db) {
  const deps = dependencyService(db);

  async function hasUnmetDependencies(companyId: string, issueId: string): Promise<boolean> {
    const upstream = await db
      .select({ status: issues.status })
      .from(taskDependencies)
      .innerJoin(issues, eq(issues.id, taskDependencies.dependencyIssueId))
      .where(
        and(
          eq(taskDependencies.companyId, companyId),
          eq(taskDependencies.dependentIssueId, issueId),
        ),
      );
    if (upstream.length === 0) return false;
    // A dependency only counts as "unmet" if it is not yet terminal. Both `done`
    // and `cancelled` satisfy the dependency (A-H9).
    return upstream.some((r) => !TERMINAL_STATUSES.includes(r.status));
  }

  async function assertAssignableAgent(companyId: string, agentId: string, dbOrTx: Db = db) {
    const assignee = await dbOrTx
      .select({
        id: agents.id,
        companyId: agents.companyId,
        status: agents.status,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);

    if (!assignee) throw notFound("Assignee agent not found");
    if (assignee.companyId !== companyId) {
      throw unprocessable("Assignee must belong to same company");
    }
    if (assignee.status === "pending_approval") {
      throw conflict("Cannot assign work to pending approval agents");
    }
    if (assignee.status === "terminated") {
      throw conflict("Cannot assign work to terminated agents");
    }
  }

  async function assertAssignableUser(
    companyId: string,
    userId: string,
    subject = "Assignee user",
    dbOrTx: Db = db,
  ) {
    const membership = await dbOrTx
      .select({ id: companyMemberships.id })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
          eq(companyMemberships.status, "active"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!membership) {
      throw notFound(`${subject} not found`);
    }
  }

  async function assertResponsibleUser(companyId: string, userId: string, dbOrTx: Db = db) {
    await assertAssignableUser(companyId, userId, "Responsible user", dbOrTx);
  }

  async function findActiveCompanyUser(companyId: string, userId: string, dbOrTx: Db = db): Promise<string | null> {
    const membership = await dbOrTx
      .select({ id: companyMemberships.id })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
          eq(companyMemberships.status, "active"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    return membership ? userId : null;
  }

  async function findNearestHumanManagerForAgent(
    companyId: string,
    agentId: string,
    dbOrTx: Db = db,
  ): Promise<string | null> {
    type AgentParentRow = {
      parentType: string | null;
      parentId: string | null;
      reportsTo: string | null;
    };
    const seen = new Set<string>();
    let currentAgentId: string | null = agentId;

    for (let depth = 0; currentAgentId && depth < 50; depth += 1) {
      if (seen.has(currentAgentId)) return null;
      seen.add(currentAgentId);

      const row: AgentParentRow | null = await dbOrTx
        .select({
          parentType: agents.parentType,
          parentId: agents.parentId,
          reportsTo: agents.reportsTo,
        })
        .from(agents)
        .where(and(eq(agents.id, currentAgentId), eq(agents.companyId, companyId)))
        .then((rows): AgentParentRow | null => rows[0] ?? null);

      if (!row) return null;
      if (row.parentType === "user" && row.parentId) {
        return await findActiveCompanyUser(companyId, row.parentId, dbOrTx);
      }
      if (row.parentType === "agent" && row.parentId) {
        currentAgentId = row.parentId;
        continue;
      }
      currentAgentId = row.reportsTo ?? null;
    }

    return null;
  }

  async function findSingleFounderUserId(companyId: string, dbOrTx: Db = db): Promise<string | null> {
    const rows = await dbOrTx
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .innerJoin(
        companyMemberships,
        and(
          eq(companyMemberships.companyId, userRoles.companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userRoles.userId),
          eq(companyMemberships.status, "active"),
        ),
      )
      .where(and(eq(userRoles.companyId, companyId), eq(userRoles.role, "founder")));

    const unique = [...new Set(rows.map((row) => row.userId))];
    return unique.length === 1 ? unique[0] : null;
  }

  async function resolveDefaultResponsibleUserId(input: {
    companyId: string;
    assigneeUserId?: string | null;
    assigneeAgentId?: string | null;
    responsibleFallbackUserId?: string | null;
  }, dbOrTx: Db = db): Promise<string | null> {
    if (input.assigneeUserId) return input.assigneeUserId;
    if (input.assigneeAgentId) {
      const manager = await findNearestHumanManagerForAgent(input.companyId, input.assigneeAgentId, dbOrTx);
      return manager ?? await findSingleFounderUserId(input.companyId, dbOrTx);
    }
    if (input.responsibleFallbackUserId) {
      return await findActiveCompanyUser(input.companyId, input.responsibleFallbackUserId, dbOrTx);
    }

    return null;
  }

  async function resolveResponsibleUserId(input: {
    companyId: string;
    explicitResponsibleUserId?: string | null;
    assigneeUserId?: string | null;
    assigneeAgentId?: string | null;
    responsibleFallbackUserId?: string | null;
    existingResponsibleUserId?: string | null;
    executorChanged?: boolean;
  }, dbOrTx: Db = db): Promise<string | null | undefined> {
    if (input.explicitResponsibleUserId !== undefined) {
      if (input.explicitResponsibleUserId !== null) {
        await assertResponsibleUser(input.companyId, input.explicitResponsibleUserId, dbOrTx);
      }
      return input.explicitResponsibleUserId;
    }

    if (!input.executorChanged && input.existingResponsibleUserId !== undefined) {
      return undefined;
    }

    return await resolveDefaultResponsibleUserId(input, dbOrTx);
  }

  async function assertValidLabelIds(companyId: string, labelIds: string[], dbOrTx: any = db) {
    if (labelIds.length === 0) return;
    const existing = await dbOrTx
      .select({ id: labels.id })
      .from(labels)
      .where(and(eq(labels.companyId, companyId), inArray(labels.id, labelIds)));
    if (existing.length !== new Set(labelIds).size) {
      throw unprocessable("One or more labels are invalid for this company");
    }
  }

  async function syncIssueLabels(
    issueId: string,
    companyId: string,
    labelIds: string[],
    dbOrTx: any = db,
  ) {
    const deduped = [...new Set(labelIds)];
    await assertValidLabelIds(companyId, deduped, dbOrTx);
    await dbOrTx.delete(issueLabels).where(eq(issueLabels.issueId, issueId));
    if (deduped.length === 0) return;
    await dbOrTx.insert(issueLabels).values(
      deduped.map((labelId) => ({
        issueId,
        labelId,
        companyId,
      })),
    );
  }

  async function isTerminalOrMissingExecutionRun(runId: string) {
    const [heartbeatRun, internalAgentRun] = await Promise.all([
      db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: internalAgentRuns.status })
        .from(internalAgentRuns)
        .where(eq(internalAgentRuns.id, runId))
        .then((rows) => rows[0] ?? null),
    ]);
    if (heartbeatRun && !TERMINAL_HEARTBEAT_RUN_STATUSES.has(heartbeatRun.status)) return false;
    if (internalAgentRun && !TERMINAL_INTERNAL_AGENT_RUN_STATUSES.has(internalAgentRun.status)) return false;
    return true;
  }

  async function adoptStaleCheckoutRun(input: {
    issueId: string;
    actorAgentId: string;
    actorRunId: string;
    expectedCheckoutRunId: string;
  }) {
    const stale = await isTerminalOrMissingExecutionRun(input.expectedCheckoutRunId);
    if (!stale) return null;

    const now = new Date();
    const adopted = await db
      .update(issues)
      .set({
        checkoutRunId: input.actorRunId,
        executionRunId: input.actorRunId,
        executionLockedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(issues.id, input.issueId),
          eq(issues.status, "in_progress"),
          eq(issues.assigneeAgentId, input.actorAgentId),
          eq(issues.checkoutRunId, input.expectedCheckoutRunId),
        ),
      )
      .returning({
        id: issues.id,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .then((rows) => rows[0] ?? null);

    return adopted;
  }

  return {
    list: async (companyId: string, filters?: IssueFilters) => {
      const conditions = [eq(issues.companyId, companyId)];
      const touchedByUserId = filters?.touchedByUserId?.trim() || undefined;
      const unreadForUserId = filters?.unreadForUserId?.trim() || undefined;
      const contextUserId = unreadForUserId ?? touchedByUserId;
      const rawSearch = filters?.q?.trim() ?? "";
      const hasSearch = rawSearch.length > 0;
      const escapedSearch = hasSearch ? escapeLikePattern(rawSearch) : "";
      const startsWithPattern = `${escapedSearch}%`;
      const containsPattern = `%${escapedSearch}%`;
      const titleStartsWithMatch = sql<boolean>`${issues.title} ILIKE ${startsWithPattern} ESCAPE '\\'`;
      const titleContainsMatch = sql<boolean>`${issues.title} ILIKE ${containsPattern} ESCAPE '\\'`;
      const identifierStartsWithMatch = sql<boolean>`${issues.identifier} ILIKE ${startsWithPattern} ESCAPE '\\'`;
      const identifierContainsMatch = sql<boolean>`${issues.identifier} ILIKE ${containsPattern} ESCAPE '\\'`;
      const descriptionContainsMatch = sql<boolean>`${issues.description} ILIKE ${containsPattern} ESCAPE '\\'`;
      const commentContainsMatch = sql<boolean>`
        EXISTS (
          SELECT 1
          FROM ${issueComments}
          WHERE ${issueComments.issueId} = ${issues.id}
            AND ${issueComments.companyId} = ${companyId}
            AND ${issueComments.body} ILIKE ${containsPattern} ESCAPE '\\'
        )
      `;
      if (filters?.status) {
        const statuses = filters.status.split(",").map((s) => s.trim());
        conditions.push(statuses.length === 1 ? eq(issues.status, statuses[0]) : inArray(issues.status, statuses));
      }
      if (filters?.assigneeAgentId) {
        conditions.push(eq(issues.assigneeAgentId, filters.assigneeAgentId));
      }
      if (filters?.assigneeUserId) {
        conditions.push(eq(issues.assigneeUserId, filters.assigneeUserId));
      }
      if (filters?.responsibleUserId) {
        conditions.push(eq(issues.responsibleUserId, filters.responsibleUserId));
      }
      if (filters?.createdByUserId) {
        conditions.push(eq(issues.createdByUserId, filters.createdByUserId));
      }
      if (touchedByUserId) {
        conditions.push(touchedByUserCondition(companyId, touchedByUserId));
      }
      if (unreadForUserId) {
        conditions.push(unreadForUserCondition(companyId, unreadForUserId));
      }
      if (filters?.projectId) conditions.push(eq(issues.projectId, filters.projectId));
      if (filters && Object.prototype.hasOwnProperty.call(filters, "parentId")) {
        conditions.push(
          filters.parentId === null
            ? isNull(issues.parentId)
            : eq(issues.parentId, filters.parentId as string),
        );
      }
      if (filters?.labelId) {
        const labeledIssueIds = await db
          .select({ issueId: issueLabels.issueId })
          .from(issueLabels)
          .where(and(eq(issueLabels.companyId, companyId), eq(issueLabels.labelId, filters.labelId)));
        if (labeledIssueIds.length === 0) return [];
        conditions.push(inArray(issues.id, labeledIssueIds.map((row) => row.issueId)));
      }
      if (hasSearch) {
        conditions.push(
          or(
            titleContainsMatch,
            identifierContainsMatch,
            descriptionContainsMatch,
            commentContainsMatch,
          )!,
        );
      }
      // Crew/org task scope (2026-06-02 unified separation, T-A). The ONE place
      // the crew predicate is applied to the list surface — resolved via the
      // shared `resolveTaskScope` with a fail-safe default of 'org':
      //   'org'  → push notCrewAssigned  (org agents + humans + unassigned)
      //   'crew' → push crewAssigneeExists + opt into the sourceThreadTitle JOIN
      //   'all'  → push nothing (the task GRAPH + admin/debug escape hatch)
      // `taskScope` wins over the legacy `crewBoard` boolean. The crew board is
      // the flat tracker for ALL crew-agent work (tasks from discussions, goals,
      // routines, MCP, direct capture) — the discriminator is the assignee's
      // agent kind, not the task's origin. The assigneeAgentId filter (line ~610)
      // is still pushed unconditionally above and composes with any scope.
      const taskScope: TaskScope = resolveTaskScope(filters);
      if (taskScope === "org") {
        conditions.push(notCrewAssigned(companyId));
      } else if (taskScope === "crew") {
        conditions.push(crewAssigneeExists(companyId));
      }
      // taskScope === "all": no scope predicate.
      const usesCrewJoin = scopeUsesCrewJoin(taskScope);
      conditions.push(isNull(issues.hiddenAt));

      const priorityOrder = sql`CASE ${issues.priority} WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;
      const searchOrder = sql<number>`
        CASE
          WHEN ${titleStartsWithMatch} THEN 0
          WHEN ${titleContainsMatch} THEN 1
          WHEN ${identifierStartsWithMatch} THEN 2
          WHEN ${identifierContainsMatch} THEN 3
          WHEN ${descriptionContainsMatch} THEN 4
          WHEN ${commentContainsMatch} THEN 5
          ELSE 6
        END
      `;
      const orderClause = [
        hasSearch ? asc(searchOrder) : asc(priorityOrder),
        asc(priorityOrder),
        desc(issues.updatedAt),
      ];

      // Two query shapes: with-JOIN (when grouping by source thread) and the
      // legacy select-all shape (preserved to keep callers and downstream tests
      // identical). The JOIN variant projects every issue column explicitly
      // because mixing `select()` with a LEFT JOIN in Drizzle returns nested
      // rows ({ issues: {...}, discussions: {...} }) which would break every
      // downstream consumer.
      let rows: IssueRow[];
      if (usesCrewJoin) {
        const joinedRows = await db
          .select({
            // Spread issues columns via Drizzle's column reference. We rely on
            // PostgreSQL preserving column ordering — the returned shape mirrors
            // the bare `select().from(issues)` call.
            issue: issues,
            sourceThreadTitle: discussions.title,
          })
          .from(issues)
          .leftJoin(discussions, eq(discussions.id, issues.sourceDiscussionId))
          .where(and(...conditions))
          .orderBy(...orderClause);
        rows = joinedRows.map((row) => ({
          ...(row.issue as IssueRow),
          sourceThreadTitle: row.sourceThreadTitle,
        } as IssueRow));
      } else {
        rows = await db
          .select()
          .from(issues)
          .where(and(...conditions))
          .orderBy(...orderClause);
      }
      const withLabels = await withIssueLabels(db, rows);
      const runMap = await activeRunMapForIssues(db, withLabels);
      const withRuns = withActiveRuns(withLabels, runMap);
      if (!contextUserId || withRuns.length === 0) {
        return withRuns;
      }

      const issueIds = withRuns.map((row) => row.id);
      const statsRows = await db
        .select({
          issueId: issueComments.issueId,
          myLastCommentAt: sql<Date | null>`
            MAX(CASE WHEN ${issueComments.authorUserId} = ${contextUserId} THEN ${issueComments.createdAt} END)
          `,
          lastExternalCommentAt: sql<Date | null>`
            MAX(
              CASE
                WHEN ${issueComments.authorUserId} IS NULL OR ${issueComments.authorUserId} <> ${contextUserId}
                THEN ${issueComments.createdAt}
              END
            )
          `,
        })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.companyId, companyId),
            inArray(issueComments.issueId, issueIds),
          ),
        )
        .groupBy(issueComments.issueId);
      const readRows = await db
        .select({
          issueId: issueReadStates.issueId,
          myLastReadAt: issueReadStates.lastReadAt,
        })
        .from(issueReadStates)
        .where(
          and(
            eq(issueReadStates.companyId, companyId),
            eq(issueReadStates.userId, contextUserId),
            inArray(issueReadStates.issueId, issueIds),
          ),
        );
      const statsByIssueId = new Map(statsRows.map((row) => [row.issueId, row]));
      const readByIssueId = new Map(readRows.map((row) => [row.issueId, row.myLastReadAt]));

      return withRuns.map((row) => ({
        ...row,
        ...deriveIssueUserContext(row, contextUserId, {
          myLastCommentAt: statsByIssueId.get(row.id)?.myLastCommentAt ?? null,
          myLastReadAt: readByIssueId.get(row.id) ?? null,
          lastExternalCommentAt: statsByIssueId.get(row.id)?.lastExternalCommentAt ?? null,
        }),
      }));
    },

    countUnreadTouchedByUser: async (companyId: string, userId: string, status?: string) => {
      // Org-workload count (sidebar unread badge). Crew-agent tasks live only on
      // the Crew Board and must NOT inflate this badge — push notCrewAssigned
      // (2026-06-02 unified crew/org separation, T-B).
      const conditions = [
        eq(issues.companyId, companyId),
        isNull(issues.hiddenAt),
        notCrewAssigned(companyId),
        unreadForUserCondition(companyId, userId),
      ];
      if (status) {
        const statuses = status.split(",").map((s) => s.trim()).filter(Boolean);
        if (statuses.length === 1) {
          conditions.push(eq(issues.status, statuses[0]));
        } else if (statuses.length > 1) {
          conditions.push(inArray(issues.status, statuses));
        }
      }
      const [row] = await db
        .select({ count: sql<number>`count(*)` })
        .from(issues)
        .where(and(...conditions));
      return Number(row?.count ?? 0);
    },

    markRead: async (companyId: string, issueId: string, userId: string, readAt: Date = new Date()) => {
      const now = new Date();
      const [row] = await db
        .insert(issueReadStates)
        .values({
          companyId,
          issueId,
          userId,
          lastReadAt: readAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [issueReadStates.companyId, issueReadStates.issueId, issueReadStates.userId],
          set: {
            lastReadAt: readAt,
            updatedAt: now,
          },
        })
        .returning();
      return row;
    },

    getById: async (id: string) => {
      // A non-UUID id is always an unresolved identifier (the bare `/issues/:id…`
      // param normalizer passes the raw string through when getByIdentifier
      // scopes to zero accessible rows). Return null → the route's not-found path
      // (404) rather than letting eq(issues.id, <non-uuid>) throw Postgres 22P02
      // (invalid uuid syntax) — an error with no `.status` → a spurious 500.
      if (!isUuidLike(id)) return null;
      const row = await db
        .select()
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      const [enriched] = await withIssueLabels(db, [row]);
      return enriched;
    },

    /**
     * BARE-ROUTE identifier resolve — used by the `/issues/:id…` routes that
     * carry NO company in the URL (feedback, output-detection, task-outputs,
     * artifacts, activity, agents live/active-run, and issues.ts `:id` routes).
     * With the Phase-1 multi-tenancy design (org-scoped issue prefixes +
     * per-company identifiers, `issues_identifier_idx` on
     * `(company_id, identifier)`) two companies in DIFFERENT orgs can both own
     * `ACM-1`, so the resolve is scoped to the ACTOR's accessible company set to
     * avoid a cross-tenant collision throwing 409 (or leaking its existence) to
     * a legitimate single-org user.
     *
     * `accessibleCompanyIds` semantics (derive with
     * `accessibleCompanyIdsForActor(req.actor)` in routes/authz.ts):
     *   - `undefined` = ALL-ACCESS sentinel (self-hosted loopback /
     *     self-hosted instance-admin): resolve globally on `identifier` alone,
     *     rejecting an ambiguous cross-company match with a 409.
     *   - `[]`        = the actor can access nothing → return null (404). NEVER
     *     pass `[]` to `inArray` (an empty-array footgun).
     *   - `[…ids]`    = scope the resolve to those companies; still reject an
     *     ambiguous match WITHIN the accessible set with a 409.
     *
     * Rejecting an ambiguous identifier (rather than returning an arbitrary
     * `rows[0]`) closes the wrong-task-mutation risk for a dual-org member who
     * passes `assertCompanyAccess` for EITHER owning company. Every caller still
     * re-checks authz against the RESOLVED issue's company downstream.
     *
     * PREFER `getByIdentifierInCompany` wherever a request companyId is in
     * scope — it matches the unique index and returns the correct tenant's row.
     */
    getByIdentifier: async (identifier: string, accessibleCompanyIds?: string[]) => {
      // undefined = all-access sentinel (self-hosted loopback / instance-admin):
      //   keep the global unfiltered reject-ambiguous resolve.
      // [] = actor can access nothing → null (404). Never pass [] to inArray.
      if (accessibleCompanyIds && accessibleCompanyIds.length === 0) return null;
      const upper = identifier.toUpperCase();
      const where = accessibleCompanyIds
        ? and(eq(issues.identifier, upper), inArray(issues.companyId, accessibleCompanyIds))
        : eq(issues.identifier, upper);
      const rows = await db.select().from(issues).where(where).limit(2);
      if (rows.length > 1) {
        // Reject-ambiguous: the identifier exists in more than one company the
        // actor can reach. A deterministic 409 is the safe resolution;
        // company-scoped routes and the task UUID are unaffected (unique
        // (company_id, identifier) index).
        throw conflict(
          "Ambiguous task identifier — it exists in more than one company you can access. Use a company-scoped route or the task UUID.",
        );
      }
      const row = rows[0] ?? null;
      if (!row) return null;
      const [enriched] = await withIssueLabels(db, [row]);
      return enriched;
    },

    /**
     * Company-scoped identifier resolve. Filters on
     * `(company_id, identifier)` — exactly the `issues_identifier_idx` unique
     * index — so it returns at most one row, always belonging to `companyId`.
     * Use this from any route/handler that has the request's company id in
     * scope (e.g. `/companies/:companyId/issues/:issueId/…`) so an identifier
     * like `ACM-1` resolves to THIS company's task, never another org's.
     */
    getByIdentifierInCompany: async (companyId: string, identifier: string) => {
      const row = await db
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.identifier, identifier.toUpperCase()),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      const [enriched] = await withIssueLabels(db, [row]);
      return enriched;
    },

    create: async (
      companyId: string,
      data: Omit<typeof issues.$inferInsert, "companyId"> & {
        labelIds?: string[];
        inheritExecutionWorkspaceFromIssueId?: string | null;
        responsibleFallbackUserId?: string | null;
        completionPolicyCreatorOverride?: AgentCompletionPolicy | null;
        completionPolicyCreatorSource?: CompletionPolicyCreatorSource | null;
        completionPolicyCreatorSourceId?: string | null;
        completionPolicySnapshot?: {
          policy: AgentCompletionPolicy;
          override: AgentCompletionPolicy | null;
          source: AgentCompletionPolicySource;
          sourceId: string | null;
          resolvedAt: Date | null;
        };
        contextBundle?: {
          sourceIssueId?: string | null;
          sourceDiscussionId?: string | null;
          sourceScopeVersionId?: string | null;
          sourceScopeItemId?: string | null;
          sourceKind?: "issue" | "discussion_scope";
          brief?: string | null;
          items?: CreateIssueContextBundleItemInput[];
        };
      },
      outerTx?: Parameters<Parameters<typeof db.transaction>[0]>[0],
    ) => {
      const operationDb = (outerTx ?? db) as unknown as Db;
      const {
        labelIds: inputLabelIds,
        inheritExecutionWorkspaceFromIssueId,
        responsibleFallbackUserId,
        completionPolicyCreatorOverride,
        completionPolicyCreatorSource,
        completionPolicyCreatorSourceId,
        completionPolicySnapshot,
        contextBundle,
        ...issueData
      } = data;
      if (data.assigneeAgentId && data.assigneeUserId) {
        throw unprocessable("Issue can only have one assignee");
      }
      if (data.assigneeAgentId) {
        await assertAssignableAgent(companyId, data.assigneeAgentId, operationDb);
      }
      if (data.assigneeUserId) {
        await assertAssignableUser(companyId, data.assigneeUserId, "Assignee user", operationDb);
      }
      const createResponsibleUserId = await resolveResponsibleUserId({
        companyId,
        explicitResponsibleUserId: Object.prototype.hasOwnProperty.call(issueData, "responsibleUserId")
          ? (issueData as { responsibleUserId?: string | null }).responsibleUserId
          : undefined,
        assigneeUserId: (issueData as { assigneeUserId?: string | null }).assigneeUserId ?? null,
        assigneeAgentId: (issueData as { assigneeAgentId?: string | null }).assigneeAgentId ?? null,
        responsibleFallbackUserId,
        executorChanged: true,
      }, operationDb);
      if (createResponsibleUserId !== undefined) {
        (issueData as Record<string, unknown>).responsibleUserId = createResponsibleUserId;
      }
      if (data.status === "in_review") {
        const { resolveIssueReviewer } = await import("./issue-reviewer.js");
        const reviewer = await resolveIssueReviewer(operationDb, {
          companyId,
          projectId: (issueData as { projectId?: string | null }).projectId ?? null,
          explicitReviewerUserId: (issueData as { reviewerUserId?: string | null }).reviewerUserId ?? null,
          existingReviewerSource: (issueData as { reviewerSource?: string | null }).reviewerSource ?? null,
          responsibleUserId: (issueData as { responsibleUserId?: string | null }).responsibleUserId ?? null,
        });
        (issueData as Record<string, unknown>).reviewerUserId = reviewer.reviewerUserId;
        (issueData as Record<string, unknown>).reviewerSource = reviewer.reviewerSource;
      }
      if (data.status === "in_progress" && !data.assigneeAgentId && !data.assigneeUserId) {
        throw unprocessable("in_progress issues require an assignee");
      }
      const run = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
        const workspaceInheritanceIssueId = pickWorkspaceInheritanceSourceIssueId({
          inheritExecutionWorkspaceFromIssueId,
          parentId: (issueData as { parentId?: string | null }).parentId ?? null,
        });
        const hasExplicitExecutionWorkspaceOverride =
          (issueData as Record<string, unknown>).executionWorkspaceId !== undefined ||
          (issueData as Record<string, unknown>).executionWorkspacePreference !== undefined ||
          (issueData as Record<string, unknown>).executionWorkspaceSettings !== undefined;

        const isolatedWorkspacesEnabled = (await instanceSettingsService(tx as unknown as Db).getExperimental())
          .enableIsolatedWorkspaces;
        let inheritedExecutionWorkspace: ResolvedWorkspaceInheritance | null = null;

        if (workspaceInheritanceIssueId) {
          const sourceIssue = await tx
            .select({
              executionWorkspaceId: issues.executionWorkspaceId,
              executionWorkspaceSettings: issues.executionWorkspaceSettings,
            })
            .from(issues)
            .where(and(eq(issues.id, workspaceInheritanceIssueId), eq(issues.companyId, companyId)))
            .then((rows) => rows[0] ?? null);
          if (sourceIssue == null && inheritExecutionWorkspaceFromIssueId) {
            throw notFound("Workspace inheritance issue not found");
          }
          let sourceWorkspace: WorkspaceInheritanceWorkspace | null = null;
          if (sourceIssue?.executionWorkspaceId) {
            sourceWorkspace = await tx
              .select({
                mode: executionWorkspaces.mode,
                companyId: executionWorkspaces.companyId,
                projectId: executionWorkspaces.projectId,
                status: executionWorkspaces.status,
              })
              .from(executionWorkspaces)
              .where(eq(executionWorkspaces.id, sourceIssue.executionWorkspaceId))
              .then((rows) => rows[0] ?? null);
          }
          const resolved = resolveExecutionWorkspaceInheritance({
            sourceIssue,
            sourceWorkspace,
            targetCompanyId: companyId,
            targetProjectId: (issueData as { projectId?: string | null }).projectId ?? null,
            isolatedWorkspacesEnabled,
            hasExplicitOverride: hasExplicitExecutionWorkspaceOverride,
          });
          inheritedExecutionWorkspace = resolved;
        }

        const explicitWorkspacePatch: IssueWorkspaceFields = {
          ...((issueData as Record<string, unknown>).executionWorkspaceId !== undefined
            ? { executionWorkspaceId: (issueData as { executionWorkspaceId?: string | null }).executionWorkspaceId }
            : {}),
          ...((issueData as Record<string, unknown>).executionWorkspacePreference !== undefined
            ? {
              executionWorkspacePreference: (issueData as { executionWorkspacePreference?: string | null })
                .executionWorkspacePreference,
            }
            : {}),
          ...((issueData as Record<string, unknown>).executionWorkspaceSettings !== undefined
            ? {
              executionWorkspaceSettings: (issueData as { executionWorkspaceSettings?: Record<string, unknown> | null })
                .executionWorkspaceSettings,
            }
            : {}),
        };
        const projectId = (issueData as { projectId?: string | null }).projectId ?? null;
        const projectPolicy = projectId
          ? await tx
            .select({ executionWorkspacePolicy: projects.executionWorkspacePolicy })
            .from(projects)
            .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
            .then((rows) => parseProjectExecutionWorkspacePolicy(rows[0]?.executionWorkspacePolicy ?? null))
          : null;
        const parsedIssueSettings = parseIssueExecutionWorkspaceSettings(explicitWorkspacePatch.executionWorkspaceSettings);
        const reuseWorkspaceId =
          parsedIssueSettings?.reuseWorkspaceId ?? explicitWorkspacePatch.executionWorkspaceId ?? null;
        const reuseWorkspace = reuseWorkspaceId
          ? await tx
            .select({
              id: executionWorkspaces.id,
              companyId: executionWorkspaces.companyId,
              projectId: executionWorkspaces.projectId,
              status: executionWorkspaces.status,
            })
            .from(executionWorkspaces)
            .where(eq(executionWorkspaces.id, reuseWorkspaceId))
            .then((rows) => rows[0] ?? null)
          : null;
        const executionWorkspaceFields = resolveCreateIssueExecutionWorkspaceFields({
          explicitPatch: explicitWorkspacePatch,
          inherited: inheritedExecutionWorkspace,
          existingIssue: {
            companyId,
            projectId,
          },
          isolatedWorkspacesEnabled,
          projectPolicy,
          reuseWorkspace,
        });
        const issueInsertData = { ...issueData } as Record<string, unknown>;
        const issueId = typeof issueInsertData.id === "string" ? issueInsertData.id : randomUUID();
        issueInsertData.id = issueId;
        delete issueInsertData.executionWorkspaceId;
        delete issueInsertData.executionWorkspacePreference;
        delete issueInsertData.executionWorkspaceSettings;

        const { resolveAgentCompletionPolicy } = await import("./agent-completion-policy.js");
        const completionPolicy = await resolveAgentCompletionPolicy(tx as unknown as Db, {
          companyId,
          projectId,
          taskOverride: completionPolicySnapshot?.policy ??
            ((issueData as { agentCompletionPolicyOverride?: AgentCompletionPolicy | null })
              .agentCompletionPolicyOverride ?? null),
          creatorOverride: completionPolicyCreatorOverride,
          creatorSource: completionPolicyCreatorSource,
          creatorSourceId: completionPolicyCreatorSourceId,
          lockSources: true,
        });
        issueInsertData.agentCompletionPolicy = completionPolicy.policy;
        const preserveImportedSnapshot = completionPolicySnapshot && !completionPolicy.guardrailApplied;
        issueInsertData.agentCompletionPolicyOverride = completionPolicySnapshot
          ? completionPolicySnapshot.override
          : issueInsertData.agentCompletionPolicyOverride;
        issueInsertData.agentCompletionPolicySource = preserveImportedSnapshot
          ? completionPolicySnapshot.source
          : completionPolicy.source;
        const resolvedSourceId = preserveImportedSnapshot
          ? completionPolicySnapshot.sourceId
          : completionPolicy.sourceId;
        issueInsertData.agentCompletionPolicySourceId =
          (preserveImportedSnapshot ? completionPolicySnapshot.source : completionPolicy.source) === "task"
            ? issueId
            : resolvedSourceId;
        issueInsertData.agentCompletionPolicyResolvedAt =
          preserveImportedSnapshot && completionPolicySnapshot.resolvedAt
            ? completionPolicySnapshot.resolvedAt
            : completionPolicy.resolvedAt;

        const [company] = await tx
          .update(companies)
          .set({ issueCounter: sql`${companies.issueCounter} + 1` })
          .where(eq(companies.id, companyId))
          .returning({ issueCounter: companies.issueCounter, issuePrefix: companies.issuePrefix });

        const issueNumber = company.issueCounter;
        const identifier = `${company.issuePrefix}-${issueNumber}`;

        const values = {
          ...issueInsertData,
          ...executionWorkspaceFields,
          companyId,
          issueNumber,
          identifier,
        } as typeof issues.$inferInsert;
        if (values.status === "in_progress" && !values.startedAt) {
          values.startedAt = new Date();
        }
        if (values.status === "done") {
          values.completedAt = new Date();
        }
        if (values.status === "cancelled") {
          values.cancelledAt = new Date();
        }

        const [issue] = await tx.insert(issues).values(values).returning();
        if (inputLabelIds) {
          await syncIssueLabels(issue.id, companyId, inputLabelIds, tx);
        }
        if (contextBundle) {
          await createIssueContextBundle(tx, {
            companyId,
            sourceIssueId: contextBundle.sourceIssueId ?? null,
            sourceDiscussionId: contextBundle.sourceDiscussionId ?? null,
            sourceScopeVersionId: contextBundle.sourceScopeVersionId ?? null,
            sourceScopeItemId: contextBundle.sourceScopeItemId ?? null,
            sourceKind: contextBundle.sourceKind ?? "issue",
            targetIssueId: issue.id,
            brief: contextBundle.brief ?? null,
            items: contextBundle.items ?? [],
            createdByAgentId: issue.createdByAgentId ?? null,
            createdByUserId: issue.createdByUserId ?? null,
          });
        }
        const [enriched] = await withIssueLabels(tx, [issue]);
        return enriched;
      };
      return outerTx ? run(outerTx) : db.transaction(run);
    },

    update: async (
      id: string,
      data: Partial<typeof issues.$inferInsert> & { labelIds?: string[]; monitorPolicy?: unknown },
      actor?: {
        actorType?: "agent" | "board" | "user" | "system";
        agentId?: string | null;
        effectiveDial?: number;
        expectedUpdatedAt?: Date | null;
      },
    ) => {
      const completionPolicyOverrideSupplied = Object.prototype.hasOwnProperty.call(
        data,
        "agentCompletionPolicyOverride",
      );
      if (completionPolicyOverrideSupplied && actor?.actorType === "agent") {
        throw forbidden("Only human operators may override task completion policy");
      }
      const { result, tasksToWake, runsToTerminate, existing, issueData } = await db.transaction(async (tx) => {
      const operationDb = tx as unknown as Db;
      let completionPolicy: ResolvedAgentCompletionPolicy | null = null;
      let policyPrelockUpdatedAt: Date | null = null;
      if (completionPolicyOverrideSupplied) {
        const policyPrelockIssue = await tx
          .select({
            companyId: issues.companyId,
            projectId: issues.projectId,
            updatedAt: issues.updatedAt,
          })
          .from(issues)
          .where(eq(issues.id, id))
          .then((rows) => rows[0] ?? null);
        if (policyPrelockIssue) {
          const { resolveAgentCompletionPolicy } = await import("./agent-completion-policy.js");
          const nextProjectId = Object.prototype.hasOwnProperty.call(data, "projectId")
            ? ((data as { projectId?: string | null }).projectId ?? null)
            : policyPrelockIssue.projectId;
          completionPolicy = await resolveAgentCompletionPolicy(operationDb, {
            companyId: policyPrelockIssue.companyId,
            projectId: nextProjectId,
            taskOverride: (data as { agentCompletionPolicyOverride?: AgentCompletionPolicy | null })
              .agentCompletionPolicyOverride ?? null,
            lockSources: true,
          });
          policyPrelockUpdatedAt = policyPrelockIssue.updatedAt;
        }
      }
      const existing = await tx
        .select()
        .from(issues)
        .where(eq(issues.id, id))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!existing) {
        return {
          result: null,
          tasksToWake: [] as { agentId: string; issueId: string; workMode: string | null }[],
          runsToTerminate: [] as string[],
          existing: null,
          issueData: {} as Record<string, unknown>,
        };
      }
      if (
        policyPrelockUpdatedAt &&
        existing.updatedAt.getTime() !== policyPrelockUpdatedAt.getTime()
      ) {
        throw conflict("Issue changed while completion policy locks were acquired; retry the request");
      }
      if (
        actor?.expectedUpdatedAt &&
        existing.updatedAt.getTime() !== actor.expectedUpdatedAt.getTime()
      ) {
        throw conflict("Issue changed while the update was being authorized; retry the request");
      }

      const { labelIds: nextLabelIds, monitorPolicy: rawMonitorPolicy, ...issueData } = data;
      const monitorPolicy = rawMonitorPolicy === undefined ? undefined : normalizeIssueMonitorPolicy(rawMonitorPolicy);

      const isolatedWorkspacesEnabled = (await instanceSettingsService(operationDb).getExperimental()).enableIsolatedWorkspaces;
      if (!isolatedWorkspacesEnabled) {
        delete (issueData as Record<string, unknown>).executionWorkspaceId;
        delete (issueData as Record<string, unknown>).executionWorkspacePreference;
        delete (issueData as Record<string, unknown>).executionWorkspaceSettings;
      } else {
        const hasWorkspaceOverride =
          (issueData as Record<string, unknown>).executionWorkspaceId !== undefined ||
          (issueData as Record<string, unknown>).executionWorkspacePreference !== undefined ||
          (issueData as Record<string, unknown>).executionWorkspaceSettings !== undefined;
        if (hasWorkspaceOverride) {
          const nextProjectId =
            (issueData as { projectId?: string | null }).projectId !== undefined
              ? ((issueData as { projectId?: string | null }).projectId ?? null)
              : existing.projectId;
          const projectPolicy = nextProjectId
            ? await operationDb
              .select({ executionWorkspacePolicy: projects.executionWorkspacePolicy })
              .from(projects)
              .where(and(eq(projects.id, nextProjectId), eq(projects.companyId, existing.companyId)))
              .then((rows) => parseProjectExecutionWorkspacePolicy(rows[0]?.executionWorkspacePolicy ?? null))
            : null;
          const parsedIssueSettings = parseIssueExecutionWorkspaceSettings(
            (issueData as Record<string, unknown>).executionWorkspaceSettings,
          );
          const reuseWorkspaceId =
            parsedIssueSettings?.reuseWorkspaceId ??
            ((issueData as { executionWorkspaceId?: string | null }).executionWorkspaceId ?? null);
          const reuseWorkspace = reuseWorkspaceId
            ? await operationDb
              .select({
                id: executionWorkspaces.id,
                companyId: executionWorkspaces.companyId,
                projectId: executionWorkspaces.projectId,
                status: executionWorkspaces.status,
              })
              .from(executionWorkspaces)
              .where(eq(executionWorkspaces.id, reuseWorkspaceId))
              .then((rows) => rows[0] ?? null)
            : null;
          const normalizedWorkspacePatch = enforceIssueExecutionWorkspaceOverridePolicy({
            existingIssue: {
              companyId: existing.companyId,
              projectId: nextProjectId,
            },
            isolatedWorkspacesEnabled,
            projectPolicy,
            patch: {
              executionWorkspaceId: (issueData as { executionWorkspaceId?: string | null }).executionWorkspaceId,
              executionWorkspacePreference: (issueData as { executionWorkspacePreference?: string | null }).executionWorkspacePreference,
              executionWorkspaceSettings: (issueData as { executionWorkspaceSettings?: Record<string, unknown> | null }).executionWorkspaceSettings,
            },
            reuseWorkspace,
          });
          if ((issueData as Record<string, unknown>).executionWorkspaceId !== undefined) {
            (issueData as Record<string, unknown>).executionWorkspaceId = normalizedWorkspacePatch.executionWorkspaceId;
          } else if (normalizedWorkspacePatch.executionWorkspaceId !== undefined) {
            (issueData as Record<string, unknown>).executionWorkspaceId = normalizedWorkspacePatch.executionWorkspaceId;
          }
          if ((issueData as Record<string, unknown>).executionWorkspacePreference !== undefined) {
            (issueData as Record<string, unknown>).executionWorkspacePreference = normalizedWorkspacePatch.executionWorkspacePreference;
          } else if (normalizedWorkspacePatch.executionWorkspacePreference !== undefined) {
            (issueData as Record<string, unknown>).executionWorkspacePreference = normalizedWorkspacePatch.executionWorkspacePreference;
          }
          if ((issueData as Record<string, unknown>).executionWorkspaceSettings !== undefined) {
            (issueData as Record<string, unknown>).executionWorkspaceSettings = normalizedWorkspacePatch.executionWorkspaceSettings;
          }
        } else if (
          (issueData as { projectId?: string | null }).projectId !== undefined &&
          (issueData as { projectId?: string | null }).projectId !== existing.projectId &&
          existing.executionWorkspaceId
        ) {
          const nextProjectId = (issueData as { projectId?: string | null }).projectId ?? null;
          const existingWorkspace = await operationDb
            .select({
              companyId: executionWorkspaces.companyId,
              projectId: executionWorkspaces.projectId,
              status: executionWorkspaces.status,
            })
            .from(executionWorkspaces)
            .where(eq(executionWorkspaces.id, existing.executionWorkspaceId))
            .then((rows) => rows[0] ?? null);
          if (
            shouldClearExecutionWorkspaceForProjectChange({
              projectChanged: true,
              companyId: existing.companyId,
              nextProjectId,
              workspace: existingWorkspace,
            })
          ) {
            (issueData as Record<string, unknown>).executionWorkspaceId = null;
            (issueData as Record<string, unknown>).executionWorkspacePreference = null;
            (issueData as Record<string, unknown>).executionWorkspaceSettings = null;
          }
        }
      }

      if (issueData.status) {
        assertTransition(existing.status, issueData.status);
      }

      const nextAssigneeAgentId =
        issueData.assigneeAgentId !== undefined ? issueData.assigneeAgentId : existing.assigneeAgentId;
      const nextAssigneeUserId =
        issueData.assigneeUserId !== undefined ? issueData.assigneeUserId : existing.assigneeUserId;

      if (nextAssigneeAgentId && nextAssigneeUserId) {
        throw unprocessable("Issue can only have one assignee");
      }
      if (issueData.status === "in_progress" && !nextAssigneeAgentId && !nextAssigneeUserId) {
        throw unprocessable("in_progress issues require an assignee");
      }
      if (issueData.assigneeAgentId) {
        await assertAssignableAgent(existing.companyId, issueData.assigneeAgentId, operationDb);
      }
      if (issueData.assigneeUserId) {
        await assertAssignableUser(existing.companyId, issueData.assigneeUserId, "Assignee user", operationDb);
      }
      const executorChanged =
        nextAssigneeAgentId !== existing.assigneeAgentId ||
        nextAssigneeUserId !== existing.assigneeUserId;
      const hasExplicitResponsibleUserId = Object.prototype.hasOwnProperty.call(issueData, "responsibleUserId");
      let keepManualResponsibleOnExecutorChange = false;
      if (executorChanged && !hasExplicitResponsibleUserId && existing.responsibleUserId !== null) {
        const previousDefaultResponsibleUserId = await resolveDefaultResponsibleUserId({
          companyId: existing.companyId,
          assigneeUserId: existing.assigneeUserId,
          assigneeAgentId: existing.assigneeAgentId,
        }, operationDb);
        keepManualResponsibleOnExecutorChange = existing.responsibleUserId !== previousDefaultResponsibleUserId;
      }
      const updateResponsibleUserId = await resolveResponsibleUserId({
        companyId: existing.companyId,
        explicitResponsibleUserId: hasExplicitResponsibleUserId
          ? (issueData as { responsibleUserId?: string | null }).responsibleUserId
          : undefined,
        assigneeUserId: nextAssigneeUserId,
        assigneeAgentId: nextAssigneeAgentId,
        existingResponsibleUserId: existing.responsibleUserId,
        executorChanged: keepManualResponsibleOnExecutorChange ? false : executorChanged,
      }, operationDb);
      if (updateResponsibleUserId !== undefined) {
        (issueData as Record<string, unknown>).responsibleUserId = updateResponsibleUserId;
      }

      if (Object.prototype.hasOwnProperty.call(issueData, "agentCompletionPolicyOverride")) {
        if (!completionPolicy) throw notFound("Issue not found");
        const executionStarted = existing.startedAt !== null
          || ["in_progress", "in_review", "done", "cancelled"].includes(existing.status);
        if (executionStarted && completionPolicy.policy !== "review_required") {
          throw unprocessable("A running task's completion policy may only be tightened to require review", {
            code: "completion_policy_locked",
          });
        }
        (issueData as Record<string, unknown>).agentCompletionPolicy = completionPolicy.policy;
        (issueData as Record<string, unknown>).agentCompletionPolicySource = completionPolicy.source;
        (issueData as Record<string, unknown>).agentCompletionPolicySourceId = completionPolicy.source === "task"
          ? existing.id
          : completionPolicy.sourceId;
        (issueData as Record<string, unknown>).agentCompletionPolicyResolvedAt = completionPolicy.resolvedAt;
      } else {
        delete (issueData as Record<string, unknown>).agentCompletionPolicy;
        delete (issueData as Record<string, unknown>).agentCompletionPolicySource;
        delete (issueData as Record<string, unknown>).agentCompletionPolicySourceId;
        delete (issueData as Record<string, unknown>).agentCompletionPolicyResolvedAt;
      }

      if (issueData.status === "in_review" && existing.status !== "in_review") {
        const { resolveIssueReviewer } = await import("./issue-reviewer.js");
        const nextProjectId = Object.prototype.hasOwnProperty.call(issueData, "projectId")
          ? ((issueData as { projectId?: string | null }).projectId ?? null)
          : existing.projectId;
        const explicitReviewerUserId = Object.prototype.hasOwnProperty.call(issueData, "reviewerUserId")
          ? ((issueData as { reviewerUserId?: string | null }).reviewerUserId ?? null)
          : existing.reviewerUserId;
        const reviewerSource = Object.prototype.hasOwnProperty.call(issueData, "reviewerSource")
          ? ((issueData as { reviewerSource?: string | null }).reviewerSource ?? null)
          : existing.reviewerSource;
        const responsibleUserId = Object.prototype.hasOwnProperty.call(issueData, "responsibleUserId")
          ? ((issueData as { responsibleUserId?: string | null }).responsibleUserId ?? null)
          : existing.responsibleUserId;
        const reviewer = await resolveIssueReviewer(operationDb, {
          companyId: existing.companyId,
          projectId: nextProjectId,
          explicitReviewerUserId,
          existingReviewerSource: reviewerSource,
          responsibleUserId,
        });
        (issueData as Record<string, unknown>).reviewerUserId = reviewer.reviewerUserId;
        (issueData as Record<string, unknown>).reviewerSource = reviewer.reviewerSource;
      }

      const patch: Partial<typeof issues.$inferInsert> = {
        ...issueData,
        updatedAt: new Date(),
      };

      // Service-level agent status-transition guard (A4). Runs an approval-lookup
      // read, so it lives beside the locked issue row inside the transaction.
      // Non-agent callers (default actorType "system") are
      // unaffected — see issue-agent-status-guard.ts. The autonomy dial is
      // resolved by the caller (e.g. the set_task_status tool) and forwarded as
      // actor.effectiveDial; this service never reads internalAgentConfig.
      await assertAgentStatusTransition(
        {
          existing: {
            id: existing.id,
            status: existing.status,
            assigneeAgentId: existing.assigneeAgentId,
            agentCompletionPolicy: existing.agentCompletionPolicy,
            acceptanceCriteria: existing.acceptanceCriteria,
          },
          updateFields: issueData,
          actor: { actorType: actor?.actorType ?? "system", agentId: actor?.agentId ?? null, effectiveDial: actor?.effectiveDial },
        },
        operationDb,
      );

      applyStatusSideEffects(issueData.status, patch);
      if (issueData.status && issueData.status !== "done") {
        patch.completedAt = null;
      }
      if (issueData.status && issueData.status !== "cancelled") {
        patch.cancelledAt = null;
      }
      if (issueData.status && issueData.status !== "in_progress") {
        patch.checkoutRunId = null;
      }
      if (
        (issueData.assigneeAgentId !== undefined && issueData.assigneeAgentId !== existing.assigneeAgentId) ||
        (issueData.assigneeUserId !== undefined && issueData.assigneeUserId !== existing.assigneeUserId)
      ) {
        patch.checkoutRunId = null;
      }

        const runIdsToTerminate = new Set<string>();
        const updated = await tx
          .update(issues)
          .set(patch)
          .where(eq(issues.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) {
          return {
            result: null,
            tasksToWake: [] as { agentId: string; issueId: string; workMode: string | null }[],
            runsToTerminate: [] as string[],
          };
        }
        if (
          issueData.assigneeAgentId !== undefined &&
          issueData.assigneeAgentId !== existing.assigneeAgentId
        ) {
          const runIds = await cancelActiveWorkQuestionsForIssue(tx as unknown as Db, {
            companyId: existing.companyId,
            issueId: id,
            reason: "reassigned",
          });
          runIds.forEach((runId) => runIdsToTerminate.add(runId));
        }
        if (nextLabelIds !== undefined) {
          await syncIssueLabels(updated.id, existing.companyId, nextLabelIds, tx);
        }
        if (rawMonitorPolicy !== undefined) {
          const now = new Date();
          if (monitorPolicy === null) {
            await tx
              .update(issueMonitors)
              .set(buildIssueMonitorClearedPatch({ now, clearReason: "manual_clear" }))
              .where(and(eq(issueMonitors.companyId, existing.companyId), eq(issueMonitors.issueId, updated.id), inArray(issueMonitors.status, ["scheduled", "triggered"])));
            await tx.insert(activityLog).values({
              companyId: existing.companyId,
              actorType: "system",
              actorId: "recovery",
              action: "issue.monitor_cleared",
              entityType: "issue",
              entityId: updated.id,
              details: { reason: "manual_clear" },
            });
          } else {
            const fields = buildInitialIssueMonitorFields({
              companyId: existing.companyId,
              issue: updated,
              policy: monitorPolicy ?? null,
            });
            if (!fields) throw unprocessable("Monitor requires an agent-assigned in-progress or in-review issue");
            const existingMonitor = await tx
              .select()
              .from(issueMonitors)
              .where(
                and(
                  eq(issueMonitors.companyId, existing.companyId),
                  eq(issueMonitors.issueId, updated.id),
                  eq(issueMonitors.kind, fields.kind),
                  inArray(issueMonitors.status, ["scheduled", "triggered"]),
                ),
              )
              .then((rows) => rows[0] ?? null);
            if (existingMonitor) {
              await tx
                .update(issueMonitors)
                .set({
                  ...fields,
                  attemptCount: existingMonitor.attemptCount,
                  clearedAt: null,
                  clearReason: null,
                  updatedAt: now,
                })
                .where(eq(issueMonitors.id, existingMonitor.id));
            } else {
              await tx.insert(issueMonitors).values(fields);
            }
            await tx.insert(activityLog).values({
              companyId: existing.companyId,
              actorType: "system",
              actorId: "recovery",
              action: "issue.monitor_scheduled",
              entityType: "issue",
              entityId: updated.id,
              details: { kind: fields.kind, nextCheckAt: fields.nextCheckAt.toISOString() },
            });
          }
        } else if (
          issueData.status !== undefined ||
          issueData.assigneeAgentId !== undefined ||
          issueData.assigneeUserId !== undefined
        ) {
          const clearReason = monitorClearReasonForIssue({
            status: updated.status,
            assigneeAgentId: updated.assigneeAgentId,
            previousAssigneeAgentId: existing.assigneeAgentId,
          });
          if (clearReason) {
            const now = new Date();
            await tx
              .update(issueMonitors)
              .set(buildIssueMonitorClearedPatch({ now, clearReason }))
              .where(
                and(
                  eq(issueMonitors.companyId, existing.companyId),
                  eq(issueMonitors.issueId, updated.id),
                  inArray(issueMonitors.status, ["scheduled", "triggered"]),
                ),
              );
            await tx.insert(activityLog).values({
              companyId: existing.companyId,
              actorType: "system",
              actorId: "recovery",
              action: "issue.monitor_cleared",
              entityType: "issue",
              entityId: updated.id,
              agentId: existing.assigneeAgentId,
              details: { reason: clearReason },
            });
          }
        }
        const [enriched] = await withIssueLabels(tx, [updated]);

        // Dependency side effects — inside transaction for atomicity
        let wake: { agentId: string; issueId: string; workMode: string | null }[] = [];
        if (enriched && issueData.status && issueData.status !== existing.status) {
          if (issueData.status === "done") {
            const runIds = await cancelActiveWorkQuestionsForIssue(tx as unknown as Db, {
              companyId: existing.companyId,
              issueId: id,
              reason: "done",
            });
            runIds.forEach((runId) => runIdsToTerminate.add(runId));
            const resolved = await deps.resolveDependencies(existing.companyId, id, tx);
            wake = resolved.tasksToWake;
          } else if (issueData.status === "cancelled") {
            const runIds = await cancelActiveWorkQuestionsForIssue(tx as unknown as Db, {
              companyId: existing.companyId,
              issueId: id,
              reason: "cancelled",
            });
            runIds.forEach((runId) => runIdsToTerminate.add(runId));
            // A cancelled dependency is terminal too — it releases its dependents
            // and we must propagate the resulting wakeups so they get dispatched
            // (symmetric with the `done` branch). (A-H9)
            wake = await deps.handleCancelledDependency(existing.companyId, id, tx);
          }
        }
        if (enriched) {
          await hubItemsService(tx as unknown as Db).reconcile(existing.companyId, {
            sourceType: "issue",
            sourceId: enriched.id,
          });
        }

        return {
          result: enriched,
          tasksToWake: wake,
          runsToTerminate: [...runIdsToTerminate],
          existing,
          issueData,
        };
      });

      terminateTrackedRuns(runsToTerminate);
      // CLI-006 (4-D2) — the distributed half. Best-effort: the task change
      // has already committed and must not be undone by an unreachable worker.
      void routeDistributedCancelsForRuns(db, runsToTerminate, "Task no longer eligible").catch(
        (err: unknown) => logger.warn({ err }, "[CLI-006] distributed cancel routing failed"),
      );

      if (!existing) return null;

      // Task 5.6: publish issue.status_changed when the status ACTUALLY changed
      // (the canonical crew-move chokepoint that goes through update — incl.
      // set_task_status). Company-broadcast (R3) so the kanban/Crew Board move
      // the card live. Best-effort — a publish failure must never fail the
      // write. Gated on a real status delta so a non-status update (or a
      // same-status no-op) is silent.
      if (result && issueData.status && issueData.status !== existing.status) {
        try {
          publishIssueStatusChanged(existing.companyId, id, issueData.status);
        } catch (publishErr) {
          logger.warn({ err: publishErr, issueId: id }, "issue.status_changed publish failed (best-effort, ignored)");
        }
      }

      // Fire wakeups after transaction commits (side effects)
      for (const wake of tasksToWake) {
        if (!shouldDispatchIssueWakeup({ workMode: wake.workMode ?? null })) continue;
        await enqueueIssueAssigneeWakeup(db, {
          companyId: existing.companyId,
          agentId: wake.agentId,
          issueId: wake.issueId,
          source: "automation",
          reason: "dependency_unblocked",
        });
      }
      return result;
    },

    remove: async (id: string) => {
      const { removed, runsToTerminate } = await db.transaction(async (tx) => {
        // Fetch the issue first to get companyId (needed for activity log)
        const [issueToDelete] = await tx
          .select({ companyId: issues.companyId })
          .from(issues)
          .where(eq(issues.id, id))
          .for("update");

        let runIdsToTerminate: string[] = [];
        if (issueToDelete) {
          runIdsToTerminate = await cancelActiveWorkQuestionsForIssue(tx as unknown as Db, {
            companyId: issueToDelete.companyId,
            issueId: id,
            reason: "deleted",
          });
          // Auto-unblock dependents before cascade deletes the dependency rows
          const dependents = await tx
            .select({
              dependentIssueId: taskDependencies.dependentIssueId,
              dependentStatus: issues.status,
              assigneeAgentId: issues.assigneeAgentId,
            })
            .from(taskDependencies)
            .innerJoin(issues, eq(issues.id, taskDependencies.dependentIssueId))
            .where(
              and(
                eq(taskDependencies.companyId, issueToDelete.companyId),
                eq(taskDependencies.dependencyIssueId, id),
              ),
            );

          // Delete dependency rows manually (before cascade) so we can evaluate remaining deps
          await tx
            .delete(taskDependencies)
            .where(
              and(
                eq(taskDependencies.companyId, issueToDelete.companyId),
                eq(taskDependencies.dependencyIssueId, id),
              ),
            );

          // For each blocked dependent, check if it can be unblocked
          for (const dep of dependents) {
            if (dep.dependentStatus !== "blocked") continue;

            const remaining = await tx
              .select({ status: issues.status })
              .from(taskDependencies)
              .innerJoin(issues, eq(issues.id, taskDependencies.dependencyIssueId))
              .where(
                and(
                  eq(taskDependencies.companyId, issueToDelete.companyId),
                  eq(taskDependencies.dependentIssueId, dep.dependentIssueId),
                ),
              );

            const allDone = remaining.length === 0 || remaining.every((r) => r.status === "done");
            if (!allDone) continue;

            await tx
              .update(issues)
              .set({ status: "todo", updatedAt: new Date() })
              .where(eq(issues.id, dep.dependentIssueId));

            await tx.insert(activityLog).values({
              companyId: issueToDelete.companyId,
              actorType: "system",
              actorId: "system",
              action: "dependency.unblocked_by_deletion",
              entityType: "issue",
              entityId: dep.dependentIssueId,
              details: { deletedDependencyIssueId: id },
            });
          }
        }

        const attachmentAssetIds = await tx
          .select({ assetId: issueAttachments.assetId })
          .from(issueAttachments)
          .where(eq(issueAttachments.issueId, id));

        const removedIssue = await tx
          .delete(issues)
          .where(eq(issues.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);

        if (removedIssue && attachmentAssetIds.length > 0) {
          await tx
            .delete(assets)
            .where(inArray(assets.id, attachmentAssetIds.map((row) => row.assetId)));
        }

        if (!removedIssue) return { removed: null, runsToTerminate: runIdsToTerminate };
        await hubItemsService(tx as unknown as Db).reconcile(removedIssue.companyId, {
          sourceType: "issue",
          sourceId: id,
        });
        const [enriched] = await withIssueLabels(tx, [removedIssue]);
        return { removed: enriched, runsToTerminate: runIdsToTerminate };
      });
      terminateTrackedRuns(runsToTerminate);
      // CLI-006 (4-D2) — the distributed half. Best-effort: the task change
      // has already committed and must not be undone by an unreachable worker.
      void routeDistributedCancelsForRuns(db, runsToTerminate, "Task no longer eligible").catch(
        (err: unknown) => logger.warn({ err }, "[CLI-006] distributed cancel routing failed"),
      );
      return removed;
    },

    // Concurrency: Uses atomic conditional UPDATE (WHERE status = expected AND assignee conditions)
    // rather than SELECT FOR UPDATE. Two simultaneous checkout attempts will issue the same UPDATE,
    // but only one will match the WHERE clause — a valid optimistic concurrency pattern that avoids deadlocks.
    checkout: async (
      id: string,
      agentId: string,
      expectedStatuses: string[],
      checkoutRunId: string | null,
      options?: { deferPublish?: (publish: () => void) => void },
    ) => {
      const issueCompany = await db
        .select({ companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows) => rows[0] ?? null);
      if (!issueCompany) throw notFound("Issue not found");
      await assertAssignableAgent(issueCompany.companyId, agentId);

      // Reject checkout if task has unmet dependencies (safety check — prevents race conditions)
      if (await hasUnmetDependencies(issueCompany.companyId, id)) {
        throw conflict("Task has unmet dependencies");
      }

      const now = new Date();
      const sameRunAssigneeCondition = checkoutRunId
        ? and(
          eq(issues.assigneeAgentId, agentId),
          or(isNull(issues.checkoutRunId), eq(issues.checkoutRunId, checkoutRunId)),
        )
        : and(eq(issues.assigneeAgentId, agentId), isNull(issues.checkoutRunId));
      const executionLockCondition = checkoutRunId
        ? or(isNull(issues.executionRunId), eq(issues.executionRunId, checkoutRunId))
        : isNull(issues.executionRunId);
      const updated = await db.transaction(async (tx) => {
        const row = await tx
          .update(issues)
          .set({
            assigneeAgentId: agentId,
            assigneeUserId: null,
            checkoutRunId,
            executionRunId: checkoutRunId,
            status: "in_progress",
            startedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(issues.id, id),
              inArray(issues.status, expectedStatuses),
              or(isNull(issues.assigneeAgentId), sameRunAssigneeCondition),
              executionLockCondition,
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
        if (row) {
          await hubItemsService(tx as unknown as Db).reconcile(row.companyId, {
            sourceType: "issue",
            sourceId: row.id,
          });
        }
        return row;
      });

      if (updated) {
        // Task 5.6: checkout is a CREW status-MOVE that bypasses
        // issueService.update (raw atomic write → in_progress). Publish
        // issue.status_changed (company-broadcast, R3) so the board reflects
        // the card going in_progress live. Best-effort — never break checkout.
        const runStatusPublish = () => {
          try {
            publishIssueStatusChanged(updated.companyId, updated.id, "in_progress");
          } catch (publishErr) {
            logger.warn({ err: publishErr, issueId: updated.id }, "issue.status_changed publish failed on checkout (best-effort, ignored)");
          }
        };
        // JOB-010: the admission bridge drives checkout INSIDE its own authoritative
        // tenant transaction. A live in-memory publish must never fire before that
        // outer tx commits (and never at all on rollback), so the bridge passes a
        // deferPublish sink that fires the publish AFTER commit. Legacy callers pass
        // no option → publish inline after checkout's own transaction (byte-unchanged).
        if (options?.deferPublish) options.deferPublish(runStatusPublish);
        else runStatusPublish();
        const [enriched] = await withIssueLabels(db, [updated]);
        return enriched;
      }

      const current = await db
        .select({
          id: issues.id,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          checkoutRunId: issues.checkoutRunId,
          executionRunId: issues.executionRunId,
        })
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows) => rows[0] ?? null);

      if (!current) throw notFound("Issue not found");

      if (
        current.assigneeAgentId === agentId &&
        current.status === "in_progress" &&
        current.checkoutRunId == null &&
        (current.executionRunId == null || current.executionRunId === checkoutRunId) &&
        checkoutRunId
      ) {
        const adopted = await db
          .update(issues)
          .set({
            checkoutRunId,
            executionRunId: checkoutRunId,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(issues.id, id),
              eq(issues.status, "in_progress"),
              eq(issues.assigneeAgentId, agentId),
              isNull(issues.checkoutRunId),
              or(isNull(issues.executionRunId), eq(issues.executionRunId, checkoutRunId)),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
        if (adopted) return adopted;
      }

      if (
        checkoutRunId &&
        current.assigneeAgentId === agentId &&
        current.status === "in_progress" &&
        current.checkoutRunId &&
        current.checkoutRunId !== checkoutRunId
      ) {
        const adopted = await adoptStaleCheckoutRun({
          issueId: id,
          actorAgentId: agentId,
          actorRunId: checkoutRunId,
          expectedCheckoutRunId: current.checkoutRunId,
        });
        if (adopted) {
          const row = await db.select().from(issues).where(eq(issues.id, id)).then((rows) => rows[0]!);
          const [enriched] = await withIssueLabels(db, [row]);
          return enriched;
        }
      }

      // If this run already owns it and it's in_progress, return it (no self-409)
      if (
        current.assigneeAgentId === agentId &&
        current.status === "in_progress" &&
        sameRunLock(current.checkoutRunId, checkoutRunId)
      ) {
        const row = await db.select().from(issues).where(eq(issues.id, id)).then((rows) => rows[0]!);
        const [enriched] = await withIssueLabels(db, [row]);
        return enriched;
      }

      throw conflict("Issue checkout conflict", {
        issueId: current.id,
        status: current.status,
        assigneeAgentId: current.assigneeAgentId,
        checkoutRunId: current.checkoutRunId,
        executionRunId: current.executionRunId,
      });
    },

    assertCheckoutOwner: async (id: string, actorAgentId: string, actorRunId: string | null) => {
      const current = await db
        .select({
          id: issues.id,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          checkoutRunId: issues.checkoutRunId,
        })
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows) => rows[0] ?? null);

      if (!current) throw notFound("Issue not found");

      if (
        current.status === "in_progress" &&
        current.assigneeAgentId === actorAgentId &&
        sameRunLock(current.checkoutRunId, actorRunId)
      ) {
        return { ...current, adoptedFromRunId: null as string | null };
      }

      if (
        actorRunId &&
        current.status === "in_progress" &&
        current.assigneeAgentId === actorAgentId &&
        current.checkoutRunId &&
        current.checkoutRunId !== actorRunId
      ) {
        const adopted = await adoptStaleCheckoutRun({
          issueId: id,
          actorAgentId,
          actorRunId,
          expectedCheckoutRunId: current.checkoutRunId,
        });

        if (adopted) {
          return {
            ...adopted,
            adoptedFromRunId: current.checkoutRunId,
          };
        }
      }

      throw conflict("Issue run ownership conflict", {
        issueId: current.id,
        status: current.status,
        assigneeAgentId: current.assigneeAgentId,
        checkoutRunId: current.checkoutRunId,
        actorAgentId,
        actorRunId,
      });
    },

    release: async (id: string, actorAgentId?: string, actorRunId?: string | null) => {
      const existing = await db
        .select()
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows) => rows[0] ?? null);

      if (!existing) return null;
      if (actorAgentId && existing.assigneeAgentId && existing.assigneeAgentId !== actorAgentId) {
        throw conflict("Only assignee can release issue");
      }
      if (
        actorAgentId &&
        existing.status === "in_progress" &&
        existing.assigneeAgentId === actorAgentId &&
        existing.checkoutRunId &&
        !sameRunLock(existing.checkoutRunId, actorRunId ?? null)
      ) {
        throw conflict("Only checkout run can release issue", {
          issueId: existing.id,
          assigneeAgentId: existing.assigneeAgentId,
          checkoutRunId: existing.checkoutRunId,
          actorRunId: actorRunId ?? null,
        });
      }

      const updated = await db.transaction(async (tx) => {
        const row = await tx
          .update(issues)
          .set({
            status: "todo",
            assigneeAgentId: null,
            checkoutRunId: null,
            updatedAt: new Date(),
          })
          .where(eq(issues.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (row) {
          await hubItemsService(tx as unknown as Db).reconcile(row.companyId, {
            sourceType: "issue",
            sourceId: row.id,
          });
        }
        return row;
      });
      if (!updated) return null;
      const [enriched] = await withIssueLabels(db, [updated]);
      return enriched;
    },

    listLabels: (companyId: string) =>
      db.select().from(labels).where(eq(labels.companyId, companyId)).orderBy(asc(labels.name), asc(labels.id)),

    getLabelById: (id: string) =>
      db
        .select()
        .from(labels)
        .where(eq(labels.id, id))
        .then((rows) => rows[0] ?? null),

    createLabel: async (companyId: string, data: Pick<typeof labels.$inferInsert, "name" | "color">) => {
      const [created] = await db
        .insert(labels)
        .values({
          companyId,
          name: data.name.trim(),
          color: data.color,
        })
        .returning();
      return created;
    },

    deleteLabel: async (id: string) =>
      db
        .delete(labels)
        .where(eq(labels.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    listComments: (issueId: string) =>
      db
        .select()
        .from(issueComments)
        .where(eq(issueComments.issueId, issueId))
        .orderBy(desc(issueComments.createdAt)),

    getComment: (commentId: string) =>
      db
        .select()
        .from(issueComments)
        .where(eq(issueComments.id, commentId))
        .then((rows) => rows[0] ?? null),

    addComment: async (
      issueId: string,
      body: string,
      actor: {
        agentId?: string;
        userId?: string;
        authorType?: IssueCommentAuthorType;
        presentation?: IssueCommentPresentation | null;
        metadata?: IssueCommentMetadata | null;
        clientSubmissionId?: string;
        // Round-17 #1: build this comment's per-target wakeups and enqueue them
        // into comment_wakeup_outbox IN THE SAME TRANSACTION as the comment insert,
        // so a committed comment ALWAYS carries its pending wakeup rows (no crash
        // window between the comment commit and a separate enqueue). The callback
        // receives the freshly-inserted comment (id + authorAgentId) so it can
        // embed the comment id in the wakeup payloads; it runs only on a FRESH
        // insert (a replay's rows already exist).
        buildWakeupTargets?: (comment: {
          id: string;
          authorAgentId: string | null;
        }) => Promise<CommentWakeupTarget[]>;
        // Round-18 #2/#3: when the wakeup references post-insert side effects
        // (attachment rows / control effects committed AFTER this tx), enqueue the
        // rows NOT-YET-DRAINABLE with this ready_at; the route flips them ready once
        // those effects are durable.
        wakeupDeferUntil?: Date | null;
      },
    ) => {
      const issue = await db
        .select({ companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);

      if (!issue) throw notFound("Issue not found");

      const clientSubmissionId = actor.clientSubmissionId ?? null;

      const comment = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(issueComments)
          .values({
            companyId: issue.companyId,
            issueId,
            authorAgentId: actor.agentId ?? null,
            authorUserId: actor.userId ?? null,
            authorType: actor.authorType ?? (actor.agentId ? "agent" : actor.userId ? "user" : "system"),
            presentation: actor.presentation ?? null,
            metadata: actor.metadata ?? null,
            body,
            clientSubmissionId,
          })
          // Concurrency backstop for the route-level replay check: two in-flight
          // retries of the same key resolve to one row via the partial unique
          // index. Targeted at the (company, issue, submission) index (round-4:
          // issueId added so the target matches the replay scope) so any OTHER
          // unique violation on issue_comments raises instead of being swallowed.
          .onConflictDoNothing({
            target: [issueComments.companyId, issueComments.issueId, issueComments.clientSubmissionId],
            where: sql`client_submission_id IS NOT NULL`,
          })
          .returning();

        // Lost the insert race → the original already ran its side-effects.
        // Return the existing row FLAGGED as a replay so the route skips its
        // post-insert side-effects (activity/wakeups; attachment re-store) —
        // otherwise two same-key requests that both passed the route-level
        // replay pre-check would each fire them on the same durable comment
        // (PR #291 round-3 review, mirrors discussions.ts addEntry `replayed`).
        // Scoped by issueId too (round-4) so the fallback can only ever return
        // THIS task's comment, never another task that reused the same key.
        if (!created && clientSubmissionId) {
          return tx
            .select()
            .from(issueComments)
            .where(
              and(
                eq(issueComments.companyId, issue.companyId),
                eq(issueComments.issueId, issueId),
                eq(issueComments.clientSubmissionId, clientSubmissionId),
              ),
            )
            .then((rows) => ({ ...rows[0], replayed: true as const }));
        }

        // Update issue's updatedAt so comment activity is reflected in recency sorting
        await tx
          .update(issues)
          .set({ updatedAt: new Date() })
          .where(eq(issues.id, issueId));
        await hubItemsService(tx as unknown as Db).reconcile(issue.companyId, {
          sourceType: "issue",
          sourceId: issueId,
        });
        // Round-17 #1: enqueue the comment's per-target wakeups IN THIS TX, so a
        // committed comment always carries its pending wakeup rows.
        if (actor.buildWakeupTargets) {
          const targets = await actor.buildWakeupTargets({
            id: created.id,
            authorAgentId: created.authorAgentId ?? null,
          });
          await enqueueCommentWakeupOutbox(tx as unknown as Db, {
            companyId: issue.companyId,
            issueId,
            commentId: created.id,
            targets,
            readyAt: actor.wakeupDeferUntil ?? null,
          });
        }
        return created;
      });

      return comment;
    },

    getCommentByClientSubmissionId: async (
      companyId: string,
      issueId: string,
      clientSubmissionId: string,
    ) => {
      return db
        .select()
        .from(issueComments)
        .where(
          and(
            eq(issueComments.companyId, companyId),
            eq(issueComments.issueId, issueId),
            eq(issueComments.clientSubmissionId, clientSubmissionId),
          ),
        )
        .then((rows) => rows[0] ?? null);
    },

    // Stamp the comment's control effects (reopen/interrupt) as complete
    // (PR #291 round-6 #2). Called once the insert winner's control effects
    // succeed; the replay fast-path uses the marker to skip vs resume them.
    markCommentControlEffectsCompleted: async (commentId: string) => {
      await db
        .update(issueComments)
        .set({ controlEffectsCompletedAt: new Date() })
        .where(eq(issueComments.id, commentId));
    },

    // Round-16: enqueue this comment's PER-TARGET agent wakeups into the durable
    // comment_wakeup_outbox (idempotent on (comment, agent)), replacing the
    // comment-wide wakeups_enqueued_at marker + CAS. The background worker drains
    // each row exactly once. Idempotent, so the fresh path and a keyed-retry
    // re-enqueue resolve to one row per agent — closing the crash-loses-summon
    // (worker retry + re-enqueue on retry) and partial-failure-double-wake
    // (per-target row) residuals the marker could not.
    enqueueCommentWakeups: async (input: {
      companyId: string;
      issueId: string;
      commentId: string;
      targets: CommentWakeupTarget[];
      readyAt?: Date | null;
    }): Promise<void> => {
      await enqueueCommentWakeupOutbox(db, input);
    },

    // Round-18 #2/#3: flip a comment's DEFERRED wakeup rows to drainable, once the
    // post-insert side effects (attachment rows / control effects) are durable.
    markCommentWakeupsReady: async (commentId: string): Promise<void> => {
      await markCommentWakeupsReadyOutbox(db, commentId);
    },

    createAttachment: async (input: {
      // Round-17 #1: optional explicit attachment id. The comments-with-attachments
      // route pre-generates it so the in-transaction comment wakeup can carry the
      // real attachment id before the file is stored.
      id?: string;
      issueId: string;
      issueCommentId?: string | null;
      provider: string;
      objectKey: string;
      contentType: string;
      byteSize: number;
      sha256: string;
      originalFilename?: string | null;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
    }) => {
      const issue = await db
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, input.issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Issue not found");

      if (input.issueCommentId) {
        const comment = await db
          .select({ id: issueComments.id, companyId: issueComments.companyId, issueId: issueComments.issueId })
          .from(issueComments)
          .where(eq(issueComments.id, input.issueCommentId))
          .then((rows) => rows[0] ?? null);
        if (!comment) throw notFound("Issue comment not found");
        if (comment.companyId !== issue.companyId || comment.issueId !== issue.id) {
          throw unprocessable("Attachment comment must belong to same issue and company");
        }
      }

      return db.transaction(async (tx) => {
        const [asset] = await tx
          .insert(assets)
          .values({
            companyId: issue.companyId,
            provider: input.provider,
            objectKey: input.objectKey,
            contentType: input.contentType,
            byteSize: input.byteSize,
            sha256: input.sha256,
            originalFilename: input.originalFilename ?? null,
            createdByAgentId: input.createdByAgentId ?? null,
            createdByUserId: input.createdByUserId ?? null,
          })
          .returning();

        const [attachment] = await tx
          .insert(issueAttachments)
          .values({
            ...(input.id ? { id: input.id } : {}),
            companyId: issue.companyId,
            issueId: issue.id,
            assetId: asset.id,
            issueCommentId: input.issueCommentId ?? null,
          })
          .returning();

        return {
          id: attachment.id,
          companyId: attachment.companyId,
          issueId: attachment.issueId,
          issueCommentId: attachment.issueCommentId,
          assetId: attachment.assetId,
          provider: asset.provider,
          objectKey: asset.objectKey,
          contentType: asset.contentType,
          byteSize: asset.byteSize,
          sha256: asset.sha256,
          originalFilename: asset.originalFilename,
          createdByAgentId: asset.createdByAgentId,
          createdByUserId: asset.createdByUserId,
          createdAt: attachment.createdAt,
          updatedAt: attachment.updatedAt,
        };
      });
    },

    /**
     * Complete the attachments missing from an already-persisted comment on an
     * idempotent retry, serialized so concurrent same-key retries cannot each
     * create the same file (PR #291 review, C6).
     *
     * The original `comments-with-attachments` send commits the comment BEFORE
     * its files, so a crash can leave the comment durable with attachments
     * missing; the retry re-sends the files and must complete only the ones that
     * are absent (matched by content hash + filename, multiset). Two retries
     * racing here would otherwise both read the same incomplete set and each
     * insert a duplicate asset+attachment — there is no uniqueness on
     * (comment, hash, filename), and the multiset design deliberately allows a
     * legitimate duplicate, so we cannot lean on a unique index.
     *
     * A transaction-scoped Postgres advisory lock keyed on the comment id
     * serializes the read→decide→write section: the second retry blocks until
     * the first commits, then re-reads the now-complete set inside its own lock
     * and finds nothing missing. `store` (object-storage put) runs inside the
     * lock only for genuinely-missing files, so no orphan blobs are created for
     * files that already exist.
     */
    completeMissingCommentAttachments: async (input: {
      companyId: string;
      issueId: string;
      commentId: string;
      files: Array<{ contentType: string; buffer: Buffer; originalFilename: string | null }>;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
      store: (file: {
        contentType: string;
        buffer: Buffer;
        originalFilename: string | null;
      }) => Promise<{
        provider: string;
        objectKey: string;
        contentType: string;
        byteSize: number;
        sha256: string;
        originalFilename: string | null;
      }>;
    }) => {
      const mapRow = (a: {
        id: string;
        companyId: string;
        issueId: string;
        issueCommentId: string | null;
        assetId: string;
        provider: string;
        objectKey: string;
        contentType: string;
        byteSize: number;
        sha256: string;
        originalFilename: string | null;
        createdByAgentId: string | null;
        createdByUserId: string | null;
        createdAt: Date;
        updatedAt: Date;
      }) => a;

      return db.transaction(async (tx) => {
        // Serialize concurrent completions for THIS comment. Namespaced by a
        // second key so it can't collide with unrelated advisory-lock users.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${input.commentId}), hashtext('issue_attachment_completion'))`,
        );

        const existing = await tx
          .select({
            id: issueAttachments.id,
            companyId: issueAttachments.companyId,
            issueId: issueAttachments.issueId,
            issueCommentId: issueAttachments.issueCommentId,
            assetId: issueAttachments.assetId,
            provider: assets.provider,
            objectKey: assets.objectKey,
            contentType: assets.contentType,
            byteSize: assets.byteSize,
            sha256: assets.sha256,
            originalFilename: assets.originalFilename,
            createdByAgentId: assets.createdByAgentId,
            createdByUserId: assets.createdByUserId,
            createdAt: issueAttachments.createdAt,
            updatedAt: issueAttachments.updatedAt,
          })
          .from(issueAttachments)
          .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
          .where(
            and(
              eq(issueAttachments.issueId, input.issueId),
              eq(issueAttachments.issueCommentId, input.commentId),
            ),
          )
          .orderBy(desc(issueAttachments.createdAt));

        const remaining = new Map<string, number>();
        for (const a of existing) {
          const key = `${a.sha256}:${a.originalFilename ?? ""}`;
          remaining.set(key, (remaining.get(key) ?? 0) + 1);
        }

        const created: ReturnType<typeof mapRow>[] = [];
        for (const file of input.files) {
          const sha256 = createHash("sha256").update(file.buffer).digest("hex");
          const key = `${sha256}:${file.originalFilename ?? ""}`;
          const already = remaining.get(key) ?? 0;
          if (already > 0) {
            remaining.set(key, already - 1);
            continue;
          }

          const stored = await input.store(file);
          const [asset] = await tx
            .insert(assets)
            .values({
              companyId: input.companyId,
              provider: stored.provider,
              objectKey: stored.objectKey,
              contentType: stored.contentType,
              byteSize: stored.byteSize,
              sha256: stored.sha256,
              originalFilename: stored.originalFilename,
              createdByAgentId: input.createdByAgentId ?? null,
              createdByUserId: input.createdByUserId ?? null,
            })
            .returning();
          const [attachment] = await tx
            .insert(issueAttachments)
            .values({
              companyId: input.companyId,
              issueId: input.issueId,
              assetId: asset.id,
              issueCommentId: input.commentId,
            })
            .returning();

          created.push(
            mapRow({
              id: attachment.id,
              companyId: attachment.companyId,
              issueId: attachment.issueId,
              issueCommentId: attachment.issueCommentId,
              assetId: attachment.assetId,
              provider: asset.provider,
              objectKey: asset.objectKey,
              contentType: asset.contentType,
              byteSize: asset.byteSize,
              sha256: asset.sha256,
              originalFilename: asset.originalFilename,
              createdByAgentId: asset.createdByAgentId,
              createdByUserId: asset.createdByUserId,
              createdAt: attachment.createdAt,
              updatedAt: attachment.updatedAt,
            }),
          );
        }

        return { created, all: [...existing.map(mapRow), ...created] };
      });
    },

    listAttachments: async (issueId: string) =>
      db
        .select({
          id: issueAttachments.id,
          companyId: issueAttachments.companyId,
          issueId: issueAttachments.issueId,
          issueCommentId: issueAttachments.issueCommentId,
          assetId: issueAttachments.assetId,
          provider: assets.provider,
          objectKey: assets.objectKey,
          contentType: assets.contentType,
          byteSize: assets.byteSize,
          sha256: assets.sha256,
          originalFilename: assets.originalFilename,
          createdByAgentId: assets.createdByAgentId,
          createdByUserId: assets.createdByUserId,
          createdAt: issueAttachments.createdAt,
          updatedAt: issueAttachments.updatedAt,
        })
        .from(issueAttachments)
        .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
        .where(eq(issueAttachments.issueId, issueId))
        .orderBy(desc(issueAttachments.createdAt)),

    getAttachmentById: async (id: string) =>
      db
        .select({
          id: issueAttachments.id,
          companyId: issueAttachments.companyId,
          issueId: issueAttachments.issueId,
          issueCommentId: issueAttachments.issueCommentId,
          assetId: issueAttachments.assetId,
          provider: assets.provider,
          objectKey: assets.objectKey,
          contentType: assets.contentType,
          byteSize: assets.byteSize,
          sha256: assets.sha256,
          originalFilename: assets.originalFilename,
          createdByAgentId: assets.createdByAgentId,
          createdByUserId: assets.createdByUserId,
          createdAt: issueAttachments.createdAt,
          updatedAt: issueAttachments.updatedAt,
        })
        .from(issueAttachments)
        .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
        .where(eq(issueAttachments.id, id))
        .then((rows) => rows[0] ?? null),

    removeAttachment: async (id: string) =>
      db.transaction(async (tx) => {
        const existing = await tx
          .select({
            id: issueAttachments.id,
            companyId: issueAttachments.companyId,
            issueId: issueAttachments.issueId,
            issueCommentId: issueAttachments.issueCommentId,
            assetId: issueAttachments.assetId,
            provider: assets.provider,
            objectKey: assets.objectKey,
            contentType: assets.contentType,
            byteSize: assets.byteSize,
            sha256: assets.sha256,
            originalFilename: assets.originalFilename,
            createdByAgentId: assets.createdByAgentId,
            createdByUserId: assets.createdByUserId,
            createdAt: issueAttachments.createdAt,
            updatedAt: issueAttachments.updatedAt,
          })
          .from(issueAttachments)
          .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
          .where(eq(issueAttachments.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        await tx.delete(issueAttachments).where(eq(issueAttachments.id, id));
        await tx.delete(assets).where(eq(assets.id, existing.assetId));
        return existing;
      }),

    findMentionedAgents: async (companyId: string, body: string) => {
      const re = /\B@([^\s@,!?.]+)/g;
      const tokens = new Set<string>();
      let m: RegExpExecArray | null;
      while ((m = re.exec(body)) !== null) tokens.add(m[1].toLowerCase());
      if (tokens.size === 0) return [];
      // @mention resolution resolves org + aoa (Commander-team) agents;
      // platform stays excluded — platform agents are not mentionable by users.
      const rows = await db.select({ id: agents.id, name: agents.name })
        .from(agents).where(and(eq(agents.companyId, companyId), inArray(agents.kind, ["org", "aoa"])));
      // Multi-word names ("Memory Keeper") can never appear as a single
      // whitespace-delimited token, so the token pass alone made them
      // unmentionable (review F3, 2026-07-16) — the composer @ pickers offer
      // exactly these names. Second pass: case-insensitive "@Full Name" match
      // for names containing whitespace. Round-9 #4: require a real mention
      // BOUNDARY on both sides — the leading \B@ (no word char before @, so
      // "email@Memory Keeper" is not a mention) AND, after the full name, a
      // non-name char (end / whitespace / , ! ? . / @) rather than a continuing
      // name char [^\s@,!?.]. A plain substring `includes` matched any longer
      // phrase, so "@Memory Keeper" wrongly woke on "@Memory Keepers" /
      // "@Memory Keeper2". The after-boundary mirrors the single-word token's
      // terminator set exactly.
      return rows
        .filter((a) => {
          const name = a.name.toLowerCase();
          if (tokens.has(name)) return true;
          if (!/\s/.test(name)) return false;
          const re = new RegExp(`\\B@${escapeRegExp(a.name)}(?![^\\s@,!?.])`, "i");
          return re.test(body);
        })
        .map((a) => a.id);
    },

    resolveAgentKinds: async (ids: string[]): Promise<Map<string, string>> => {
      const unique = [...new Set(ids)].filter(Boolean);
      if (unique.length === 0) return new Map();
      const rows = await db
        .select({ id: agents.id, kind: agents.kind })
        .from(agents)
        .where(inArray(agents.id, unique));
      return new Map(rows.map((r) => [r.id, r.kind]));
    },

    // F1: AoA agents are dispatched by the AoA dispatcher Phase-3, which drains
    // agent_wakeup_requests {status:'queued', kind:'aoa'} with NO source filter.
    // Calling heartbeat.wakeup for an aoa agent ALSO enqueues a heartbeat_run
    // (dual execution). Mirror delegate-to-subagent.ts: insert the wakeup row
    // directly and let Phase-3 own the single execution.
    enqueueAoaMentionWakeup: async (
      companyId: string,
      agentId: string,
      opts: { source?: string | null; reason?: string | null; payload?: unknown; idempotencyKey?: string | null },
    ): Promise<void> => {
      // Round-17 #2: when the comment_wakeup_outbox worker supplies an
      // idempotencyKey (`comment-wakeup:<row id>`), a re-dispatch of the same
      // outbox row (worker crashed before marking it done → reclaimed → re-drained)
      // is a NO-OP insert via the partial unique index, so the crew agent is never
      // double-summoned. Without a key (other callers) it stays a plain insert.
      await db
        .insert(agentWakeupRequests)
        .values({
          companyId,
          agentId,
          source: opts.source ?? "automation",
          reason: opts.reason ?? "issue_comment_mentioned",
          payload: (opts.payload ?? null) as Record<string, unknown> | null,
          status: "queued",
          idempotencyKey: opts.idempotencyKey ?? null,
        })
        .onConflictDoNothing({
          target: [agentWakeupRequests.companyId, agentWakeupRequests.idempotencyKey],
          where: sql`idempotency_key LIKE 'comment-wakeup:%'`,
        });
    },

    /**
     * Resolve @username mentions to human user IDs in the same company.
     *
     * Pattern mirrors `findMentionedAgents` above:
     *   - Regex extracts @-tokens from the body, stops at whitespace/punctuation.
     *   - Tokens are lowercased.
     *   - Tokens ending in "-h" have the suffix stripped — disambiguates from
     *     agent mentions when both share a name (`@alice-h` = "the human alice").
     *   - Matched against `authUsers.name` OR the email-local-part (the bit
     *     before `@` in the email), both case-insensitive (C5). `authUsers.name`
     *     is a free-form display name like "Alice Smith" — matching that
     *     against `@alice` would fail. The email fallback is what most users
     *     actually expect.
     *
     * Returns matching user IDs (text, not uuid — `authUsers.id` is text).
     */
    findMentionedHumans: async (companyId: string, body: string): Promise<string[]> => {
      // Tighter token class than findMentionedAgents above — `\w` + `-` only.
      // Stops cleanly at trailing punctuation like `;`, `)`, `:`, etc., which
      // matters more for human display names than for agent slugs. Future:
      // extract a shared MENTION_TOKEN_RE and unify both resolvers (followup).
      const re = /\B@([\w-]+)/g;
      const tokens = new Set<string>();
      let m: RegExpExecArray | null;
      while ((m = re.exec(body)) !== null) {
        let token = m[1].toLowerCase();
        if (token.endsWith("-h")) token = token.slice(0, -2);
        tokens.add(token);
      }
      if (tokens.size === 0) return [];
      const rows = await db
        .select({
          id: authUsers.id,
          name: authUsers.name,
          // C5: pull email so we can match the local-part. authUsers.email is
          // notNull at the schema level, so `u.email.split("@")[0]` is safe.
          email: authUsers.email,
        })
        .from(authUsers)
        .innerJoin(userRoles, eq(userRoles.userId, authUsers.id))
        .where(eq(userRoles.companyId, companyId));
      return [
        ...new Set(
          rows
            .filter((u) => {
              const nameMatch = tokens.has(u.name.toLowerCase());
              const emailLocalPart = u.email.split("@")[0]?.toLowerCase() ?? "";
              const emailMatch =
                emailLocalPart.length > 0 && tokens.has(emailLocalPart);
              return nameMatch || emailMatch;
            })
            .map((u) => u.id),
        ),
      ];
    },

    /**
     * Resolve @human mentions in `body` and emit notification rows for matched
     * users. Self-mention is skipped (a user @-mentioning themselves does NOT
     * receive a notification). Notification inserts run in parallel with
     * per-promise error isolation — one failure does not abort the batch.
     *
     * SAFETY:
     *   1. Feature-flag gated via companies.enableTeams (queried internally)
     *   2. Internal try/catch wraps the whole flow — never throws
     *   3. Sanitized error logging (err.name + err.message only)
     *   4. Best-effort: if a notification mid-batch fails, prior rows persist;
     *      the catch logs and the rest of the batch still runs (per-promise catch)
     *
     * Note: `relatedEntityId` is the ISSUE id (not the comment id) so deep-links
     * navigate to the task — the task page renders the comment inline.
     *
     * The mention-resolution regex+query is inlined here (not delegated to
     * findMentionedHumans) so this helper stays self-contained and the
     * existing helper is untouched. Future: extract a shared private
     * `_resolveMentionedHumans` to dedupe — see Slice 9 followup.
     *
     * @returns the count of notification rows inserted (0 when flag off, no
     * mentions, or the catch fired).
     */
    notifyMentionedHumans: async (
      companyId: string,
      body: string,
      taskId: string,
      actor: { actorType: string; actorId: string | null },
    ): Promise<number> => {
      try {
        const companyRow = await db
          .select({ enableTeams: companies.enableTeams })
          .from(companies)
          .where(eq(companies.id, companyId))
          .then((rows) => rows[0]);

        if (!companyRow?.enableTeams) return 0;

        // Inline mirror of findMentionedHumans regex+query — kept local so the
        // existing helper is untouched (per Slice 7 review constraint).
        // C5: match against EITHER name OR email-local-part — this is the
        // notification path that fires the actual user-visible alert, so it
        // must mirror the helper's resolution logic.
        const re = /\B@([\w-]+)/g;
        const tokens = new Set<string>();
        let m: RegExpExecArray | null;
        while ((m = re.exec(body)) !== null) {
          let token = m[1].toLowerCase();
          if (token.endsWith("-h")) token = token.slice(0, -2);
          tokens.add(token);
        }
        if (tokens.size === 0) return 0;

        const rows = await db
          .select({
            id: authUsers.id,
            name: authUsers.name,
            email: authUsers.email,
          })
          .from(authUsers)
          .innerJoin(userRoles, eq(userRoles.userId, authUsers.id))
          .where(eq(userRoles.companyId, companyId));
        const mentionedIds = [
          ...new Set(
            rows
              .filter((u) => {
                const nameMatch = tokens.has(u.name.toLowerCase());
                const emailLocalPart =
                  u.email.split("@")[0]?.toLowerCase() ?? "";
                const emailMatch =
                  emailLocalPart.length > 0 && tokens.has(emailLocalPart);
                return nameMatch || emailMatch;
              })
              .map((u) => u.id),
          ),
        ];
        if (mentionedIds.length === 0) return 0;

        const hub = hubItemsService(db);
        const message = body.slice(0, 200);

        // Parallel inserts with per-promise catch — one failure does not abort
        // the batch. The outer catch is a backstop for anything outside the
        // per-promise wrappers (e.g., the company/users queries above).
        const results = await Promise.all(
          mentionedIds.map(async (userId) => {
            // Self-mention skip: a human @-mentioning themselves doesn't get notified.
            // For agent actors, actorId is an agentId UUID and never matches a userId,
            // so this comparison correctly never fires for agents.
            if (actor.actorType === "user" && actor.actorId === userId) return false;
            try {
              // Natural-owner item: the mentioned human is the owner. sourceId
              // folds in the recipient so each mentioned user gets a distinct
              // hub row keyed on the same task (dedupes on re-emit per user).
              await hub.emit({
                companyId,
                semanticType: "mention",
                sourceType: "issue",
                sourceId: `${taskId}:${userId}`,
                title: "You were mentioned in a comment",
                summary: message,
                ownerUserId: userId,
              });
              return true;
            } catch (err) {
              logger.warn(
                {
                  err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
                  companyId,
                  userId,
                  taskId,
                },
                "@human mention notification failed for one recipient; batch continues",
              );
              return false;
            }
          }),
        );
        return results.filter(Boolean).length;
      } catch (err) {
        logger.warn(
          {
            err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
            companyId,
            taskId,
          },
          "@human mention notifications failed at outer try/catch; comment creation continues",
        );
        return 0;
      }
    },

    findMentionedProjectIds: async (issueId: string) => {
      const issue = await db
        .select({
          companyId: issues.companyId,
          title: issues.title,
          description: issues.description,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue) return [];

      const comments = await db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, issueId));

      const mentionedIds = new Set<string>();
      for (const source of [
        issue.title,
        issue.description ?? "",
        ...comments.map((comment) => comment.body),
      ]) {
        for (const projectId of extractProjectMentionIds(source)) {
          mentionedIds.add(projectId);
        }
      }
      if (mentionedIds.size === 0) return [];

      const rows = await db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.companyId, issue.companyId),
            inArray(projects.id, [...mentionedIds]),
          ),
        );
      const valid = new Set(rows.map((row) => row.id));
      return [...mentionedIds].filter((projectId) => valid.has(projectId));
    },

    getAncestors: async (issueId: string) => {
      const raw: Array<{
        id: string; identifier: string | null; title: string; description: string | null;
        status: string; priority: string;
        assigneeAgentId: string | null; projectId: string | null; goalId: string | null;
      }> = [];
      const visited = new Set<string>([issueId]);
      const start = await db.select().from(issues).where(eq(issues.id, issueId)).then(r => r[0] ?? null);
      let currentId = start?.parentId ?? null;
      while (currentId && !visited.has(currentId) && raw.length < 50) {
        visited.add(currentId);
        const parent = await db.select({
          id: issues.id, identifier: issues.identifier, title: issues.title, description: issues.description,
          status: issues.status, priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId, projectId: issues.projectId,
          goalId: issues.goalId, parentId: issues.parentId,
        }).from(issues).where(eq(issues.id, currentId)).then(r => r[0] ?? null);
        if (!parent) break;
        raw.push({
          id: parent.id, identifier: parent.identifier ?? null, title: parent.title, description: parent.description ?? null,
          status: parent.status, priority: parent.priority,
          assigneeAgentId: parent.assigneeAgentId ?? null,
          projectId: parent.projectId ?? null, goalId: parent.goalId ?? null,
        });
        currentId = parent.parentId ?? null;
      }

      // Batch-fetch referenced projects and goals
      const projectIds = [...new Set(raw.map(a => a.projectId).filter((id): id is string => id != null))];
      const goalIds = [...new Set(raw.map(a => a.goalId).filter((id): id is string => id != null))];

      const projectMap = new Map<string, {
        id: string;
        name: string;
        description: string | null;
        status: string;
        goalId: string | null;
        workspaces: Array<{
          id: string;
          companyId: string;
          projectId: string;
          name: string;
          cwd: string | null;
          repoUrl: string | null;
          repoRef: string | null;
          metadata: Record<string, unknown> | null;
          isPrimary: boolean;
          createdAt: Date;
          updatedAt: Date;
        }>;
        primaryWorkspace: {
          id: string;
          companyId: string;
          projectId: string;
          name: string;
          cwd: string | null;
          repoUrl: string | null;
          repoRef: string | null;
          metadata: Record<string, unknown> | null;
          isPrimary: boolean;
          createdAt: Date;
          updatedAt: Date;
        } | null;
      }>();
      const goalMap = new Map<string, { id: string; title: string; description: string | null; level: string; status: string }>();

      if (projectIds.length > 0) {
        const workspaceRows = await db
          .select()
          .from(projectWorkspaces)
          .where(inArray(projectWorkspaces.projectId, projectIds))
          .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id));
        const workspaceMap = new Map<string, Array<(typeof workspaceRows)[number]>>();
        for (const workspace of workspaceRows) {
          const existing = workspaceMap.get(workspace.projectId);
          if (existing) existing.push(workspace);
          else workspaceMap.set(workspace.projectId, [workspace]);
        }

        const rows = await db.select({
          id: projects.id, name: projects.name, description: projects.description,
          status: projects.status, goalId: projects.goalId,
        }).from(projects).where(inArray(projects.id, projectIds));
        for (const r of rows) {
          const projectWorkspaceRows = workspaceMap.get(r.id) ?? [];
          const workspaces = projectWorkspaceRows.map((workspace) => ({
            id: workspace.id,
            companyId: workspace.companyId,
            projectId: workspace.projectId,
            name: workspace.name,
            cwd: workspace.cwd,
            repoUrl: workspace.repoUrl ?? null,
            repoRef: workspace.repoRef ?? null,
            metadata: (workspace.metadata as Record<string, unknown> | null) ?? null,
            isPrimary: workspace.isPrimary,
            createdAt: workspace.createdAt,
            updatedAt: workspace.updatedAt,
          }));
          const primaryWorkspace = workspaces.find((workspace) => workspace.isPrimary) ?? workspaces[0] ?? null;
          projectMap.set(r.id, {
            ...r,
            workspaces,
            primaryWorkspace,
          });
          // Also collect goalIds from projects
          if (r.goalId && !goalIds.includes(r.goalId)) goalIds.push(r.goalId);
        }
      }

      if (goalIds.length > 0) {
        const rows = await db.select({
          id: goals.id, title: goals.title, description: goals.description,
          level: goals.level, status: goals.status,
        }).from(goals).where(inArray(goals.id, goalIds));
        for (const r of rows) goalMap.set(r.id, r);
      }

      return raw.map(a => ({
        ...a,
        project: a.projectId ? projectMap.get(a.projectId) ?? null : null,
        goal: a.goalId ? goalMap.get(a.goalId) ?? null : null,
      }));
    },

    staleCount: async (companyId: string, minutes = 60) => {
      const cutoff = new Date(Date.now() - minutes * 60 * 1000);
      const result = await db
        .select({ count: sql<number>`count(*)` })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.status, "in_progress"),
            isNull(issues.hiddenAt),
            sql`${issues.startedAt} < ${cutoff.toISOString()}`,
            // Org-workload count (review #5): a stale crew (kind='aoa') task
            // lives on the Crew Board and must NOT inflate the founder's org
            // sidebar Inbox badge. Mirrors countUnreadTouchedByUser / dashboard.
            notCrewAssigned(companyId),
          ),
        )
        .then((rows) => rows[0]);

      return Number(result?.count ?? 0);
    },
  };
}
