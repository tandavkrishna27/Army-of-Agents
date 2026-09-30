import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";

export const heartbeatRunWatchdogDecisions = pgTable(
  "heartbeat_run_watchdog_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    evaluationIssueId: uuid("evaluation_issue_id").references(() => issues.id, { onDelete: "set null" }),
    decision: text("decision").notNull(),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    reason: text("reason"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyRunCreatedIdx: index("hb_watchdog_company_run_created_idx").on(
      table.companyId, table.runId, table.createdAt,
    ),
    companyRunSnoozeIdx: index("hb_watchdog_company_run_snooze_idx").on(
      table.companyId, table.runId, table.snoozedUntil,
    ),
  }),
);
