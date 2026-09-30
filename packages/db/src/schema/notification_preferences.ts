import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { NotificationPreferenceRule } from "@armyofagents/shared";
import { authUsers } from "./auth.js";
import { companies } from "./companies.js";

export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    rules: jsonb("rules").$type<NotificationPreferenceRule[]>().notNull(),
    quietHours: jsonb("quiet_hours")
      .$type<{ enabled: boolean; start: string; end: string; timezone: string }>()
      .notNull(),
    digest: jsonb("digest").$type<{ enabled: boolean; cadence: "daily" }>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("notification_preferences_company_idx").on(table.companyId),
    userIdx: index("notification_preferences_user_idx").on(table.userId),
    userCompanyUq: uniqueIndex("notification_preferences_user_company_uq").on(
      table.userId,
      table.companyId,
    ),
  }),
);
