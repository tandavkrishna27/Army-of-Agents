import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  briefs,
  briefItems,
  debriefs,
  memoryItems,
  memoryItemVersions,
} from "@armyofagents/db";
import { issueService } from "./issues.js";
import { memoryService } from "./memory.js";
import { dependencyService } from "./dependencies.js";

export interface BriefFilters {
  status?: string;
  departmentId?: string;
}

type BriefItemRow = typeof briefItems.$inferSelect;
type BriefRow = typeof briefs.$inferSelect;

function isMemoryBriefType(type: string): type is "decision" | "insight" | "context" | "reference" | "preference" {
  return type === "decision" || type === "insight" || type === "context" || type === "reference" || type === "preference";
}

/**
 * Resolve departmentId/projectId for a brief item using fallback chain.
 * Decision #61: item-level > brief-level > null
 */
function resolveDepartment(item: BriefItemRow, brief: BriefRow) {
  return {
    departmentId: item.suggestedDepartmentId ?? brief.departmentId ?? null,
    projectId: item.suggestedProjectId ?? brief.projectId ?? null,
  };
}

function resolveMemoryLayer(item: BriefItemRow) {
  return item.layer ?? item.suggestedLayer ?? "domain";
}

function resolveMemoryContent(item: BriefItemRow) {
  return item.mergedContent?.trim() || item.description?.trim() || item.title;
}

function mergeMemoryContent(existingContent: string, nextContent: string) {
  const current = existingContent.trim();
  const incoming = nextContent.trim();
  if (!current) return incoming;
  if (!incoming) return current;
  if (current === incoming) return current;
  return `${current}\n\n${incoming}`;
}

function buildSourceContext(briefTitle: string | null, debriefCreatedAt: Date) {
  const safeTitle = briefTitle?.trim() || "Untitled brief";
  return `Created from brief '${safeTitle}' (debrief: ${debriefCreatedAt.toISOString().slice(0, 10)})`;
}

export function briefService(db: Db) {
  const issues = issueService(db);
  const memory = memoryService(db);
  const deps = dependencyService(db);

  return {
    list: async (companyId: string, filters: BriefFilters = {}) => {
      const conditions = [eq(briefs.companyId, companyId)];

      if (filters.status) {
        conditions.push(eq(briefs.status, filters.status));
      }
      if (filters.departmentId) {
        conditions.push(eq(briefs.departmentId, filters.departmentId));
      }

      const rows = await db
        .select({
          id: briefs.id,
          companyId: briefs.companyId,
          debriefId: briefs.debriefId,
          status: briefs.status,
          departmentId: briefs.departmentId,
          projectId: briefs.projectId,
          goalId: briefs.goalId,
          reviewedAt: briefs.reviewedAt,
          reviewedBy: briefs.reviewedBy,
          createdAt: briefs.createdAt,
          updatedAt: briefs.updatedAt,
          sourceType: debriefs.inputType,
          departmentName: sql<string | null>`(SELECT name FROM projects WHERE id = ${briefs.departmentId})`,
          projectName: sql<string | null>`(SELECT name FROM projects WHERE id = ${briefs.projectId})`,
          itemCount: sql<number>`(SELECT count(*)::int FROM brief_items WHERE brief_items.brief_id = ${briefs.id})`,
        })
        .from(briefs)
        .innerJoin(debriefs, eq(briefs.debriefId, debriefs.id))
        .where(and(...conditions))
        .orderBy(sql`${briefs.createdAt} DESC`);

      return rows;
    },

    getById: async (companyId: string, id: string) => {
      const brief = await db
        .select()
        .from(briefs)
        .where(and(eq(briefs.id, id), eq(briefs.companyId, companyId)))
        .then((rows) => rows[0] ?? null);

      if (!brief) return null;

      const items = await db
        .select()
        .from(briefItems)
        .where(eq(briefItems.briefId, brief.id));

      return { ...brief, items };
    },

    updateBrief: async (
      companyId: string,
      briefId: string,
      patch: Partial<Pick<typeof briefs.$inferInsert, "status" | "departmentId" | "projectId" | "goalId" | "reviewedBy">>,
    ) =>
      db
        .update(briefs)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(briefs.id, briefId), eq(briefs.companyId, companyId)))
        .returning()
        .then((rows) => rows[0] ?? null),

    getItemById: async (briefId: string, itemId: string) => {
      return db
        .select()
        .from(briefItems)
        .where(and(eq(briefItems.id, itemId), eq(briefItems.briefId, briefId)))
        .then((rows) => rows[0] ?? null);
    },

    updateItemStatus: async (
      companyId: string,
      briefId: string,
      itemId: string,
      patch: Partial<typeof briefItems.$inferInsert>,
    ) => {
      const brief = await db
        .select()
        .from(briefs)
        .where(and(eq(briefs.id, briefId), eq(briefs.companyId, companyId)))
        .then((rows) => rows[0] ?? null);

      if (!brief) return null;

      return db
        .update(briefItems)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(briefItems.id, itemId), eq(briefItems.briefId, briefId)))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    approveBrief: async (
      companyId: string,
      briefId: string,
      reviewedBy: string,
      dependencies?: Array<{ dependentItemId: string; dependencyItemId: string }>,
    ) => {
      const brief = await db
        .select()
        .from(briefs)
        .where(and(eq(briefs.id, briefId), eq(briefs.companyId, companyId)))
        .then((rows) => rows[0] ?? null);

      if (!brief) return null;

      const debrief = await db
        .select()
        .from(debriefs)
        .where(and(eq(debriefs.id, brief.debriefId), eq(debriefs.companyId, companyId)))
        .then((rows) => rows[0] ?? null);

      if (!debrief) return null;

      const items = await db
        .select()
        .from(briefItems)
        .where(eq(briefItems.briefId, briefId));

      return db.transaction(async (tx) => {
        const createdTaskIds: string[] = [];
        const createdMemoryIds: string[] = [];
        const itemIdToTaskId = new Map<string, string>();
        let approvedCount = 0;
        let rejectedCount = 0;

        for (const item of items) {
          const isApproved = item.status === "approved" || item.status === "edited";
          const isRejected = item.status === "rejected";

          if (isRejected) {
            rejectedCount++;
            continue;
          }
          if (!isApproved) {
            continue;
          }

          approvedCount++;
          const { departmentId, projectId } = resolveDepartment(item, brief);

          if (item.type === "task") {
            const task = await issues.create(companyId, {
              title: item.title,
              description: item.description,
              priority: item.suggestedPriority ?? "medium",
              source: "brief",
              projectId: departmentId ?? projectId ?? undefined,
              goalId: brief.goalId ?? undefined,
              assigneeAgentId: item.suggestedAssigneeId,
              status: item.suggestedAssigneeId ? "todo" : "backlog",
            }, tx);

            if (task) {
              createdTaskIds.push(task.id);
              itemIdToTaskId.set(item.id, task.id);
              await tx
                .update(briefItems)
                .set({ resultTaskId: task.id, updatedAt: new Date() })
                .where(eq(briefItems.id, item.id));
            }
            continue;
          }

          if (!isMemoryBriefType(item.type)) {
            continue;
          }

          const layer = resolveMemoryLayer(item);
          const content = resolveMemoryContent(item);
          const sourceContext = buildSourceContext(debrief.title, debrief.createdAt);
          const sourceTaskId =
            typeof debrief.sourceInfo?.issueId === "string" && debrief.sourceInfo.issueId.length > 0
              ? debrief.sourceInfo.issueId
              : null;
          const goalId = layer === "active_context" ? brief.goalId : null;
          const taskId = layer === "working" ? sourceTaskId : null;
          const similarItems = await memory.findSimilarItems(content, {
            companyId,
            departmentId: departmentId ?? undefined,
            layer,
          });

          const selectedSimilarItem =
            similarItems.find((match) => match.id === item.selectedMemoryId) ??
            (similarItems.length === 1 ? similarItems[0] : null);

          if ((item.dedupAction === "update_existing" || item.dedupAction === "replace") && !selectedSimilarItem) {
            throw new Error(`Brief item '${item.title}' requires a selected matching memory item.`);
          }

          if (item.dedupAction === "update_existing" && selectedSimilarItem) {
            const latestVersionNumber = await tx
              .select({ versionNumber: memoryItemVersions.versionNumber })
              .from(memoryItemVersions)
              .where(eq(memoryItemVersions.memoryItemId, selectedSimilarItem.id))
              .orderBy(desc(memoryItemVersions.versionNumber))
              .limit(1)
              .then((rows) => rows[0]?.versionNumber ?? 0);

            const nextContent = item.mergedContent?.trim()
              ? item.mergedContent.trim()
              : mergeMemoryContent(selectedSimilarItem.content, content);

            const [version] = await tx
              .insert(memoryItemVersions)
              .values({
                memoryItemId: selectedSimilarItem.id,
                versionNumber: latestVersionNumber + 1,
                content: nextContent,
                status: "approved",
                createdBy: reviewedBy,
              })
              .returning();

            await tx
              .update(memoryItems)
              .set({
                title: item.title,
                content: nextContent,
                layer,
                departmentId,
                projectId,
                goalId,
                taskId,
                sourceContext,
                currentVersionId: version.id,
                updatedAt: new Date(),
                embedding: null,
              })
              .where(eq(memoryItems.id, selectedSimilarItem.id));

            createdMemoryIds.push(selectedSimilarItem.id);
            await tx
              .update(briefItems)
              .set({ resultMemoryId: selectedSimilarItem.id, updatedAt: new Date() })
              .where(eq(briefItems.id, item.id));
            continue;
          }

          if (item.dedupAction === "replace" && selectedSimilarItem) {
            await tx
              .update(memoryItems)
              .set({ status: "archived", updatedAt: new Date() })
              .where(eq(memoryItems.id, selectedSimilarItem.id));
          }

          const memoryItem = await memory.create(companyId, {
            title: item.title,
            content,
            category: item.type,
            source: "brief",
            status: "approved",
            departmentId,
            projectId,
            createdBy: reviewedBy,
            layer,
            goalId,
            taskId,
            sourceContext,
          }, tx);

          if (memoryItem) {
            createdMemoryIds.push(memoryItem.id);
            await tx
              .update(briefItems)
              .set({ resultMemoryId: memoryItem.id, updatedAt: new Date() })
              .where(eq(briefItems.id, item.id));
          }
        }

        let createdDependencyCount = 0;
        let skippedDependencyCount = 0;
        if (dependencies && dependencies.length > 0) {
          for (const dep of dependencies) {
            const dependentTaskId = itemIdToTaskId.get(dep.dependentItemId);
            const dependencyTaskId = itemIdToTaskId.get(dep.dependencyItemId);
            if (dependentTaskId && dependencyTaskId) {
              try {
                await deps.addDependency(companyId, dependentTaskId, dependencyTaskId, tx);
                createdDependencyCount++;
              } catch {
                skippedDependencyCount++;
              }
            } else {
              skippedDependencyCount++;
            }
          }
        }

        let finalStatus: string;
        if (approvedCount > 0 && rejectedCount === 0) {
          finalStatus = "approved";
        } else if (approvedCount === 0 && rejectedCount > 0) {
          finalStatus = "rejected";
        } else {
          finalStatus = "partially_approved";
        }

        const [updatedBrief] = await tx
          .update(briefs)
          .set({
            status: finalStatus,
            reviewedAt: new Date(),
            reviewedBy,
            updatedAt: new Date(),
          })
          .where(eq(briefs.id, briefId))
          .returning();

        return {
          brief: updatedBrief,
          createdTaskIds,
          createdMemoryIds,
          createdDependencyCount,
          skippedDependencyCount,
        };
      });
    },
  };
}
