import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";
import { companies } from "./companies.js";

export const hubCounterSnapshots = pgTable(
  "hub_counter_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    openCount: integer("open_count").notNull().default(0),
    unreadCount: integer("unread_count").notNull().default(0),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    computedAt: timestamp("computed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUserUq: uniqueIndex("hub_counter_snapshots_company_user_uq").on(
      table.companyId,
      table.userId,
    ),
    invalidatedIdx: index("hub_counter_snapshots_invalidated_idx").on(
      table.companyId,
      table.invalidatedAt,
    ),
  }),
);
