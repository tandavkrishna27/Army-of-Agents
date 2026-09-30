import { and, eq, inArray, lt } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { issues } from "@armyofagents/db";
import { buildStaleIssueHubEmit, emitHubItem } from "./hub-source-producers.js";

const STALE_WORK_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const STALE_WORK_STATUSES = ["todo", "in_progress"] as const;

export async function emitStaleWorkHubItems(db: Db, companyId: string, limit: number | null = 50) {
  const cutoff = new Date(Date.now() - STALE_WORK_THRESHOLD_MS);
  const query = db
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        inArray(issues.status, [...STALE_WORK_STATUSES]),
        lt(issues.updatedAt, cutoff),
      ),
    );
  const rows = limit === null ? await query : await query.limit(Math.min(Math.max(limit, 1), 50));

  for (const issue of rows) {
    await emitHubItem(db, buildStaleIssueHubEmit(issue));
  }

  return { emitted: rows.length };
}
