import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { authUsers } from "./auth.js";

export const sidebarPreferences = pgTable(
  "sidebar_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    departmentOrder: jsonb("department_order").$type<string[]>().notNull().default([]),
    projectOrder: jsonb("project_order").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("sidebar_preferences_company_idx").on(table.companyId),
    userIdx: index("sidebar_preferences_user_idx").on(table.userId),
    userCompanyUq: uniqueIndex("sidebar_preferences_user_company_uq").on(table.userId, table.companyId),
  }),
);
