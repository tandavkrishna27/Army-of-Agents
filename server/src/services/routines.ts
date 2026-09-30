import crypto from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  agents,
  companySecrets,
  goals,
  heartbeatRuns,
  inboxDismissals,
  issues,
  issueReadStates,
  projects,
  routineRuns,
  routineRevisions,
  routines,
  routineTriggers,
} from "@armyofagents/db";
import type {
  CreateRoutine,
  CreateRoutineTrigger,
  Routine,
  RoutineDetail,
  RoutineListItem,
  RoutineRevision,
  RoutineRevisionListItem,
  RoutineRunSummary,
  RoutineSnapshot,
  RoutineTrigger,
  RoutineTriggerSecretMaterial,
  RunRoutine,
  UpdateRoutine,
  UpdateRoutineTrigger,
} from "@armyofagents/shared";
import {
  getBuiltinRoutineVariableValues,
  interpolateRoutineTemplate,
  normalizeAgentUrlKey,
} from "@armyofagents/shared";
import { conflict, forbidden, notFound, unauthorized, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { issueService } from "./issues.js";
import { secretService } from "./secrets.js";
import { parseCron, validateCron } from "./cron.js";
import { queueIssueAssignmentWakeup } from "./issue-assignment-wakeup.js";
import { logActivity } from "./activity-log.js";
import { buildRoutineFailedHubEmit, emitHubItem } from "./hub-source-producers.js";
import {
  mergeRoutineRunPayload,
  resolveRoutineRunVariables,
  resolveRoutineVariableValues,
} from "./routine-variable-runtime.js";

const OPEN_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"];
const LIVE_HEARTBEAT_RUN_STATUSES = ["queued", "running", "scheduled_retry"];
const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);
const MAX_CATCH_UP_RUNS = 25;
const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

type Actor = { agentId?: string | null; userId?: string | null };

function assertTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    throw unprocessable(`Invalid timezone: ${timeZone}`);
  }
}

function floorToMinute(date: Date) {
  const copy = new Date(date.getTime());
  copy.setUTCSeconds(0, 0);
  return copy;
}

function getZonedMinuteParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
  });
  const parts = formatter.formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekday = WEEKDAY_INDEX[map.weekday ?? ""];
  if (weekday == null) {
    throw new Error(`Unable to resolve weekday for timezone ${timeZone}`);
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    weekday,
  };
}

function matchesCronMinute(expression: string, timeZone: string, date: Date) {
  const cron = parseCron(expression);
  const parts = getZonedMinuteParts(date, timeZone);
  return (
    cron.minutes.includes(parts.minute) &&
    cron.hours.includes(parts.hour) &&
    cron.daysOfMonth.includes(parts.day) &&
    cron.months.includes(parts.month) &&
    cron.daysOfWeek.includes(parts.weekday)
  );
}

function nextCronTickInTimeZone(expression: string, timeZone: string, after: Date) {
  const trimmed = expression.trim();
  assertTimeZone(timeZone);
  const error = validateCron(trimmed);
  if (error) {
    throw unprocessable(error);
  }

  const cursor = floorToMinute(after);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  const limit = 366 * 24 * 60 * 5;
  for (let i = 0; i < limit; i += 1) {
    if (matchesCronMinute(trimmed, timeZone, cursor)) {
      return new Date(cursor.getTime());
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return null;
}

function nextResultText(status: string, issueId?: string | null) {
  if (status === "issue_created" && issueId) return `Created execution issue ${issueId}`;
  if (status === "coalesced") return "Coalesced into an existing live execution issue";
  if (status === "skipped") return "Skipped because a live execution issue already exists";
  if (status === "completed") return "Execution issue completed";
  if (status === "failed") return "Execution failed";
  return status;
}

function normalizeWebhookTimestampMs(rawTimestamp: string) {
  const parsed = Number(rawTimestamp);
  if (!Number.isFinite(parsed)) return null;
  return parsed > 1e12 ? parsed : parsed * 1000;
}

const toIso = (d: Date): string => d.toISOString();
const toIsoOrNull = (d: Date | null): string | null => (d ? d.toISOString() : null);

function toRoutine(row: typeof routines.$inferSelect): Routine {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId,
    goalId: row.goalId,
    parentIssueId: row.parentIssueId,
    title: row.title,
    description: row.description,
    assigneeAgentId: row.assigneeAgentId,
    priority: row.priority,
    status: row.status as Routine["status"],
    concurrencyPolicy: row.concurrencyPolicy as Routine["concurrencyPolicy"],
    catchUpPolicy: row.catchUpPolicy as Routine["catchUpPolicy"],
    agentCompletionPolicyOverride: row.agentCompletionPolicyOverride as Routine["agentCompletionPolicyOverride"],
    variables: row.variables ?? [],
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    updatedByAgentId: row.updatedByAgentId,
    updatedByUserId: row.updatedByUserId,
    lastTriggeredAt: toIsoOrNull(row.lastTriggeredAt),
    lastEnqueuedAt: toIsoOrNull(row.lastEnqueuedAt),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    latestRevisionId: row.latestRevisionId,
  };
}

function toRoutineTrigger(row: typeof routineTriggers.$inferSelect): RoutineTrigger {
  return {
    id: row.id,
    companyId: row.companyId,
    routineId: row.routineId,
    kind: row.kind as RoutineTrigger["kind"],
    label: row.label,
    enabled: row.enabled,
    cronExpression: row.cronExpression,
    timezone: row.timezone,
    nextRunAt: toIsoOrNull(row.nextRunAt),
    lastFiredAt: toIsoOrNull(row.lastFiredAt),
    publicId: row.publicId ?? "",
    secretId: row.secretId,
    signingMode: row.signingMode as RoutineTrigger["signingMode"],
    replayWindowSec: row.replayWindowSec,
    lastRotatedAt: toIsoOrNull(row.lastRotatedAt),
    lastResult: row.lastResult,
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    updatedByAgentId: row.updatedByAgentId,
    updatedByUserId: row.updatedByUserId,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

export function routineService(db: Db) {
  const issueSvc = issueService(db);
  const secretsSvc = secretService(db);

  async function getRoutineById(id: string) {
    return db
      .select()
      .from(routines)
      .where(eq(routines.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function getTriggerById(id: string) {
    return db
      .select()
      .from(routineTriggers)
      .where(eq(routineTriggers.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function assertRoutineAccess(companyId: string, routineId: string) {
    const routine = await getRoutineById(routineId);
    if (!routine) throw notFound("Routine not found");
    if (routine.companyId !== companyId) throw forbidden("Routine must belong to same company");
    return routine;
  }

  async function assertAssignableAgent(companyId: string, agentId: string) {
    const agent = await db
      .select({ id: agents.id, companyId: agents.companyId, status: agents.status })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Assignee agent not found");
    if (agent.companyId !== companyId) throw unprocessable("Assignee must belong to same company");
    if (agent.status === "pending_approval") throw conflict("Cannot assign routines to pending approval agents");
    if (agent.status === "terminated") throw conflict("Cannot assign routines to terminated agents");
  }

  async function assertProject(companyId: string, projectId: string) {
    const project = await db
      .select({ id: projects.id, companyId: projects.companyId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .then((rows) => rows[0] ?? null);
    if (!project) throw notFound("Project not found");
    if (project.companyId !== companyId) throw unprocessable("Project must belong to same company");
  }

  async function assertGoal(companyId: string, goalId: string) {
    const goal = await db
      .select({ id: goals.id, companyId: goals.companyId })
      .from(goals)
      .where(eq(goals.id, goalId))
      .then((rows) => rows[0] ?? null);
    if (!goal) throw notFound("Goal not found");
    if (goal.companyId !== companyId) throw unprocessable("Goal must belong to same company");
  }

  async function assertParentIssue(companyId: string, issueId: string) {
    const parentIssue = await db
      .select({ id: issues.id, companyId: issues.companyId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    if (!parentIssue) throw notFound("Parent issue not found");
    if (parentIssue.companyId !== companyId) throw unprocessable("Parent issue must belong to same company");
  }

  async function listTriggersForRoutineIds(companyId: string, routineIds: string[]) {
    if (routineIds.length === 0) return new Map<string, RoutineTrigger[]>();
    const rows = await db
      .select()
      .from(routineTriggers)
      .where(and(eq(routineTriggers.companyId, companyId), inArray(routineTriggers.routineId, routineIds)))
      .orderBy(asc(routineTriggers.createdAt), asc(routineTriggers.id));
    const map = new Map<string, RoutineTrigger[]>();
    for (const row of rows) {
      const list = map.get(row.routineId) ?? [];
      list.push(toRoutineTrigger(row));
      map.set(row.routineId, list);
    }
    return map;
  }

  async function listLatestRunByRoutineIds(companyId: string, routineIds: string[]) {
    if (routineIds.length === 0) return new Map<string, RoutineRunSummary>();
    const rows = await db
      .selectDistinctOn([routineRuns.routineId], {
        id: routineRuns.id,
        companyId: routineRuns.companyId,
        routineId: routineRuns.routineId,
        triggerId: routineRuns.triggerId,
        source: routineRuns.source,
        status: routineRuns.status,
        triggeredAt: routineRuns.triggeredAt,
        idempotencyKey: routineRuns.idempotencyKey,
        triggerPayload: routineRuns.triggerPayload,
        linkedIssueId: routineRuns.linkedIssueId,
        coalescedIntoRunId: routineRuns.coalescedIntoRunId,
        failureReason: routineRuns.failureReason,
        completedAt: routineRuns.completedAt,
        createdAt: routineRuns.createdAt,
        updatedAt: routineRuns.updatedAt,
        triggerKind: routineTriggers.kind,
        triggerLabel: routineTriggers.label,
        issueIdentifier: issues.identifier,
        issueTitle: issues.title,
        issueStatus: issues.status,
        issuePriority: issues.priority,
        issueUpdatedAt: issues.updatedAt,
      })
      .from(routineRuns)
      .leftJoin(routineTriggers, eq(routineRuns.triggerId, routineTriggers.id))
      .leftJoin(issues, eq(routineRuns.linkedIssueId, issues.id))
      .where(and(eq(routineRuns.companyId, companyId), inArray(routineRuns.routineId, routineIds)))
      .orderBy(routineRuns.routineId, desc(routineRuns.createdAt), desc(routineRuns.id));

    const map = new Map<string, RoutineRunSummary>();
    for (const row of rows) {
      map.set(row.routineId, {
        id: row.id,
        companyId: row.companyId,
        routineId: row.routineId,
        triggerId: row.triggerId,
        source: row.source as RoutineRunSummary["source"],
        status: row.status as RoutineRunSummary["status"],
        triggeredAt: toIso(row.triggeredAt),
        idempotencyKey: row.idempotencyKey,
        triggerPayload: row.triggerPayload as Record<string, unknown> | null,
        linkedIssueId: row.linkedIssueId,
        coalescedIntoRunId: row.coalescedIntoRunId,
        failureReason: row.failureReason,
        completedAt: toIsoOrNull(row.completedAt),
        createdAt: toIso(row.createdAt),
        updatedAt: toIso(row.updatedAt),
        linkedIssue: row.linkedIssueId
          ? {
            id: row.linkedIssueId,
            identifier: row.issueIdentifier ?? "",
            title: row.issueTitle ?? "Routine execution",
            status: row.issueStatus ?? "todo",
          }
          : null,
        trigger: row.triggerId
          ? {
            id: row.triggerId,
            kind: row.triggerKind as NonNullable<RoutineRunSummary["trigger"]>["kind"],
            label: row.triggerLabel,
          }
          : null,
      });
    }
    return map;
  }

  async function listLiveIssueByRoutineIds(companyId: string, routineIds: string[]) {
    if (routineIds.length === 0) return new Map<string, RoutineListItem["activeIssue"]>();
    const executionBoundRows = await db
      .selectDistinctOn([issues.originId], {
        originId: issues.originId,
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        priority: issues.priority,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .innerJoin(
        heartbeatRuns,
        and(
          eq(heartbeatRuns.id, issues.executionRunId),
          inArray(heartbeatRuns.status, LIVE_HEARTBEAT_RUN_STATUSES),
        ),
      )
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "routine_execution"),
          inArray(issues.originId, routineIds),
          inArray(issues.status, OPEN_ISSUE_STATUSES),
          isNull(issues.hiddenAt),
        ),
      )
      .orderBy(issues.originId, desc(issues.updatedAt), desc(issues.createdAt));

    const rowsByOriginId = new Map<string, (typeof executionBoundRows)[number]>();
    for (const row of executionBoundRows) {
      if (!row.originId) continue;
      rowsByOriginId.set(row.originId, row);
    }

    const missingRoutineIds = routineIds.filter((routineId) => !rowsByOriginId.has(routineId));
    if (missingRoutineIds.length > 0) {
      const legacyRows = await db
        .selectDistinctOn([issues.originId], {
          originId: issues.originId,
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
          updatedAt: issues.updatedAt,
        })
        .from(issues)
        .innerJoin(
          heartbeatRuns,
          and(
            eq(heartbeatRuns.companyId, issues.companyId),
            inArray(heartbeatRuns.status, LIVE_HEARTBEAT_RUN_STATUSES),
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = cast(${issues.id} as text)`,
          ),
        )
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.originKind, "routine_execution"),
            inArray(issues.originId, missingRoutineIds),
            inArray(issues.status, OPEN_ISSUE_STATUSES),
            isNull(issues.hiddenAt),
          ),
        )
        .orderBy(issues.originId, desc(issues.updatedAt), desc(issues.createdAt));

      for (const row of legacyRows) {
        if (!row.originId) continue;
        rowsByOriginId.set(row.originId, row);
      }
    }

    const map = new Map<string, RoutineListItem["activeIssue"]>();
    for (const row of rowsByOriginId.values()) {
      if (!row.originId) continue;
      map.set(row.originId, {
        id: row.id,
        identifier: row.identifier ?? "",
        title: row.title,
        status: row.status,
      });
    }
    return map;
  }

  async function updateRoutineTouchedState(input: {
    routineId: string;
    triggerId?: string | null;
    triggeredAt: Date;
    status: string;
    issueId?: string | null;
    nextRunAt?: Date | null;
  }, executor: Db = db) {
    await executor
      .update(routines)
      .set({
        lastTriggeredAt: input.triggeredAt,
        lastEnqueuedAt: input.issueId ? input.triggeredAt : undefined,
        updatedAt: new Date(),
      })
      .where(eq(routines.id, input.routineId));

    if (input.triggerId) {
      await executor
        .update(routineTriggers)
        .set({
          lastFiredAt: input.triggeredAt,
          lastResult: nextResultText(input.status, input.issueId),
          nextRunAt: input.nextRunAt === undefined ? undefined : input.nextRunAt,
          updatedAt: new Date(),
        })
        .where(eq(routineTriggers.id, input.triggerId));
    }
  }

  async function findLiveExecutionIssue(routine: typeof routines.$inferSelect, executor: Db = db) {
    const executionBoundIssue = await executor
      .select()
      .from(issues)
      .innerJoin(
        heartbeatRuns,
        and(
          eq(heartbeatRuns.id, issues.executionRunId),
          inArray(heartbeatRuns.status, LIVE_HEARTBEAT_RUN_STATUSES),
        ),
      )
      .where(
        and(
          eq(issues.companyId, routine.companyId),
          eq(issues.originKind, "routine_execution"),
          eq(issues.originId, routine.id),
          inArray(issues.status, OPEN_ISSUE_STATUSES),
          isNull(issues.hiddenAt),
        ),
      )
      .orderBy(desc(issues.updatedAt), desc(issues.createdAt))
      .limit(1)
      .then((rows) => rows[0]?.issues ?? null);
    if (executionBoundIssue) return executionBoundIssue;

    return executor
      .select()
      .from(issues)
      .innerJoin(
        heartbeatRuns,
        and(
          eq(heartbeatRuns.companyId, issues.companyId),
          inArray(heartbeatRuns.status, LIVE_HEARTBEAT_RUN_STATUSES),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = cast(${issues.id} as text)`,
        ),
      )
      .where(
        and(
          eq(issues.companyId, routine.companyId),
          eq(issues.originKind, "routine_execution"),
          eq(issues.originId, routine.id),
          inArray(issues.status, OPEN_ISSUE_STATUSES),
          isNull(issues.hiddenAt),
        ),
      )
      .orderBy(desc(issues.updatedAt), desc(issues.createdAt))
      .limit(1)
      .then((rows) => rows[0]?.issues ?? null);
  }

  async function finalizeRun(runId: string, patch: Partial<typeof routineRuns.$inferInsert>, executor: Db = db) {
    return executor
      .update(routineRuns)
      .set({
        ...patch,
        updatedAt: new Date(),
      })
      .where(eq(routineRuns.id, runId))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  // Best-effort routine_outcome (FAILURE-ONLY) hub emit (Task 10, D3). A routine
  // whose tick crashes before an issue exists — or whose execution issue is
  // blocked/cancelled — otherwise tells no one (no agent run → no run_failed).
  // NEVER throws; a missing routine yields a generic name. Success/skip/coalesce
  // must NOT notify (successful execution is visible in run history and the Routines page).
  async function emitRoutineFailure(
    run: typeof routineRuns.$inferSelect | null,
    routine: { title?: string | null; createdByUserId?: string | null } | null,
    executor: Db = db,
  ): Promise<void> {
    if (!run || run.status !== "failed") return;
    try {
      let name = routine?.title ?? null;
      let createdByUserId = routine?.createdByUserId ?? null;
      if (name == null) {
        const loaded = await executor
          .select({ title: routines.title, createdByUserId: routines.createdByUserId })
          .from(routines)
          .where(eq(routines.id, run.routineId))
          .then((rows) => rows[0] ?? null);
        name = loaded?.title ?? null;
        createdByUserId = createdByUserId ?? loaded?.createdByUserId ?? null;
      }
      await emitHubItem(
        executor,
        buildRoutineFailedHubEmit({
          runId: run.id,
          routineId: run.routineId,
          companyId: run.companyId,
          routineName: name ?? "Routine",
          failureReason: run.failureReason ?? null,
          createdByUserId,
          updatedAt: run.updatedAt ?? new Date(),
        }),
      );
    } catch (err) {
      logger.warn({ err, runId: run.id }, "routine_outcome hub emit failed");
    }
  }

  async function createWebhookSecret(
    companyId: string,
    routineId: string,
    actor: Actor,
  ) {
    const secretValue = crypto.randomBytes(24).toString("hex");
    const secret = await secretsSvc.create(
      companyId,
      {
        name: `routine-${routineId}-${crypto.randomBytes(6).toString("hex")}`,
        provider: "local_encrypted",
        value: secretValue,
        description: `Webhook auth for routine ${routineId}`,
      },
      actor,
    );
    return { secret, secretValue };
  }

  async function resolveTriggerSecret(trigger: typeof routineTriggers.$inferSelect, companyId: string) {
    if (!trigger.secretId) throw notFound("Routine trigger secret not found");
    const secret = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.id, trigger.secretId))
      .then((rows) => rows[0] ?? null);
    if (!secret || secret.companyId !== companyId) throw notFound("Routine trigger secret not found");
    const value = await secretsSvc.resolveSecretValue(companyId, trigger.secretId, "latest", {
      consumerType: "routine",
      consumerId: trigger.routineId,
      actorType: "system",
      configPath: "routine.triggerSecret",
    });
    return value;
  }

  async function touchIssueForUserInbox(
    executor: Db,
    input: { companyId: string; issueId: string; userId: string; touchedAt: Date },
  ): Promise<void> {
    await executor
      .insert(issueReadStates)
      .values({
        companyId: input.companyId,
        issueId: input.issueId,
        userId: input.userId,
        lastReadAt: input.touchedAt,
      })
      .onConflictDoUpdate({
        target: [issueReadStates.companyId, issueReadStates.issueId, issueReadStates.userId],
        set: { lastReadAt: input.touchedAt, updatedAt: input.touchedAt },
      });
    await executor
      .delete(inboxDismissals)
      .where(
        and(
          eq(inboxDismissals.companyId, input.companyId),
          eq(inboxDismissals.userId, input.userId),
          eq(inboxDismissals.itemKey, `issue:${input.issueId}`),
        ),
      );
  }

  async function dispatchRoutineRun(input: {
    routine: typeof routines.$inferSelect;
    trigger: typeof routineTriggers.$inferSelect | null;
    source: "schedule" | "manual" | "api" | "webhook";
    payload?: Record<string, unknown> | null;
    variables?: Record<string, unknown> | null;
    /** Strict per-run variable overrides; merged with stored defaults; unknown keys throw. */
    variableOverrides?: Record<string, string> | null;
    idempotencyKey?: string | null;
    actor?: { agentId: string | null; userId: string | null } | null;
  }) {
    const manualRunnerUserId = input.source === "manual" ? input.actor?.userId ?? null : null;
    const manualRunnerAgentId = input.source === "manual" ? input.actor?.agentId ?? null : null;
    const run = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await tx.execute(
        sql`select id from companies where id = ${input.routine.companyId} for no key update`,
      );
      await tx.execute(
        sql`select id from ${routines} where ${routines.id} = ${input.routine.id} and ${routines.companyId} = ${input.routine.companyId} for update`,
      );
      const routine = await txDb
        .select()
        .from(routines)
        .where(
          and(
            eq(routines.id, input.routine.id),
            eq(routines.companyId, input.routine.companyId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!routine) throw notFound("Routine not found");
      if (input.actor?.agentId && routine.assigneeAgentId !== input.actor.agentId) {
        throw forbidden("Agents can only run routines assigned to themselves");
      }
      if (routine.status === "archived") throw conflict("Routine is archived");
      if ((input.source === "schedule" || input.source === "webhook") && routine.status !== "active") {
        throw conflict("Routine is not active");
      }

      let trigger = input.trigger;
      if (trigger) {
        await tx.execute(
          sql`select id from ${routineTriggers} where ${routineTriggers.id} = ${trigger.id} and ${routineTriggers.companyId} = ${routine.companyId} for update`,
        );
        trigger = await txDb
          .select()
          .from(routineTriggers)
          .where(
            and(
              eq(routineTriggers.id, trigger.id),
              eq(routineTriggers.companyId, routine.companyId),
            ),
          )
          .then((rows) => rows[0] ?? null);
        if (!trigger) throw conflict("Routine trigger no longer exists");
        if (trigger.routineId !== routine.id) throw forbidden("Trigger does not belong to routine");
        if (!trigger.enabled) throw conflict("Routine trigger is not active");
      }

      const routineVariables = routine.variables ?? [];
      // Apply explicit variableOverrides on top of stored defaults first, then
      // run through the full resolver so type coercion and required-field checks apply.
      const effectiveVariables = input.variableOverrides
        ? { ...(input.variables ?? {}), ...resolveRoutineRunVariables(routine, input.variableOverrides) }
        : input.variables;
      const resolvedVariables = resolveRoutineVariableValues(routineVariables, {
        source: input.source,
        payload: input.payload,
        variables: effectiveVariables,
      });
      const interpolationContext = { ...getBuiltinRoutineVariableValues(), ...resolvedVariables };
      const interpolatedTitle = interpolateRoutineTemplate(routine.title, interpolationContext) ?? routine.title;
      const interpolatedDescription = interpolateRoutineTemplate(routine.description, interpolationContext);
      const mergedPayload = mergeRoutineRunPayload(input.payload ?? null, resolvedVariables);

      if (input.idempotencyKey) {
        const existing = await txDb
          .select()
          .from(routineRuns)
          .where(
            and(
              eq(routineRuns.companyId, input.routine.companyId),
              eq(routineRuns.routineId, input.routine.id),
              eq(routineRuns.source, input.source),
              eq(routineRuns.idempotencyKey, input.idempotencyKey),
              trigger ? eq(routineRuns.triggerId, trigger.id) : isNull(routineRuns.triggerId),
            ),
          )
          .orderBy(desc(routineRuns.createdAt))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (existing) return existing;
      }

      const triggeredAt = new Date();
      const [createdRun] = await txDb
        .insert(routineRuns)
        .values({
          companyId: input.routine.companyId,
          routineId: input.routine.id,
          triggerId: trigger?.id ?? null,
          source: input.source,
          status: "received",
          triggeredAt,
          idempotencyKey: input.idempotencyKey ?? null,
          triggerPayload: mergedPayload,
        })
        .returning();

      const nextRunAt = trigger?.kind === "schedule" && trigger.cronExpression && trigger.timezone
        ? nextCronTickInTimeZone(trigger.cronExpression, trigger.timezone, triggeredAt)
        : undefined;

      let createdIssue: Awaited<ReturnType<typeof issueSvc.create>> | null = null;
      try {
        const activeIssue = await findLiveExecutionIssue(routine, txDb);
        if (activeIssue && routine.concurrencyPolicy !== "always_enqueue") {
          const status = routine.concurrencyPolicy === "skip_if_active" ? "skipped" : "coalesced";
          const updated = await finalizeRun(createdRun.id, {
            status,
            linkedIssueId: activeIssue.id,
            coalescedIntoRunId: activeIssue.originRunId,
            completedAt: triggeredAt,
          }, txDb);
          await updateRoutineTouchedState({
            routineId: input.routine.id,
            triggerId: trigger?.id ?? null,
            triggeredAt,
            status,
            issueId: activeIssue.id,
            nextRunAt,
          }, txDb);
          if (manualRunnerUserId) {
            await touchIssueForUserInbox(txDb, {
              companyId: input.routine.companyId,
              issueId: activeIssue.id,
              userId: manualRunnerUserId,
              touchedAt: triggeredAt,
            });
          }
          return updated ?? createdRun;
        }

        try {
          createdIssue = await issueSvc.create(routine.companyId, {
            projectId: routine.projectId,
            goalId: routine.goalId,
            parentId: routine.parentIssueId,
            title: interpolatedTitle,
            description: interpolatedDescription,
            status: "todo",
            priority: routine.priority,
            assigneeAgentId: routine.assigneeAgentId,
            originKind: "routine_execution",
            originId: routine.id,
            originRunId: createdRun.id,
            createdByUserId: manualRunnerUserId,
            createdByAgentId: manualRunnerAgentId,
            completionPolicyCreatorOverride: routine.agentCompletionPolicyOverride as
              | "review_required"
              | "agent_can_complete"
              | null,
            completionPolicyCreatorSource: "routine",
            completionPolicyCreatorSourceId: routine.id,
          }, txDb as never);
        } catch (error) {
          const isOpenExecutionConflict =
            !!error &&
            typeof error === "object" &&
            "code" in error &&
            (error as { code?: string }).code === "23505" &&
            "constraint" in error &&
            (error as { constraint?: string }).constraint === "issues_open_routine_execution_uq";
          if (!isOpenExecutionConflict || routine.concurrencyPolicy === "always_enqueue") {
            throw error;
          }

          const existingIssue = await findLiveExecutionIssue(routine, txDb);
          if (!existingIssue) throw error;
          const status = routine.concurrencyPolicy === "skip_if_active" ? "skipped" : "coalesced";
          const updated = await finalizeRun(createdRun.id, {
            status,
            linkedIssueId: existingIssue.id,
            coalescedIntoRunId: existingIssue.originRunId,
            completedAt: triggeredAt,
          }, txDb);
          await updateRoutineTouchedState({
            routineId: input.routine.id,
            triggerId: trigger?.id ?? null,
            triggeredAt,
            status,
            issueId: existingIssue.id,
            nextRunAt,
          }, txDb);
          if (manualRunnerUserId) {
            await touchIssueForUserInbox(txDb, {
              companyId: input.routine.companyId,
              issueId: existingIssue.id,
              userId: manualRunnerUserId,
              touchedAt: triggeredAt,
            });
          }
          return updated ?? createdRun;
        }

        // Keep the dispatch lock until the issue is linked to a queued heartbeat run.
        await queueIssueAssignmentWakeup({
          db: txDb,
          issue: createdIssue,
          reason: "issue_assigned",
          mutation: "create",
          contextSource: "routine.dispatch",
          requestedByActorType: input.source === "schedule" ? "system" : undefined,
          rethrowOnError: true,
        });
        const updated = await finalizeRun(createdRun.id, {
          status: "issue_created",
          linkedIssueId: createdIssue.id,
        }, txDb);
        await updateRoutineTouchedState({
          routineId: input.routine.id,
          triggerId: trigger?.id ?? null,
          triggeredAt,
          status: "issue_created",
          issueId: createdIssue.id,
          nextRunAt,
        }, txDb);
        return updated ?? createdRun;
      } catch (error) {
        if (createdIssue) {
          await txDb.delete(issues).where(eq(issues.id, createdIssue.id));
        }
        const failureReason = error instanceof Error ? error.message : String(error);
        const failed = await finalizeRun(createdRun.id, {
          status: "failed",
          failureReason,
          completedAt: new Date(),
        }, txDb);
        // Silent-automation-failure inbox signal (Task 10, D3): the tick crashed
        // before an issue existed, so no agent run — nothing else notifies.
        await emitRoutineFailure(failed, routine, txDb);
        await updateRoutineTouchedState({
          routineId: input.routine.id,
          triggerId: trigger?.id ?? null,
          triggeredAt,
          status: "failed",
          nextRunAt,
        }, txDb);
        return failed ?? createdRun;
      }
    });

    if (input.source === "schedule" || input.source === "webhook") {
      const actorId = input.source === "schedule" ? "routine-scheduler" : "routine-webhook";
      try {
        await logActivity(db, {
          companyId: input.routine.companyId,
          actorType: "system",
          actorId,
          action: "routine.run_triggered",
          entityType: "routine_run",
          entityId: run.id,
          details: {
            routineId: input.routine.id,
            triggerId: run.triggerId ?? null,
            source: run.source,
            status: run.status,
          },
        });
      } catch (err) {
        logger.warn({ err, routineId: input.routine.id, runId: run.id }, "failed to log automated routine run");
      }
    }

    return run;
  }

  function captureSnapshot(routine: typeof routines.$inferSelect): RoutineSnapshot {
    return {
      title: routine.title,
      description: routine.description ?? null,
      assigneeAgentId: routine.assigneeAgentId ?? null,
      priority: routine.priority,
      status: routine.status,
      concurrencyPolicy: routine.concurrencyPolicy,
      catchUpPolicy: routine.catchUpPolicy,
      agentCompletionPolicyOverride:
        routine.agentCompletionPolicyOverride as RoutineSnapshot["agentCompletionPolicyOverride"],
      variables: routine.variables ?? [],
      projectId: routine.projectId ?? null,
      goalId: routine.goalId ?? null,
      parentIssueId: routine.parentIssueId ?? null,
    };
  }

  async function createRevisionInternal(routineId: string, actor: Actor): Promise<void> {
    const routine = await getRoutineById(routineId);
    if (!routine) return;
    const snapshot = captureSnapshot(routine);
    await db.transaction(async (tx) => {
      const [rev] = await tx
        .insert(routineRevisions)
        .values({
          companyId: routine.companyId,
          routineId: routine.id,
          snapshot,
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
        })
        .returning();
      if (rev) {
        await tx
          .update(routines)
          .set({ latestRevisionId: rev.id })
          .where(eq(routines.id, routineId));
      }
    });
  }

  return {
    get: getRoutineById,
    getTrigger: getTriggerById,

    list: async (companyId: string): Promise<RoutineListItem[]> => {
      const rows = await db
        .select()
        .from(routines)
        .where(eq(routines.companyId, companyId))
        .orderBy(desc(routines.updatedAt), asc(routines.title));
      const routineIds = rows.map((row) => row.id);
      const [triggersByRoutine, latestRunByRoutine, activeIssueByRoutine] = await Promise.all([
        listTriggersForRoutineIds(companyId, routineIds),
        listLatestRunByRoutineIds(companyId, routineIds),
        listLiveIssueByRoutineIds(companyId, routineIds),
      ]);
      return rows.map((row) => ({
        ...toRoutine(row),
        triggers: (triggersByRoutine.get(row.id) ?? []).map((trigger) => ({
          id: trigger.id,
          kind: trigger.kind,
          label: trigger.label,
          enabled: trigger.enabled,
          cronExpression: trigger.cronExpression,
          timezone: trigger.timezone,
          nextRunAt: trigger.nextRunAt,
        })),
        lastRun: latestRunByRoutine.get(row.id) ?? null,
        activeIssue: activeIssueByRoutine.get(row.id) ?? null,
      }));
    },

    listForExport: async (
      companyId: string,
    ): Promise<Array<{ routine: Routine; triggers: RoutineTrigger[] }>> => {
      const rows = await db
        .select()
        .from(routines)
        .where(eq(routines.companyId, companyId))
        .orderBy(asc(routines.createdAt), asc(routines.id));
      const routineIds = rows.map((row) => row.id);
      const triggersByRoutine = await listTriggersForRoutineIds(companyId, routineIds);
      return rows.map((row) => ({
        routine: toRoutine(row),
        triggers: triggersByRoutine.get(row.id) ?? [],
      }));
    },

    getDetail: async (id: string): Promise<RoutineDetail | null> => {
      const row = await getRoutineById(id);
      if (!row) return null;
      const [project, assignee, parentIssue, triggers, recentRuns, activeIssue] = await Promise.all([
        row.projectId ? db.select().from(projects).where(eq(projects.id, row.projectId)).then((rows) => rows[0] ?? null) : null,
        row.assigneeAgentId ? db.select().from(agents).where(eq(agents.id, row.assigneeAgentId)).then((rows) => rows[0] ?? null) : null,
        row.parentIssueId ? issueSvc.getById(row.parentIssueId) : null,
        db.select().from(routineTriggers).where(eq(routineTriggers.routineId, row.id)).orderBy(asc(routineTriggers.createdAt)),
        db
          .select({
            id: routineRuns.id,
            companyId: routineRuns.companyId,
            routineId: routineRuns.routineId,
            triggerId: routineRuns.triggerId,
            source: routineRuns.source,
            status: routineRuns.status,
            triggeredAt: routineRuns.triggeredAt,
            idempotencyKey: routineRuns.idempotencyKey,
            triggerPayload: routineRuns.triggerPayload,
            linkedIssueId: routineRuns.linkedIssueId,
            coalescedIntoRunId: routineRuns.coalescedIntoRunId,
            failureReason: routineRuns.failureReason,
            completedAt: routineRuns.completedAt,
            createdAt: routineRuns.createdAt,
            updatedAt: routineRuns.updatedAt,
            triggerKind: routineTriggers.kind,
            triggerLabel: routineTriggers.label,
            issueIdentifier: issues.identifier,
            issueTitle: issues.title,
            issueStatus: issues.status,
            issuePriority: issues.priority,
            issueUpdatedAt: issues.updatedAt,
          })
          .from(routineRuns)
          .leftJoin(routineTriggers, eq(routineRuns.triggerId, routineTriggers.id))
          .leftJoin(issues, eq(routineRuns.linkedIssueId, issues.id))
          .where(eq(routineRuns.routineId, row.id))
          .orderBy(desc(routineRuns.createdAt))
          .limit(25)
          .then((runs): RoutineRunSummary[] =>
            runs.map((run) => ({
              id: run.id,
              companyId: run.companyId,
              routineId: run.routineId,
              triggerId: run.triggerId,
              source: run.source as RoutineRunSummary["source"],
              status: run.status as RoutineRunSummary["status"],
              triggeredAt: toIso(run.triggeredAt),
              idempotencyKey: run.idempotencyKey,
              triggerPayload: run.triggerPayload as Record<string, unknown> | null,
              linkedIssueId: run.linkedIssueId,
              coalescedIntoRunId: run.coalescedIntoRunId,
              failureReason: run.failureReason,
              completedAt: toIsoOrNull(run.completedAt),
              createdAt: toIso(run.createdAt),
              updatedAt: toIso(run.updatedAt),
              linkedIssue: run.linkedIssueId
                ? {
                  id: run.linkedIssueId,
                  identifier: run.issueIdentifier ?? "",
                  title: run.issueTitle ?? "Routine execution",
                  status: run.issueStatus ?? "todo",
                }
                : null,
              trigger: run.triggerId
                ? {
                  id: run.triggerId,
                  kind: run.triggerKind as NonNullable<RoutineRunSummary["trigger"]>["kind"],
                  label: run.triggerLabel,
                }
                : null,
            })),
          ),
        findLiveExecutionIssue(row),
      ]);

      return {
        ...toRoutine(row),
        project: project ? { id: project.id, name: project.name } : null,
        assignee: assignee
          ? {
            id: assignee.id,
            name: assignee.name,
            urlKey: normalizeAgentUrlKey(assignee.name) ?? assignee.id,
            role: assignee.role,
          }
          : null,
        parentIssue: parentIssue
          ? {
            id: parentIssue.id,
            title: parentIssue.title,
            identifier: parentIssue.identifier ?? "",
          }
          : null,
        triggers: triggers.map(toRoutineTrigger),
        recentRuns,
        activeIssue: activeIssue
          ? {
            id: activeIssue.id,
            title: activeIssue.title,
            identifier: activeIssue.identifier ?? "",
            status: activeIssue.status,
          }
          : null,
      };
    },

    create: async (companyId: string, input: CreateRoutine, actor: Actor): Promise<Routine> => {
      if (actor.agentId && input.agentCompletionPolicyOverride !== undefined) {
        throw forbidden("Only human operators may override task completion policy");
      }
      if (input.projectId) await assertProject(companyId, input.projectId);
      if (input.assigneeAgentId) await assertAssignableAgent(companyId, input.assigneeAgentId);
      if (input.goalId) await assertGoal(companyId, input.goalId);
      if (input.parentIssueId) await assertParentIssue(companyId, input.parentIssueId);
      const [created] = await db
        .insert(routines)
        .values({
          companyId,
          projectId: input.projectId ?? null,
          goalId: input.goalId ?? null,
          parentIssueId: input.parentIssueId ?? null,
          title: input.title,
          description: input.description ?? null,
          assigneeAgentId: input.assigneeAgentId ?? null,
          priority: input.priority,
          status: input.status,
          concurrencyPolicy: input.concurrencyPolicy,
          catchUpPolicy: input.catchUpPolicy,
          agentCompletionPolicyOverride: input.agentCompletionPolicyOverride ?? null,
          variables: input.variables ?? [],
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
        })
        .returning();
      return toRoutine(created);
    },

    update: async (id: string, patch: UpdateRoutine, actor: Actor): Promise<Routine | null> => {
      const existing = await getRoutineById(id);
      if (!existing) return null;
      if (actor.agentId && patch.agentCompletionPolicyOverride !== undefined) {
        throw forbidden("Only human operators may override task completion policy");
      }
      // 409 conflict check: if caller provided baseRevisionId and it differs from current HEAD, reject
      if (patch.baseRevisionId !== undefined && patch.baseRevisionId !== (existing.latestRevisionId ?? null)) {
        throw conflict("Routine has been modified since your last load. Reload and retry.");
      }
      if (patch.projectId) await assertProject(existing.companyId, patch.projectId);
      if (patch.assigneeAgentId) await assertAssignableAgent(existing.companyId, patch.assigneeAgentId);
      if (patch.goalId) await assertGoal(existing.companyId, patch.goalId);
      if (patch.parentIssueId) await assertParentIssue(existing.companyId, patch.parentIssueId);
      const updated = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await tx.execute(
          sql`select id from companies where id = ${existing.companyId} for no key update`,
        );
        const locked = await txDb
          .select()
          .from(routines)
          .where(eq(routines.id, id))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!locked) return null;
        if (actor.agentId && locked.assigneeAgentId !== actor.agentId) {
          throw forbidden("Agents can only manage routines assigned to themselves");
        }
        if (patch.baseRevisionId !== undefined && patch.baseRevisionId !== (locked.latestRevisionId ?? null)) {
          throw conflict("Routine has been modified since your last load. Reload and retry.");
        }

        const [revision] = await txDb
          .insert(routineRevisions)
          .values({
            companyId: locked.companyId,
            routineId: locked.id,
            snapshot: captureSnapshot(locked),
            createdByAgentId: actor.agentId ?? null,
            createdByUserId: actor.userId ?? null,
          })
          .returning();
        if (revision) {
          await txDb
            .update(routines)
            .set({ latestRevisionId: revision.id })
            .where(eq(routines.id, id));
        }

        const [row] = await txDb
          .update(routines)
          .set({
            projectId: patch.projectId ?? locked.projectId,
            goalId: patch.goalId === undefined ? locked.goalId : patch.goalId,
            parentIssueId: patch.parentIssueId === undefined ? locked.parentIssueId : patch.parentIssueId,
            title: patch.title ?? locked.title,
            description: patch.description === undefined ? locked.description : patch.description,
            assigneeAgentId: patch.assigneeAgentId ?? locked.assigneeAgentId,
            priority: patch.priority ?? locked.priority,
            status: patch.status ?? locked.status,
            concurrencyPolicy: patch.concurrencyPolicy ?? locked.concurrencyPolicy,
            catchUpPolicy: patch.catchUpPolicy ?? locked.catchUpPolicy,
            ...(patch.agentCompletionPolicyOverride !== undefined
              ? { agentCompletionPolicyOverride: patch.agentCompletionPolicyOverride }
              : {}),
            variables: patch.variables === undefined ? locked.variables : patch.variables,
            updatedByAgentId: actor.agentId ?? null,
            updatedByUserId: actor.userId ?? null,
            updatedAt: new Date(),
          })
          .where(eq(routines.id, id))
          .returning();
        return row ?? null;
      });
      return updated ? toRoutine(updated) : null;
    },

    createTrigger: async (
      routineId: string,
      input: CreateRoutineTrigger,
      actor: Actor,
    ): Promise<{ trigger: RoutineTrigger; secretMaterial: RoutineTriggerSecretMaterial | null }> => {
      const routine = await getRoutineById(routineId);
      if (!routine) throw notFound("Routine not found");

      let secretMaterial: RoutineTriggerSecretMaterial | null = null;
      let secretId: string | null = null;
      let publicId: string | null = null;
      let nextRunAt: Date | null = null;

      if (input.kind === "schedule") {
        const timeZone = input.timezone || "UTC";
        assertTimeZone(timeZone);
        const error = validateCron(input.cronExpression);
        if (error) throw unprocessable(error);
        nextRunAt = nextCronTickInTimeZone(input.cronExpression, timeZone, new Date());
      }

      if (input.kind === "webhook") {
        publicId = crypto.randomBytes(12).toString("hex");
        const created = await createWebhookSecret(routine.companyId, routine.id, actor);
        secretId = created.secret.id;
        secretMaterial = {
          webhookUrl: `${process.env.AOA_API_URL ?? process.env.AOA_API_URL}/api/routine-triggers/public/${publicId}/fire`,
          webhookSecret: created.secretValue,
        };
      }

      const [trigger] = await db
        .insert(routineTriggers)
        .values({
          companyId: routine.companyId,
          routineId: routine.id,
          kind: input.kind,
          label: input.label ?? null,
          enabled: true,
          cronExpression: input.kind === "schedule" ? input.cronExpression : null,
          timezone: input.kind === "schedule" ? (input.timezone || "UTC") : null,
          nextRunAt,
          publicId,
          secretId,
          signingMode: input.kind === "webhook" ? input.signingMode : null,
          replayWindowSec: input.kind === "webhook" ? input.replayWindowSec : null,
          lastRotatedAt: input.kind === "webhook" ? new Date() : null,
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
        })
        .returning();

      return {
        trigger: toRoutineTrigger(trigger),
        secretMaterial,
      };
    },

    updateTrigger: async (id: string, patch: UpdateRoutineTrigger, actor: Actor): Promise<RoutineTrigger | null> => {
      const existing = await getTriggerById(id);
      if (!existing) return null;

      let nextRunAt = existing.nextRunAt;
      let cronExpression = existing.cronExpression;
      let timezone = existing.timezone;

      if (existing.kind === "schedule") {
        if (patch.cronExpression !== undefined) {
          if (patch.cronExpression == null) throw unprocessable("Scheduled triggers require cronExpression");
          const error = validateCron(patch.cronExpression);
          if (error) throw unprocessable(error);
          cronExpression = patch.cronExpression;
        }
        if (patch.timezone !== undefined) {
          if (patch.timezone == null) throw unprocessable("Scheduled triggers require timezone");
          assertTimeZone(patch.timezone);
          timezone = patch.timezone;
        }
        if (cronExpression && timezone) {
          nextRunAt = nextCronTickInTimeZone(cronExpression, timezone, new Date());
        }
      }

      const [updated] = await db
        .update(routineTriggers)
        .set({
          label: patch.label === undefined ? existing.label : patch.label,
          enabled: patch.enabled ?? existing.enabled,
          cronExpression,
          timezone,
          nextRunAt,
          signingMode: patch.signingMode === undefined ? existing.signingMode : patch.signingMode,
          replayWindowSec: patch.replayWindowSec === undefined ? existing.replayWindowSec : patch.replayWindowSec,
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(routineTriggers.id, id))
        .returning();

      return updated ? toRoutineTrigger(updated) : null;
    },

    deleteTrigger: async (id: string): Promise<boolean> => {
      const existing = await getTriggerById(id);
      if (!existing) return false;
      await db.delete(routineTriggers).where(eq(routineTriggers.id, id));
      return true;
    },

    rotateTriggerSecret: async (
      id: string,
      actor: Actor,
    ): Promise<{ trigger: RoutineTrigger; secretMaterial: RoutineTriggerSecretMaterial }> => {
      const existing = await getTriggerById(id);
      if (!existing) throw notFound("Routine trigger not found");
      if (existing.kind !== "webhook" || !existing.publicId || !existing.secretId) {
        throw unprocessable("Only webhook triggers can rotate secrets");
      }

      const secretValue = crypto.randomBytes(24).toString("hex");
      await secretsSvc.rotate(existing.secretId, { value: secretValue }, actor);
      const [updated] = await db
        .update(routineTriggers)
        .set({
          lastRotatedAt: new Date(),
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(routineTriggers.id, id))
        .returning();

      return {
        trigger: toRoutineTrigger(updated),
        secretMaterial: {
          webhookUrl: `${process.env.AOA_API_URL ?? process.env.AOA_API_URL}/api/routine-triggers/public/${existing.publicId}/fire`,
          webhookSecret: secretValue,
        },
      };
    },

    runRoutine: async (
      id: string,
      input: RunRoutine,
      actor?: { agentId: string | null; userId: string | null } | null,
    ) => {
      const routine = await getRoutineById(id);
      if (!routine) throw notFound("Routine not found");
      if (routine.status === "archived") throw conflict("Routine is archived");
      const trigger = input.triggerId ? await getTriggerById(input.triggerId) : null;
      if (trigger && trigger.routineId !== routine.id) throw forbidden("Trigger does not belong to routine");
      if (trigger && !trigger.enabled) throw conflict("Routine trigger is not active");
      return dispatchRoutineRun({
        routine,
        trigger,
        source: input.source ?? "manual",
        payload: input.payload as Record<string, unknown> | null | undefined,
        variables: input.variables as Record<string, unknown> | null | undefined,
        variableOverrides: input.variableOverrides as Record<string, string> | null | undefined,
        idempotencyKey: input.idempotencyKey,
        actor,
      });
    },

    firePublicTrigger: async (publicId: string, input: {
      authorizationHeader?: string | null;
      signatureHeader?: string | null;
      timestampHeader?: string | null;
      idempotencyKey?: string | null;
      rawBody?: Buffer | null;
      payload?: Record<string, unknown> | null;
    }) => {
      const trigger = await db
        .select()
        .from(routineTriggers)
        .where(and(eq(routineTriggers.publicId, publicId), eq(routineTriggers.kind, "webhook")))
        .then((rows) => rows[0] ?? null);
      if (!trigger) throw notFound("Routine trigger not found");
      const routine = await getRoutineById(trigger.routineId);
      if (!routine) throw notFound("Routine not found");
      if (!trigger.enabled || routine.status !== "active") throw conflict("Routine trigger is not active");

      const secretValue = await resolveTriggerSecret(trigger, routine.companyId);
      if (trigger.signingMode === "bearer") {
        const expected = `Bearer ${secretValue}`;
        const provided = input.authorizationHeader?.trim() ?? "";
        const expectedBuf = Buffer.from(expected);
        const providedBuf = Buffer.alloc(expectedBuf.length);
        providedBuf.write(provided.slice(0, expectedBuf.length));
        const valid =
          provided.length === expected.length &&
          crypto.timingSafeEqual(providedBuf, expectedBuf);
        if (!valid) {
          throw unauthorized();
        }
      } else {
        const rawBody = input.rawBody ?? Buffer.from(JSON.stringify(input.payload ?? {}));
        const providedSignature = input.signatureHeader?.trim() ?? "";
        const providedTimestamp = input.timestampHeader?.trim() ?? "";
        if (!providedSignature || !providedTimestamp) throw unauthorized();
        const tsMillis = normalizeWebhookTimestampMs(providedTimestamp);
        if (tsMillis == null) throw unauthorized();
        const replayWindowSec = trigger.replayWindowSec ?? 300;
        if (Math.abs(Date.now() - tsMillis) > replayWindowSec * 1000) {
          throw unauthorized();
        }
        const expectedHmac = crypto
          .createHmac("sha256", secretValue)
          .update(`${providedTimestamp}.`)
          .update(rawBody)
          .digest("hex");
        const normalizedSignature = providedSignature.replace(/^sha256=/, "");
        const valid =
          normalizedSignature.length === expectedHmac.length &&
          crypto.timingSafeEqual(Buffer.from(normalizedSignature), Buffer.from(expectedHmac));
        if (!valid) throw unauthorized();
      }

      return dispatchRoutineRun({
        routine,
        trigger,
        source: "webhook",
        payload: input.payload,
        idempotencyKey: input.idempotencyKey,
      });
    },

    listRuns: async (routineId: string, limit = 50): Promise<RoutineRunSummary[]> => {
      const cappedLimit = Math.max(1, Math.min(limit, 200));
      const rows = await db
        .select({
          id: routineRuns.id,
          companyId: routineRuns.companyId,
          routineId: routineRuns.routineId,
          triggerId: routineRuns.triggerId,
          source: routineRuns.source,
          status: routineRuns.status,
          triggeredAt: routineRuns.triggeredAt,
          idempotencyKey: routineRuns.idempotencyKey,
          triggerPayload: routineRuns.triggerPayload,
          linkedIssueId: routineRuns.linkedIssueId,
          coalescedIntoRunId: routineRuns.coalescedIntoRunId,
          failureReason: routineRuns.failureReason,
          completedAt: routineRuns.completedAt,
          createdAt: routineRuns.createdAt,
          updatedAt: routineRuns.updatedAt,
          triggerKind: routineTriggers.kind,
          triggerLabel: routineTriggers.label,
          issueIdentifier: issues.identifier,
          issueTitle: issues.title,
          issueStatus: issues.status,
          issuePriority: issues.priority,
          issueUpdatedAt: issues.updatedAt,
        })
        .from(routineRuns)
        .leftJoin(routineTriggers, eq(routineRuns.triggerId, routineTriggers.id))
        .leftJoin(issues, eq(routineRuns.linkedIssueId, issues.id))
        .where(eq(routineRuns.routineId, routineId))
        .orderBy(desc(routineRuns.createdAt))
        .limit(cappedLimit);

      return rows.map((row) => ({
        id: row.id,
        companyId: row.companyId,
        routineId: row.routineId,
        triggerId: row.triggerId,
        source: row.source as RoutineRunSummary["source"],
        status: row.status as RoutineRunSummary["status"],
        triggeredAt: toIso(row.triggeredAt),
        idempotencyKey: row.idempotencyKey,
        triggerPayload: row.triggerPayload as Record<string, unknown> | null,
        linkedIssueId: row.linkedIssueId,
        coalescedIntoRunId: row.coalescedIntoRunId,
        failureReason: row.failureReason,
        completedAt: toIsoOrNull(row.completedAt),
        createdAt: toIso(row.createdAt),
        updatedAt: toIso(row.updatedAt),
        linkedIssue: row.linkedIssueId
          ? {
            id: row.linkedIssueId,
            identifier: row.issueIdentifier ?? "",
            title: row.issueTitle ?? "Routine execution",
            status: row.issueStatus ?? "todo",
          }
          : null,
        trigger: row.triggerId
          ? {
            id: row.triggerId,
            kind: row.triggerKind as NonNullable<RoutineRunSummary["trigger"]>["kind"],
            label: row.triggerLabel,
          }
          : null,
      }));
    },

    tickScheduledTriggers: async (now: Date = new Date()) => {
      const due = await db
        .select({
          trigger: routineTriggers,
          routine: routines,
        })
        .from(routineTriggers)
        .innerJoin(routines, eq(routineTriggers.routineId, routines.id))
        .where(
          and(
            eq(routineTriggers.kind, "schedule"),
            eq(routineTriggers.enabled, true),
            eq(routines.status, "active"),
            isNotNull(routineTriggers.nextRunAt),
            lte(routineTriggers.nextRunAt, now),
          ),
        )
        .orderBy(asc(routineTriggers.nextRunAt), asc(routineTriggers.createdAt));

      let triggered = 0;
      for (const row of due) {
        if (!row.trigger.nextRunAt || !row.trigger.cronExpression || !row.trigger.timezone) continue;

        let runCount = 1;
        let claimedNextRunAt = nextCronTickInTimeZone(row.trigger.cronExpression, row.trigger.timezone, now);

        if (row.routine.catchUpPolicy === "enqueue_missed_with_cap") {
          let cursor: Date | null = row.trigger.nextRunAt;
          runCount = 0;
          while (cursor && cursor <= now && runCount < MAX_CATCH_UP_RUNS) {
            runCount += 1;
            claimedNextRunAt = nextCronTickInTimeZone(row.trigger.cronExpression, row.trigger.timezone, cursor);
            cursor = claimedNextRunAt;
          }
        }

        const claimed = await db
          .update(routineTriggers)
          .set({
            nextRunAt: claimedNextRunAt,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(routineTriggers.id, row.trigger.id),
              eq(routineTriggers.enabled, true),
              eq(routineTriggers.nextRunAt, row.trigger.nextRunAt),
            ),
          )
          .returning({ id: routineTriggers.id })
          .then((rows) => rows[0] ?? null);
        if (!claimed) continue;

        for (let i = 0; i < runCount; i += 1) {
          await dispatchRoutineRun({
            routine: row.routine,
            trigger: row.trigger,
            source: "schedule",
          });
          triggered += 1;
        }
      }

      return { triggered };
    },

    syncRunStatusForIssue: async (issueId: string) => {
      const issue = await db
        .select({
          id: issues.id,
          status: issues.status,
          originKind: issues.originKind,
          originRunId: issues.originRunId,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue || issue.originKind !== "routine_execution" || !issue.originRunId) return null;
      if (issue.status === "done") {
        return finalizeRun(issue.originRunId, {
          status: "completed",
          completedAt: new Date(),
        });
      }
      if (issue.status === "blocked" || issue.status === "cancelled") {
        const failed = await finalizeRun(issue.originRunId, {
          status: "failed",
          failureReason: `Execution issue moved to ${issue.status}`,
          completedAt: new Date(),
        });
        // Silent-automation-failure inbox signal (Task 10, D3): the routine's
        // execution issue was blocked/cancelled — surface it (helper re-fetches
        // the routine name/owner since none is loaded here).
        await emitRoutineFailure(failed, null);
        return failed;
      }
      return null;
    },

    createRevision: async (routineId: string, actor: Actor): Promise<void> => {
      await createRevisionInternal(routineId, actor);
    },

    listRevisions: async (routineId: string, companyId: string): Promise<RoutineRevisionListItem[]> => {
      const revs = await db
        .select()
        .from(routineRevisions)
        .where(and(eq(routineRevisions.routineId, routineId), eq(routineRevisions.companyId, companyId)))
        .orderBy(desc(routineRevisions.createdAt));

      // Resolve author info
      const agentIds = revs
        .map((r) => r.createdByAgentId)
        .filter((id): id is string => id != null);
      const agentMap = new Map<string, { name: string; urlKey: string }>();
      if (agentIds.length > 0) {
        const agentRows = await db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(and(inArray(agents.id, agentIds), eq(agents.companyId, companyId)));
        for (const a of agentRows) {
          agentMap.set(a.id, { name: a.name, urlKey: normalizeAgentUrlKey(a.name) ?? a.id });
        }
      }

      return revs.map((r): RoutineRevisionListItem => ({
        id: r.id,
        companyId: r.companyId,
        routineId: r.routineId,
        snapshot: r.snapshot as RoutineSnapshot,
        createdByAgentId: r.createdByAgentId,
        createdByUserId: r.createdByUserId,
        createdAt: r.createdAt.toISOString(),
        author: r.createdByAgentId
          ? (() => {
              const a = agentMap.get(r.createdByAgentId);
              return a ? { type: "agent" as const, name: a.name, urlKey: a.urlKey } : null;
            })()
          : r.createdByUserId
            ? { type: "user" as const, userId: r.createdByUserId }
            : null,
      }));
    },

    restoreRevision: async (
      routineId: string,
      revisionId: string,
      baseRevisionId: string | null | undefined,
      actor: Actor,
    ): Promise<Routine | null> => {
      if (actor.agentId) {
        throw forbidden("Only human operators may restore routine revisions");
      }
      const [rev] = await db
        .select()
        .from(routineRevisions)
        .where(and(eq(routineRevisions.id, revisionId), eq(routineRevisions.routineId, routineId)));
      if (!rev) return null;

      const snap = rev.snapshot as RoutineSnapshot;

      const updated = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await tx.execute(
          sql`select id from companies where id = ${rev.companyId} for no key update`,
        );

        // Snapshot before overwriting (creates revision for the current state)
        const preRoutine = await txDb
          .select()
          .from(routines)
          .where(eq(routines.id, routineId))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (preRoutine) {
          if (baseRevisionId !== undefined && baseRevisionId !== (preRoutine.latestRevisionId ?? null)) {
            throw conflict("Routine has been modified since your last load. Reload and retry.");
          }
          const preSnap = captureSnapshot(preRoutine);
          const [preRev] = await txDb
            .insert(routineRevisions)
            .values({
              companyId: preRoutine.companyId,
              routineId: preRoutine.id,
              snapshot: preSnap,
              createdByAgentId: actor.agentId ?? null,
              createdByUserId: actor.userId ?? null,
            })
            .returning();
          if (preRev) {
            await txDb.update(routines).set({ latestRevisionId: preRev.id }).where(eq(routines.id, routineId));
          }
        }

        // Apply the snapshot
        const [applyUpdated] = await txDb
          .update(routines)
          .set({
            title: snap.title,
            description: snap.description,
            assigneeAgentId: snap.assigneeAgentId,
            priority: snap.priority,
            status: snap.status,
            concurrencyPolicy: snap.concurrencyPolicy,
            catchUpPolicy: snap.catchUpPolicy,
            agentCompletionPolicyOverride: snap.agentCompletionPolicyOverride ?? null,
            variables: snap.variables,
            projectId: snap.projectId,
            goalId: snap.goalId,
            parentIssueId: snap.parentIssueId,
            updatedByAgentId: actor.agentId ?? null,
            updatedByUserId: actor.userId ?? null,
            updatedAt: new Date(),
          })
          .where(eq(routines.id, routineId))
          .returning();

        if (!applyUpdated) return null;

        // Snapshot the restored state as new HEAD revision
        const postRoutine = await txDb.select().from(routines).where(eq(routines.id, routineId)).then((rows) => rows[0] ?? null);
        let finalRoutine = applyUpdated;
        if (postRoutine) {
          const postSnap = captureSnapshot(postRoutine);
          const [postRev] = await txDb
            .insert(routineRevisions)
            .values({
              companyId: postRoutine.companyId,
              routineId: postRoutine.id,
              snapshot: postSnap,
              createdByAgentId: actor.agentId ?? null,
              createdByUserId: actor.userId ?? null,
            })
            .returning();
          if (postRev) {
            const [withLatestRevision] = await txDb
              .update(routines)
              .set({ latestRevisionId: postRev.id })
              .where(eq(routines.id, routineId))
              .returning();
            finalRoutine = withLatestRevision ?? finalRoutine;
          }
        }

        // Restoring a routine invalidates every webhook secret. Keep the
        // rotations in the restore transaction so a provider or vault failure
        // rolls back the restored definition instead of leaving an unrotated
        // webhook active behind a successful response.
        const triggers = await txDb
          .select()
          .from(routineTriggers)
          .where(and(eq(routineTriggers.routineId, routineId), eq(routineTriggers.kind, "webhook")));
        const txSecretsSvc = secretService(txDb);
        for (const trigger of triggers) {
          if (!trigger.secretId) continue;
          const newSecretValue = crypto.randomBytes(24).toString("hex");
          await txSecretsSvc.rotate(trigger.secretId, { value: newSecretValue }, actor);
        }

        return finalRoutine;
      });

      if (!updated) return null;

      return toRoutine(updated);
    },
  };
}
