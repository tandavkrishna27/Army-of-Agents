import { isNotNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { goals, goalParents } from "@armyofagents/db";

type Db = NodePgDatabase<Record<string, never>>;

/**
 * Backfill the goal_parents join table from the vestigial goals.parentId column.
 *
 * The goals model moved from a single parentId to a multi-parent DAG
 * (Decision #20 superseded 2026-05-25). New parent links are written directly
 * to goal_parents; this pass migrates any pre-existing single-parent links.
 *
 * Idempotent — ON CONFLICT DO NOTHING on the composite PK, so it is safe to run
 * on every boot (mirrors the command-staff startup backfill in index.ts).
 */
export async function backfillGoalParents(
  db: Db,
): Promise<{ inserted: number }> {
  const rows = await db
    .select({ goalId: goals.id, parentId: goals.parentId })
    .from(goals)
    .where(isNotNull(goals.parentId));

  const values = rows
    .filter(
      (r): r is { goalId: string; parentId: string } => r.parentId !== null,
    )
    .map((r) => ({ goalId: r.goalId, parentId: r.parentId }));

  if (values.length === 0) return { inserted: 0 };

  await db.insert(goalParents).values(values).onConflictDoNothing();
  return { inserted: values.length };
}
