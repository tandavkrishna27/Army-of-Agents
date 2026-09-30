import { and, isNull, isNotNull } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { issues } from "@armyofagents/db";

/**
 * One-time startup backfill: stamp `origin_kind = 'crew_thread'` onto every
 * thread-deliverable task that was created before this field was introduced.
 *
 * The crew board filters on `origin_kind = 'crew_thread'`. Tasks created by
 * the thread scope-proposal approval path have `source_discussion_id` set but
 * `origin_kind = NULL` when they pre-date this change. The inference
 * "source_discussion_id set ⇒ crew-created" holds because only the
 * thread-deliverable path sets `source_discussion_id` (Decision D10).
 *
 * Safe to call on every startup — only touches rows where origin_kind IS NULL.
 * Idempotent: a second run matches 0 rows and returns { updated: 0 }.
 */
export async function backfillCrewOriginKind(
  db: Db,
): Promise<{ updated: number }> {
  const result = await db
    .update(issues)
    .set({
      originKind: "crew_thread",
      updatedAt: new Date(),
    })
    .where(and(isNotNull(issues.sourceDiscussionId), isNull(issues.originKind)));

  const rowCount =
    (result as unknown as { rowCount?: number | null }).rowCount ?? 0;
  return { updated: rowCount };
}
