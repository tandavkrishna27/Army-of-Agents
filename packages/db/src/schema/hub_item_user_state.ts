import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { notifications } from "./notifications.js"; // physical table; hubItems alias

// Sparse per-principal state. A row exists ONLY when a principal diverges from
// the default (read/snooze/dismiss) — never pre-fanned-out per user×item.
// Seat-keyed by (principalType, principalId) per W6 — NOT auth_users.id — so the
// synthetic local-board principal works in local_trusted.
export const hubItemUserState = pgTable(
  "hub_item_user_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    hubItemId: uuid("hub_item_id").notNull().references(() => notifications.id, { onDelete: "cascade" }),
    principalType: text("principal_type").notNull().default("user"),
    principalId: text("principal_id").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    principalItemUq: uniqueIndex("hub_item_user_state_principal_item_uq").on(
      table.hubItemId, table.principalType, table.principalId,
    ),
    principalIdx: index("hub_item_user_state_principal_idx").on(
      table.companyId, table.principalType, table.principalId,
    ),
  }),
);
