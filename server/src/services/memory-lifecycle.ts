import { and, eq, lt, isNotNull, isNull, or, inArray, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { memoryItems, issues, taskDependencies, suggestions } from "@armyofagents/db";
import { logActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";
import { memoryItemsSelection } from "./memory-projection.js";

const log = logger.child({ service: "memory-lifecycle" });

const TERMINAL_STATUSES = ["done", "cancelled"];
const WORKING_MEMORY_TTL_DAYS = 7;
const STALENESS_THRESHOLD_DAYS = 90;
const MAX_CHAIN_DEPTH = 50;

/**
 * Check if a task's entire dependency chain is in a terminal state
 * and all have been terminal for at least `minDays` days.
 */
async function isFullChainTerminal(
  db: Db,
  companyId: string,
  taskId: string,
  minDays: number,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - minDays * 24 * 60 * 60 * 1000);

  // First check the linked task itself
  const [task] = await db
    .select({ status: issues.status, completedAt: issues.completedAt, cancelledAt: issues.cancelledAt })
    .from(issues)
    .where(eq(issues.id, taskId));

  if (!task) return true; // Task deleted — treat as terminal
  if (!TERMINAL_STATUSES.includes(task.status)) return false;

  const terminalDate = task.completedAt ?? task.cancelledAt;
  if (!terminalDate || terminalDate > cutoff) return false;

  // BFS through the full dependency chain (both directions)
  const visited = new Set<string>([taskId]);
  let currentIds = [taskId];

  for (let depth = 0; depth < MAX_CHAIN_DEPTH && currentIds.length > 0; depth++) {
    // Get all connected tasks (both upstream and downstream dependencies)
    const connected = await db
      .select({
        depId: taskDependencies.dependencyIssueId,
        depntId: taskDependencies.dependentIssueId,
      })
      .from(taskDependencies)
      .where(
        and(
          eq(taskDependencies.companyId, companyId),
          sql`(${taskDependencies.dependentIssueId} = ANY(${currentIds}) OR ${taskDependencies.dependencyIssueId} = ANY(${currentIds}))`,
        ),
      );

    const nextIds: string[] = [];
    for (const row of connected) {
      if (!visited.has(row.depId)) {
        visited.add(row.depId);
        nextIds.push(row.depId);
      }
      if (!visited.has(row.depntId)) {
        visited.add(row.depntId);
        nextIds.push(row.depntId);
      }
    }

    if (nextIds.length === 0) break;

    // Check all newly discovered tasks
    const chainTasks = await db
      .select({ id: issues.id, status: issues.status, completedAt: issues.completedAt, cancelledAt: issues.cancelledAt })
      .from(issues)
      .where(inArray(issues.id, nextIds));

    for (const ct of chainTasks) {
      if (!TERMINAL_STATUSES.includes(ct.status)) return false;
      const ctDate = ct.completedAt ?? ct.cancelledAt;
      if (!ctDate || ctDate > cutoff) return false;
    }

    currentIds = nextIds;
  }

  if (currentIds.length > 0) {
    log.warn({ taskId, companyId, depth: MAX_CHAIN_DEPTH }, "Dependency chain exceeded max depth; assuming terminal");
  }

  return true;
}

export function memoryLifecycleService(db: Db) {
  return {
    /**
     * Archive active_context memory items when a goal reaches terminal state (achieved/cancelled).
     */
    onGoalCompleted: async (companyId: string, goalId: string): Promise<number> => {
      const itemsToArchive = await db
        .select(memoryItemsSelection())
        .from(memoryItems)
        .where(
          and(
            eq(memoryItems.companyId, companyId),
            eq(memoryItems.layer, "active_context"),
            eq(memoryItems.goalId, goalId),
            eq(memoryItems.status, "approved"),
          ),
        );

      if (itemsToArchive.length === 0) return 0;

      const ids = itemsToArchive.map((i) => i.id);
      await db
        .update(memoryItems)
        .set({ status: "archived", updatedAt: new Date() })
        .where(inArray(memoryItems.id, ids));

      // Log activity for each archived item
      for (const item of itemsToArchive) {
        await logActivity(db, {
          companyId,
          actorType: "system",
          actorId: "system",
          action: "memory.auto_archived",
          entityType: "memory_item",
          entityId: item.id,
          details: { title: item.title, layer: "active_context", reason: "goal_completed", goalId },
        });
      }

      return itemsToArchive.length;
    },

    /**
     * Archive working memory items whose entire task dependency chain
     * has been in a terminal state for 7+ days.
     */
    archiveExpiredWorkingMemory: async (companyId: string): Promise<number> => {
      const workingItems = await db
        .select(memoryItemsSelection())
        .from(memoryItems)
        .where(
          and(
            eq(memoryItems.companyId, companyId),
            eq(memoryItems.layer, "working"),
            eq(memoryItems.status, "approved"),
            isNotNull(memoryItems.taskId),
          ),
        );

      let archivedCount = 0;
      for (const item of workingItems) {
        const shouldArchive = await isFullChainTerminal(
          db,
          companyId,
          item.taskId!,
          WORKING_MEMORY_TTL_DAYS,
        );

        if (shouldArchive) {
          await db
            .update(memoryItems)
            .set({ status: "archived", updatedAt: new Date() })
            .where(eq(memoryItems.id, item.id));

          await logActivity(db, {
            companyId,
            actorType: "system",
            actorId: "system",
            action: "memory.auto_archived",
            entityType: "memory_item",
            entityId: item.id,
            details: {
              title: item.title,
              layer: "working",
              reason: "working_memory_ttl",
              taskId: item.taskId,
            },
          });
          archivedCount++;
        }
      }

      return archivedCount;
    },

    /**
     * Archive items with an expiresAt timestamp that has passed.
     */
    archiveExpiredItems: async (companyId: string): Promise<number> => {
      const now = new Date();
      const expiredItems = await db
        .select(memoryItemsSelection())
        .from(memoryItems)
        .where(
          and(
            eq(memoryItems.companyId, companyId),
            eq(memoryItems.status, "approved"),
            isNotNull(memoryItems.expiresAt),
            lt(memoryItems.expiresAt, now),
          ),
        );

      if (expiredItems.length === 0) return 0;

      const ids = expiredItems.map((i) => i.id);
      await db
        .update(memoryItems)
        .set({ status: "archived", updatedAt: new Date() })
        .where(inArray(memoryItems.id, ids));

      for (const item of expiredItems) {
        await logActivity(db, {
          companyId,
          actorType: "system",
          actorId: "system",
          action: "memory.auto_archived",
          entityType: "memory_item",
          entityId: item.id,
          details: {
            title: item.title,
            layer: item.layer,
            reason: "expired",
            expiresAt: item.expiresAt?.toISOString(),
          },
        });
      }

      return expiredItems.length;
    },

    /**
     * Condition 4 — archive working-layer items scoped to a completed/cancelled task.
     * Called from routes/issues.ts when issue status → done or cancelled.
     * Returns the number of items archived.
     */
    onTaskCompleted: async (companyId: string, taskId: string): Promise<number> => {
      const itemsToArchive = await db
        .select(memoryItemsSelection())
        .from(memoryItems)
        .where(
          and(
            eq(memoryItems.companyId, companyId),
            eq(memoryItems.taskId, taskId),
            eq(memoryItems.layer, "working"),
            eq(memoryItems.status, "approved"),
          ),
        );

      if (itemsToArchive.length === 0) return 0;

      const ids = itemsToArchive.map((i) => i.id);
      await db
        .update(memoryItems)
        .set({ status: "archived", updatedAt: new Date() })
        .where(inArray(memoryItems.id, ids));

      for (const item of itemsToArchive) {
        await logActivity(db, {
          companyId,
          actorType: "system",
          actorId: "system",
          action: "memory.auto_archived",
          entityType: "memory_item",
          entityId: item.id,
          details: {
            title: item.title,
            layer: "working",
            reason: "task_completed",
            taskId,
          },
        });
      }

      return itemsToArchive.length;
    },

    /**
     * Flag identity/domain items not accessed in 90+ days by creating suggestions.
     * Does NOT auto-archive — founder decides.
     */
    flagStaleItems: async (companyId: string): Promise<number> => {
      const cutoff = new Date(Date.now() - STALENESS_THRESHOLD_DAYS * 24 * 60 * 60 * 1000);

      const staleItems = await db
        .select(memoryItemsSelection())
        .from(memoryItems)
        .where(
          and(
            eq(memoryItems.companyId, companyId),
            eq(memoryItems.status, "approved"),
            inArray(memoryItems.layer, ["identity", "domain"]),
            // Stale if last accessed before the cutoff, OR never accessed
            // (accessedAt IS NULL) but created before the cutoff. The plain
            // `accessedAt < cutoff` form silently drops never-accessed rows
            // because NULL < cutoff evaluates to NULL (not TRUE). (A-M4)
            or(
              lt(memoryItems.accessedAt, cutoff),
              and(isNull(memoryItems.accessedAt), lt(memoryItems.createdAt, cutoff)),
            ),
          ),
        );

      // Filter out items that already have pending staleness suggestions
      const existingSuggestions = staleItems.length > 0
        ? await db
            .select({ relatedMemoryItemId: suggestions.relatedMemoryItemId })
            .from(suggestions)
            .where(
              and(
                eq(suggestions.companyId, companyId),
                eq(suggestions.category, "memory_gap"),
                eq(suggestions.actionType, "archive_memory"),
                eq(suggestions.status, "pending"),
                inArray(
                  suggestions.relatedMemoryItemId,
                  staleItems.map((i) => i.id),
                ),
              ),
            )
        : [];

      const alreadyFlaggedIds = new Set(existingSuggestions.map((s) => s.relatedMemoryItemId));
      const itemsToFlag = staleItems.filter((i) => !alreadyFlaggedIds.has(i.id));

      if (itemsToFlag.length === 0) return 0;

      for (const item of itemsToFlag) {
        // For never-accessed items, `accessedAt` is null — measuring age from
        // the epoch (getTime() ?? 0) yields a nonsense ~20000-day count. Fall
        // back to `createdAt` so the age reflects how long the item has
        // existed unused. (A-M4 / Codex P2)
        const neverAccessed = !item.accessedAt;
        const ageAnchor = item.accessedAt ?? item.createdAt;
        const daysUnused = ageAnchor
          ? Math.floor((Date.now() - ageAnchor.getTime()) / (24 * 60 * 60 * 1000))
          : 0;

        const title = neverAccessed
          ? `Memory item "${item.title}" has never been accessed (created ${daysUnused} days ago). Still relevant?`
          : `Memory item "${item.title}" hasn't been used in ${daysUnused} days. Still relevant?`;
        const evidence = neverAccessed
          ? `Never accessed since creation ${item.createdAt?.toISOString() ?? "unknown"}. Layer: ${item.layer}.`
          : `Last accessed: ${item.accessedAt!.toISOString()}. Layer: ${item.layer}.`;

        await db
          .insert(suggestions)
          .values({
            companyId,
            category: "memory_gap",
            actionType: "archive_memory",
            dedupeKey: `memory_gap:stale:${item.id}`,
            title,
            evidence,
            status: "pending",
            relatedMemoryItemId: item.id,
            actionPayload: { memoryItemId: item.id },
          })
          .onConflictDoNothing();
      }

      return itemsToFlag.length;
    },
  };
}
