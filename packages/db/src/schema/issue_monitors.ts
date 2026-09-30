import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const issueMonitors = pgTable(
  "issue_monitors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    status: text("status").notNull().default("scheduled"),
    kind: text("kind").notNull().default("generic"),
    scheduledBy: text("scheduled_by").notNull().default("board"),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull(),
    lastTriggeredAt: timestamp("last_triggered_at", { withTimezone: true }),
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
    clearReason: text("clear_reason"),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts"),
    timeoutAt: timestamp("timeout_at", { withTimezone: true }),
    notes: text("notes"),
    externalRef: text("external_ref"),
    recoveryPolicy: jsonb("recovery_policy").$type<Record<string, unknown>>(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueStatusIdx: index("issue_monitors_company_issue_status_idx").on(
      table.companyId,
      table.issueId,
      table.status,
    ),
    companyDueIdx: index("issue_monitors_company_due_idx").on(table.companyId, table.status, table.nextCheckAt),
    companyAgentStatusIdx: index("issue_monitors_company_agent_status_idx").on(
      table.companyId,
      table.agentId,
      table.status,
    ),
    oneActiveMonitorPerKindUq: uniqueIndex("issue_monitors_one_active_per_kind_uq")
      .on(table.companyId, table.issueId, table.kind)
      .where(sql`status in ('scheduled', 'triggered')`),
  }),
);
