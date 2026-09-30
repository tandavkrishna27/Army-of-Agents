import { pgTable, uuid, text, integer, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { budgetPolicies } from "./budget_policies.js";
import { approvals } from "./approvals.js";

export const budgetIncidents = pgTable(
  "budget_incidents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    policyId: uuid("policy_id").notNull().references(() => budgetPolicies.id, { onDelete: "cascade" }),
    scopeType: text("scope_type").notNull(),
    scopeId: uuid("scope_id").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    thresholdType: text("threshold_type").notNull(), // "warning" | "hard_stop"
    amountLimitCents: integer("amount_limit_cents").notNull(),
    amountObservedCents: integer("amount_observed_cents").notNull(),
    status: text("status").notNull().default("open"), // "open" | "resolved" | "dismissed"
    approvalId: uuid("approval_id").references(() => approvals.id),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueOpen: uniqueIndex("budget_incidents_open_unique_idx")
      .on(table.policyId, table.windowStart, table.thresholdType)
      .where(sql`status <> 'dismissed'`),
    companyStatusIdx: index("budget_incidents_company_status_idx").on(table.companyId, table.status),
  }),
);
