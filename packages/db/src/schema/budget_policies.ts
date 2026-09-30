import { pgTable, uuid, text, integer, boolean, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const budgetPolicies = pgTable(
  "budget_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    scopeType: text("scope_type").notNull(), // "company" | "agent"
    scopeId: uuid("scope_id").notNull(),     // companyId or agentId
    metric: text("metric").notNull().default("cost_cents"),
    windowKind: text("window_kind").notNull().default("calendar_month_utc"),
    amountCents: integer("amount_cents").notNull(),
    warnPercent: integer("warn_percent").notNull().default(80),
    hardStopEnabled: boolean("hard_stop_enabled").notNull().default(true),
    notifyEnabled: boolean("notify_enabled").notNull().default(true),
    isActive: boolean("is_active").notNull().default(true),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueScope: uniqueIndex("budget_policies_scope_unique_idx").on(
      table.companyId, table.scopeType, table.scopeId, table.metric, table.windowKind,
    ),
    companyActiveIdx: index("budget_policies_company_active_idx").on(table.companyId, table.isActive),
  }),
);
