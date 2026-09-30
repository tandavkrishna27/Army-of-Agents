export interface ScribeItem {
  id: string;
  type: string;
  title: string;
  createdAt: string;
}

/** Task-type items → ordered Plan steps (creation order), linked to the item. */
export function buildPlanStepsFromItems(
  items: ScribeItem[],
): Array<{ title: string; linkedItemId: string }> {
  return [...items]
    .filter((i) => i.type === "task")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((i) => ({ title: i.title, linkedItemId: i.id }));
}

/** Readiness gate: finalize the living scope only when actually leaving
 *  'discuss' (→'scope') and there is something to finalize. */
export function shouldFinalizeScope(input: {
  fromPhase: string;
  toPhase: string;
  itemCount: number;
}): boolean {
  return input.fromPhase === "discuss" && input.toPhase === "scope" && input.itemCount > 0;
}

import type { Db } from "@armyofagents/db";
import { discussions, discussionEntries, discussionExtractedItems } from "@armyofagents/db";
import { and, eq, inArray } from "drizzle-orm";
import { threadService } from "../../threads.js";
import type { Actor } from "../../threads.js";

export async function maintainLivingScope(
  db: Db,
  companyId: string,
  threadId: string,
  actor: Actor,
): Promise<void> {
  const thread = await db
    .select({ id: discussions.id, phase: discussions.phase })
    .from(discussions)
    .where(and(eq(discussions.id, threadId), eq(discussions.companyId, companyId)))
    .then((r: { id: string; phase: string }[]) => r[0] ?? null);
  if (!thread) return;

  const entries = await db
    .select({ id: discussionEntries.id })
    .from(discussionEntries)
    .where(eq(discussionEntries.discussionId, threadId))
    .then((r: { id: string }[]) => r);
  const entryIds = entries.map((e) => e.id);

  const items = entryIds.length
    ? await db
        .select({
          id: discussionExtractedItems.id,
          type: discussionExtractedItems.type,
          title: discussionExtractedItems.title,
          createdAt: discussionExtractedItems.createdAt,
        })
        .from(discussionExtractedItems)
        .where(inArray(discussionExtractedItems.discussionEntryId, entryIds))
        .then((rows: { id: string; type: string; title: string; createdAt: unknown }[]) =>
          rows.map((r) => ({ ...r, createdAt: String(r.createdAt) })),
        )
    : [];

  const tsvc = threadService(db);
  await tsvc.updatePlanSteps(companyId, threadId, buildPlanStepsFromItems(items), actor);
}
