import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";
import { companies } from "./companies.js";
import { hubItems } from "./notifications.js";

export const notificationDigestItems = pgTable(
  "notification_digest_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    hubItemId: uuid("hub_item_id")
      .notNull()
      .references(() => hubItems.id, { onDelete: "cascade" }),
    semanticType: text("semantic_type").notNull(),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
    ackedAt: timestamp("acked_at", { withTimezone: true }),
  },
  (table) => ({
    companyUserIdx: index("notification_digest_items_company_user_idx").on(
      table.companyId,
      table.userId,
    ),
    pendingIdx: index("notification_digest_items_pending_idx").on(
      table.companyId,
      table.userId,
      table.ackedAt,
    ),
    uniquePendingItem: uniqueIndex("notification_digest_items_pending_item_uq")
      .on(table.companyId, table.userId, table.hubItemId)
      .where(sql`${table.ackedAt} is null`),
  }),
);
