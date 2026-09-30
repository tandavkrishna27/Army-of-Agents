import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { approvals } from "@armyofagents/db";
import { buildApprovalHubEmit, emitHubItem } from "./hub-source-producers.js";

const OPEN_APPROVAL_STATUSES = ["pending", "revision_requested"] as const;

export async function emitOpenApprovalHubItems(db: Db, companyId: string, limit = 50) {
  const cappedLimit = Math.min(Math.max(limit, 1), 50);
  const rows = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.companyId, companyId), inArray(approvals.status, [...OPEN_APPROVAL_STATUSES])))
    .limit(cappedLimit);

  for (const approval of rows) {
    await emitHubItem(db, buildApprovalHubEmit(approval));
  }

  return { emitted: rows.length };
}
