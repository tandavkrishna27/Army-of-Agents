import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  debriefs,
  briefs,
  briefItems,
  discussions,
  discussionEntries,
  discussionExtractedItems,
} from "@armyofagents/db";

type Db = NodePgDatabase<Record<string, never>>;

/**
 * Maps debrief status to discussion entry extraction status.
 * - 'ready' → 'completed' (extraction finished successfully)
 * - 'processing' → 'completed' if items exist, 'failed' if not
 * - 'processing_failed' → 'failed'
 * - 'archived' → 'completed'
 */
export function mapExtractionStatus(
  debriefStatus: string,
  hasItems: boolean,
): string {
  switch (debriefStatus) {
    case "ready":
      return "completed";
    case "processing":
      return hasItems ? "completed" : "failed";
    case "processing_failed":
      return "failed";
    case "archived":
      return "completed";
    default:
      return "failed";
  }
}

/**
 * Infers discussion scope from debrief fields.
 * Priority: goalId > projectId > departmentId
 */
export function inferScope(debrief: {
  goalId: string | null;
  projectId: string | null;
  departmentId: string | null;
}): { scopeType: string | null; scopeId: string | null } {
  if (debrief.goalId) return { scopeType: "goal", scopeId: debrief.goalId };
  if (debrief.projectId)
    return { scopeType: "project", scopeId: debrief.projectId };
  if (debrief.departmentId)
    return { scopeType: "department", scopeId: debrief.departmentId };
  return { scopeType: null, scopeId: null };
}

/**
 * Migrates all debriefs (with their briefs and brief_items) into the
 * discussions model. Idempotent — skips debriefs already migrated by
 * checking sourceInfo.migratedFromDebriefId on existing entries.
 */
export async function migrateDebriefsToDiscussions(db: Db): Promise<{
  migrated: number;
  skipped: number;
  itemsMigrated: number;
}> {
  // 1. Pre-scan: find already-migrated debrief IDs
  const existingEntries = await db
    .select({ sourceInfo: discussionEntries.sourceInfo })
    .from(discussionEntries);

  const alreadyMigrated = new Set<string>();
  for (const entry of existingEntries) {
    const info = entry.sourceInfo as Record<string, unknown> | null;
    if (info?.migratedFromDebriefId) {
      alreadyMigrated.add(info.migratedFromDebriefId as string);
    }
  }

  // 2. Fetch all debriefs
  const allDebriefs = await db.select().from(debriefs);

  let migrated = 0;
  let skipped = 0;
  let itemsMigrated = 0;

  for (const debrief of allDebriefs) {
    // Idempotency check
    if (alreadyMigrated.has(debrief.id)) {
      skipped++;
      continue;
    }

    // 3. Fetch brief + items for this debrief
    const debriefBriefs = await db
      .select()
      .from(briefs)
      .where(eq(briefs.debriefId, debrief.id));

    const debriefBrief = debriefBriefs[0] ?? null;

    let items: (typeof briefItems.$inferSelect)[] = [];
    if (debriefBrief) {
      items = await db
        .select()
        .from(briefItems)
        .where(eq(briefItems.briefId, debriefBrief.id));
    }

    const hasItems = items.length > 0;
    const { scopeType, scopeId } = inferScope(debrief);

    await db.transaction(async (tx) => {
      // 4. Create discussion
      const [discussion] = await tx
        .insert(discussions)
        .values({
          companyId: debrief.companyId,
          title: debrief.title,
          status: debrief.status === "archived" ? "archived" : "active",
          scopeType,
          scopeId,
          tags: [],
          entryCount: 1,
          pendingItemCount: items.filter((i) => i.status === "pending").length,
          lastEntryAt: debrief.createdAt,
          createdBy: debrief.createdBy,
          createdAt: debrief.createdAt,
          updatedAt: debrief.createdAt,
        })
        .returning();

      // 5. Create discussion entry
      const [entry] = await tx
        .insert(discussionEntries)
        .values({
          discussionId: discussion.id,
          inputType: debrief.inputType,
          rawContent: debrief.rawContent,
          title: debrief.title,
          sourceInfo: {
            ...(debrief.sourceInfo as Record<string, unknown> | null),
            migratedFromDebriefId: debrief.id,
            ...(debrief.artifactUrl
              ? { artifactUrl: debrief.artifactUrl }
              : {}),
          },
          departmentId: debrief.departmentId,
          projectId: debrief.projectId,
          goalId: debrief.goalId,
          extractionStatus: mapExtractionStatus(debrief.status, hasItems),
          createdBy: debrief.createdBy,
          createdAt: debrief.createdAt,
        })
        .returning();

      // 6. Migrate brief items → extracted items
      if (items.length > 0) {
        await tx.insert(discussionExtractedItems).values(
          items.map((item) => ({
            discussionEntryId: entry.id,
            type: item.type,
            title: item.title,
            description: item.description,
            suggestedPriority: item.suggestedPriority,
            suggestedAssigneeId: item.suggestedAssigneeId,
            suggestedDepartmentId: item.suggestedDepartmentId,
            suggestedProjectId: item.suggestedProjectId,
            suggestedLayer: item.suggestedLayer,
            layer: item.layer,
            dedupAction: item.dedupAction,
            selectedMemoryId: item.selectedMemoryId,
            mergedContent: item.mergedContent,
            status: item.status,
            resultTaskId: item.resultTaskId,
            resultMemoryId: item.resultMemoryId,
            // New columns — NULL for migrated records
            suggestedGoalId: null,
            priority: null,
            conflictsWith: null,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
          })),
        );
      }
    });

    migrated++;
    itemsMigrated += items.length;
  }

  return { migrated, skipped, itemsMigrated };
}

/**
 * Verifies migration completeness by comparing source and target counts.
 */
export async function verifyMigration(db: Db): Promise<{
  debriefCount: number;
  discussionCount: number;
  briefItemCount: number;
  extractedItemCount: number;
  match: boolean;
}> {
  const [{ count: debriefCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(debriefs);

  // Count discussions that were created by migration (have sourceInfo with migratedFromDebriefId)
  const migratedEntries = await db
    .select({ sourceInfo: discussionEntries.sourceInfo })
    .from(discussionEntries);

  let discussionCount = 0;
  for (const entry of migratedEntries) {
    const info = entry.sourceInfo as Record<string, unknown> | null;
    if (info?.migratedFromDebriefId) {
      discussionCount++;
    }
  }

  const [{ count: briefItemCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(briefItems);

  const [{ count: extractedItemCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(discussionExtractedItems);

  return {
    debriefCount,
    discussionCount,
    briefItemCount,
    extractedItemCount,
    // Note: extractedItemCount may exceed briefItemCount if new discussions
    // have been created post-migration. This is a sanity check, not exact.
    match:
      debriefCount === discussionCount &&
      briefItemCount <= extractedItemCount,
  };
}
