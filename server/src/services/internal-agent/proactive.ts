// server/src/services/internal-agent/proactive.ts
// Proactive checks for the internal agent — T11
import { and, eq, lt, lte, gte, isNull, isNotNull, notInArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@armyofagents/db";
import {
  issues,
  taskDependencies,
  internalAgentConfig,
  internalAgentRuns,
  internalAgentReminders,
  memoryFeedbackPatterns,
  activityLog,
} from "@armyofagents/db";
import { hubItemsService } from "../hub-items.js";

// Mirror of dependencies.ts TERMINAL_STATUSES (A-H9). Kept as a local literal
// rather than imported to avoid dragging the issues/heartbeat/memory module
// graph into this proactive-checks module. Both `done` and `cancelled` are
// terminal: a cancelled dependency now releases its dependents, so neither
// should be flagged as a dependency-chain gap.
const TERMINAL_DEPENDENCY_STATUSES = ["done", "cancelled"];

// ── Types ────────────────────────────────────────────────────────────────────

interface ProactiveCheckResult {
  findings: unknown[];
  runCreated: boolean;
}

interface BudgetAlertResult {
  triggered: boolean;
  percentUsed: number;
  runCreated: boolean;
}

interface DigestResult {
  digest: {
    overnightActivity: unknown[];
    activeTasks: unknown[];
    pendingReminders: unknown[];
  };
  runCreated: boolean;
}

interface ReminderCheckResult {
  firedCount: number;
  runCreated: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function createRunRecord(
  db: Db,
  companyId: string,
  triggerSource: string,
  summary: string,
  userId?: string | null,
) {
  const [run] = await db
    .insert(internalAgentRuns)
    .values({
      companyId,
      triggerType: "proactive",
      triggerSource,
      status: "completed",
      summary,
      userId: userId ?? null,
      completedAt: new Date(),
    })
    .returning();
  return run;
}

/**
 * Fetch the company's internal agent notification preference.
 * Returns 'realtime' as default if no config exists.
 */
async function getNotificationPreference(
  db: Db,
  companyId: string,
): Promise<string> {
  const configs = await db
    .select({ notificationPreference: internalAgentConfig.notificationPreference })
    .from(internalAgentConfig)
    .where(eq(internalAgentConfig.companyId, companyId));

  return configs[0]?.notificationPreference ?? "realtime";
}

/**
 * Create a notification, respecting the company's notification preference.
 * If preference is 'silent', skip notification creation entirely.
 */
async function createNotificationIfAllowed(
  db: Db,
  companyId: string,
  userId: string,
  title: string,
  message: string,
  preference: string,
  // Stable per-check discriminator (e.g. "blocked_task_scan"). All proactive
  // checks share semanticType `proactive`, so the source id MUST encode the
  // check kind so distinct checks don't collide on one open hub row, and a
  // re-run of the same check for the same recipient dedupes onto its own item.
  checkKind: string,
) {
  if (preference === "silent") return null;

  // 'digest' and 'realtime' both create the notification record.
  // Digest batching is a consumer concern (the UI groups them).
  // Natural-owner item: the recipient is the owner.
  return hubItemsService(db).emit({
    companyId,
    semanticType: "proactive",
    sourceType: "internal_agent_check",
    sourceId: `${checkKind}:${userId}`,
    title,
    summary: message,
    ownerUserId: userId,
  });
}

// ── Checks ───────────────────────────────────────────────────────────────────

/**
 * Find tasks in 'in_progress' that have unresolved blocking dependencies.
 */
export async function blockedTaskScan(
  db: Db,
  companyId: string,
  userId: string,
): Promise<ProactiveCheckResult> {
  const preference = await getNotificationPreference(db, companyId);

  // A task is genuinely "blocked" only if it is `in_progress` AND at least one
  // of its dependencies (the `dependencyIssueId` side of the edge) is itself
  // NOT terminal. `task_dependencies` has no status column, so completion is
  // knowable only via the dependency issue's own status — hence the second
  // `issues` alias join. Both `done` and `cancelled` are terminal (A-M14,
  // matching the A-H9 sibling check above): a completed or cancelled dependency
  // no longer blocks, so it must not inflate the count.
  //
  // `selectDistinct({ id })` collapses the row fan-out: a task with N incomplete
  // dependencies produces N join rows, which would otherwise be counted N times
  // in `blockedTasks.length` (the value reported in the summary + notification).
  const depIssue = alias(issues, "dep_issue");
  const blockedTasks = await db
    .selectDistinct({ id: issues.id })
    .from(issues)
    .innerJoin(
      taskDependencies,
      eq(taskDependencies.dependentIssueId, issues.id),
    )
    .innerJoin(depIssue, eq(depIssue.id, taskDependencies.dependencyIssueId))
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.status, "in_progress"),
        notInArray(depIssue.status, TERMINAL_DEPENDENCY_STATUSES),
      ),
    );

  const summary =
    blockedTasks.length > 0
      ? `Found ${blockedTasks.length} in-progress task(s) with unresolved dependencies`
      : "No blocked tasks found";

  await createRunRecord(db, companyId, "blocked_task_scan", summary, userId);

  if (blockedTasks.length > 0) {
    await createNotificationIfAllowed(
      db, companyId, userId,
      "Blocked Tasks Detected", summary, preference,
      "blocked_task_scan",
    );
  }

  return { findings: blockedTasks, runCreated: true };
}

/**
 * Check agent + internal agent spend vs limits (80% warning).
 */
export async function budgetThresholdAlert(
  db: Db,
  companyId: string,
  userId: string,
): Promise<BudgetAlertResult> {
  const preference = await getNotificationPreference(db, companyId);

  const configs = await db
    .select()
    .from(internalAgentConfig)
    .where(eq(internalAgentConfig.companyId, companyId));

  const config = configs[0];

  // No config or unlimited budget → skip
  if (!config || config.budgetMonthlyCents == null) {
    await createRunRecord(
      db, companyId, "budget_threshold_alert",
      "Budget unlimited or no config", userId,
    );
    return { triggered: false, percentUsed: 0, runCreated: true };
  }

  const percentUsed =
    config.budgetMonthlyCents > 0
      ? (config.spentMonthlyCents / config.budgetMonthlyCents) * 100
      : 0;

  const triggered = percentUsed >= 80;
  const summary = triggered
    ? `Budget alert: ${percentUsed.toFixed(1)}% used (${config.spentMonthlyCents}/${config.budgetMonthlyCents} cents)`
    : `Budget OK: ${percentUsed.toFixed(1)}% used`;

  await createRunRecord(db, companyId, "budget_threshold_alert", summary, userId);

  if (triggered) {
    await createNotificationIfAllowed(
      db, companyId, userId,
      "Budget Alert: 80% Threshold Reached", summary, preference,
      "budget_threshold_alert",
    );
  }

  return { triggered, percentUsed, runCreated: true };
}

/**
 * Tasks in 'in_progress' with no activity for 3+ days.
 */
export async function staleWorkDetection(
  db: Db,
  companyId: string,
  userId: string,
): Promise<ProactiveCheckResult> {
  const preference = await getNotificationPreference(db, companyId);

  const threeDaysAgo = new Date();
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

  const staleTasks = await db
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.status, "in_progress"),
        lt(issues.updatedAt, threeDaysAgo),
      ),
    );

  const summary =
    staleTasks.length > 0
      ? `Found ${staleTasks.length} stale task(s) with no activity for 3+ days`
      : "No stale tasks found";

  await createRunRecord(db, companyId, "stale_work_detection", summary, userId);

  if (staleTasks.length > 0) {
    await createNotificationIfAllowed(
      db, companyId, userId,
      "Stale Work Detected", summary, preference,
      "stale_work_detection",
    );
  }

  return { findings: staleTasks, runCreated: true };
}

/**
 * Detect broken dependency chains: tasks depending on cancelled tasks,
 * leaving them permanently stuck.
 */
export async function dependencyChainGaps(
  db: Db,
  companyId: string,
  userId: string,
): Promise<ProactiveCheckResult> {
  const preference = await getNotificationPreference(db, companyId);

  // Alias: "dependent" is the task waiting, "dependency" is the task it waits on.
  // Both `done` and `cancelled` are terminal (A-H9): a cancelled dependency now
  // *releases* its dependents (moving them off `blocked`) instead of stranding
  // them, so a cancelled (or done) dependency must NOT be flagged as a gap —
  // otherwise this check emits a false positive for every released chain.
  //
  // The genuine residual gap is a dependent that is STILL `blocked` even though
  // EVERY one of its dependencies is terminal — the auto-release should have
  // fired but the task is stuck. A dependent that is correctly blocked by a
  // still-running (non-terminal) dependency is normal and never a gap.
  const allDeps = await db
    .select({
      dependentId: taskDependencies.dependentIssueId,
      dependencyId: taskDependencies.dependencyIssueId,
    })
    .from(taskDependencies)
    .where(eq(taskDependencies.companyId, companyId));

  if (allDeps.length === 0) {
    await createRunRecord(db, companyId, "dependency_chain_gaps", "No dependencies to check", userId);
    return { findings: [], runCreated: true };
  }

  // Resolve the status of every task involved in a dependency edge.
  const statusRows = await db
    .select({ id: issues.id, status: issues.status })
    .from(issues)
    .where(eq(issues.companyId, companyId));

  const statusById = new Map<string, string>();
  for (const row of statusRows) {
    statusById.set(row.id, row.status);
  }

  // Group dependencies by dependent so we can require ALL of them to be terminal.
  const depsByDependent = new Map<string, string[]>();
  for (const d of allDeps) {
    const list = depsByDependent.get(d.dependentId) ?? [];
    list.push(d.dependencyId);
    depsByDependent.set(d.dependentId, list);
  }

  const gaps = allDeps.filter((d) => {
    const dependentStatus = statusById.get(d.dependentId);
    // Only a still-blocked dependent can be a gap.
    if (dependentStatus !== "blocked") return false;
    const dependencyStatus = statusById.get(d.dependencyId);
    if (dependencyStatus === undefined) return false;
    // Non-terminal dependency → normal in-flight blocking, not a gap.
    if (!TERMINAL_DEPENDENCY_STATUSES.includes(dependencyStatus)) return false;
    // Anomaly only if EVERY dependency of this dependent is terminal (so the
    // release should have fired). If a sibling dependency is still running, the
    // dependent is correctly blocked — not a gap.
    const siblings = depsByDependent.get(d.dependentId) ?? [];
    return siblings.every((depId) => {
      const s = statusById.get(depId);
      return s !== undefined && TERMINAL_DEPENDENCY_STATUSES.includes(s);
    });
  });

  const summary =
    gaps.length > 0
      ? `Found ${gaps.length} dependency chain gap(s) (tasks depending on cancelled tasks)`
      : "No dependency chain gaps found";

  await createRunRecord(db, companyId, "dependency_chain_gaps", summary, userId);

  if (gaps.length > 0) {
    await createNotificationIfAllowed(
      db, companyId, userId,
      "Dependency Chain Gaps", summary, preference,
      "dependency_chain_gaps",
    );
  }

  return { findings: gaps, runCreated: true };
}

/**
 * Detect recurring correction patterns in memory feedback that indicate conflicts.
 * Patterns with status 'detected' and occurrenceCount >= 3 suggest systematic issues.
 */
export async function memoryConflictScan(
  db: Db,
  companyId: string,
  userId: string,
): Promise<ProactiveCheckResult> {
  const preference = await getNotificationPreference(db, companyId);

  const conflicts = await db
    .select()
    .from(memoryFeedbackPatterns)
    .where(
      and(
        eq(memoryFeedbackPatterns.companyId, companyId),
        eq(memoryFeedbackPatterns.status, "detected"),
        gte(memoryFeedbackPatterns.occurrenceCount, 3),
      ),
    );

  const summary =
    conflicts.length > 0
      ? `Found ${conflicts.length} memory conflict pattern(s) with 3+ occurrences`
      : "No memory conflicts found";

  await createRunRecord(db, companyId, "memory_conflict_scan", summary, userId);

  if (conflicts.length > 0) {
    await createNotificationIfAllowed(
      db, companyId, userId,
      "Memory Conflicts Detected", summary, preference,
      "memory_conflict_scan",
    );
  }

  return { findings: conflicts, runCreated: true };
}

/**
 * Agents with >3x average task count (in_progress + todo).
 * Uses the issues.assigneeAgentId field (single agent per task).
 */
export async function workloadImbalance(
  db: Db,
  companyId: string,
  userId: string,
): Promise<ProactiveCheckResult> {
  const preference = await getNotificationPreference(db, companyId);

  // Query active tasks with an assigned agent, group in-memory
  const activeTasks = await db
    .select({
      assigneeAgentId: issues.assigneeAgentId,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        isNotNull(issues.assigneeAgentId),
        // Count both in_progress and todo tasks for workload
        sql`${issues.status} IN ('in_progress', 'todo')`,
      ),
    );

  // Group by agent
  const agentTaskMap = new Map<string, number>();
  for (const task of activeTasks) {
    if (task.assigneeAgentId) {
      agentTaskMap.set(
        task.assigneeAgentId,
        (agentTaskMap.get(task.assigneeAgentId) ?? 0) + 1,
      );
    }
  }

  const counts = Array.from(agentTaskMap.values());
  const avg = counts.length > 0 ? counts.reduce((a, b) => a + b, 0) / counts.length : 0;
  const imbalanced = Array.from(agentTaskMap.entries()).filter(
    ([, count]) => avg > 0 && count > avg * 3,
  );

  const summary =
    imbalanced.length > 0
      ? `Found ${imbalanced.length} agent(s) with >3x average workload`
      : "Workload is balanced";

  await createRunRecord(db, companyId, "workload_imbalance", summary, userId);

  if (imbalanced.length > 0) {
    await createNotificationIfAllowed(
      db, companyId, userId,
      "Workload Imbalance Detected", summary, preference,
      "workload_imbalance",
    );
  }

  return { findings: imbalanced, runCreated: true };
}

/**
 * Summarize overnight activity for a morning digest.
 * Queries the activity_log table for the last 12 hours.
 */
export async function morningDigest(
  db: Db,
  companyId: string,
  userId: string,
): Promise<DigestResult> {
  const twelveHoursAgo = new Date();
  twelveHoursAgo.setHours(twelveHoursAgo.getHours() - 12);

  // Fetch overnight activity from the activity log
  const overnightActivity = await db
    .select()
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, companyId),
        gte(activityLog.createdAt, twelveHoursAgo),
      ),
    );

  // Fetch current in-progress tasks
  const activeTasks = await db
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.status, "in_progress"),
      ),
    );

  // Fetch pending reminders for this user
  const pendingReminders = await db
    .select()
    .from(internalAgentReminders)
    .where(
      and(
        eq(internalAgentReminders.companyId, companyId),
        eq(internalAgentReminders.userId, userId),
        eq(internalAgentReminders.status, "pending"),
      ),
    );

  const summary = `Morning digest: ${overnightActivity.length} overnight events, ${activeTasks.length} active tasks, ${pendingReminders.length} pending reminders`;

  await createRunRecord(db, companyId, "morning_digest", summary, userId);

  return {
    digest: {
      overnightActivity,
      activeTasks,
      pendingReminders,
    },
    runCreated: true,
  };
}

/**
 * Query due reminders, fire them, create notifications.
 */
export async function checkReminders(
  db: Db,
  companyId: string,
): Promise<ReminderCheckResult> {
  const now = new Date();

  // Find pending reminders that are due
  const dueReminders = await db
    .select()
    .from(internalAgentReminders)
    .where(
      and(
        eq(internalAgentReminders.companyId, companyId),
        eq(internalAgentReminders.status, "pending"),
        lte(internalAgentReminders.triggerAt, now),
      ),
    );

  if (dueReminders.length === 0) {
    await createRunRecord(
      db, companyId, "check_reminders", "No due reminders",
    );
    return { firedCount: 0, runCreated: true };
  }

  // Create a run record for this batch
  const run = await createRunRecord(
    db, companyId, "check_reminders",
    `Fired ${dueReminders.length} reminder(s)`,
  );

  // Fire each reminder
  for (const reminder of dueReminders) {
    // Mark as fired
    await db
      .update(internalAgentReminders)
      .set({ status: "fired", firedRunId: run.id })
      .where(eq(internalAgentReminders.id, reminder.id));

    // Reminders always notify regardless of preference. Natural-owner item:
    // the reminder's user is the owner. sourceId = the reminder row id so each
    // fired reminder is its own hub item (a re-fire dedupes onto the same row).
    await hubItemsService(db).emit({
      companyId,
      semanticType: "reminder",
      sourceType: "internal_agent_reminder",
      sourceId: reminder.id,
      title: "Reminder",
      summary: reminder.content,
      ownerUserId: reminder.userId,
    });
  }

  return { firedCount: dueReminders.length, runCreated: true };
}
