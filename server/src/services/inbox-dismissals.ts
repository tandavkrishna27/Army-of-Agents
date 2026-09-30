import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { inboxDismissals } from "@armyofagents/db";
import type { InboxDismissal } from "@armyofagents/shared";

function normalizeRow(row: {
  id: string;
  userId: string;
  companyId: string;
  itemKey: string;
  dismissedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}): InboxDismissal {
  return {
    id: row.id,
    userId: row.userId,
    companyId: row.companyId,
    itemKey: row.itemKey,
    dismissedAt: row.dismissedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function inboxDismissalService(db: Db) {
  return {
    async list(userId: string, companyId: string): Promise<InboxDismissal[]> {
      const rows = await db
        .select()
        .from(inboxDismissals)
        .where(
          and(
            eq(inboxDismissals.userId, userId),
            eq(inboxDismissals.companyId, companyId),
          ),
        )
        .orderBy(desc(inboxDismissals.updatedAt));
      return rows.map(normalizeRow);
    },

    async dismiss(
      userId: string,
      companyId: string,
      itemKey: string,
    ): Promise<InboxDismissal> {
      const now = new Date();
      const [row] = await db
        .insert(inboxDismissals)
        .values({
          userId,
          companyId,
          itemKey,
          dismissedAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            inboxDismissals.userId,
            inboxDismissals.companyId,
            inboxDismissals.itemKey,
          ],
          set: {
            dismissedAt: now,
            updatedAt: now,
          },
        })
        .returning();
      return normalizeRow(row);
    },

    async undismiss(
      userId: string,
      companyId: string,
      itemKey: string,
    ): Promise<void> {
      await db
        .delete(inboxDismissals)
        .where(
          and(
            eq(inboxDismissals.userId, userId),
            eq(inboxDismissals.companyId, companyId),
            eq(inboxDismissals.itemKey, itemKey),
          ),
        );
    },
  };
}
