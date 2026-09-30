import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
import { goals } from "./goals.js";

/**
 * @deprecated Debriefs are replaced by Discussions (discussions table + discussion_entries table).
 * This table is kept for backward compatibility and rollback safety.
 * Do NOT drop — keep for ≥1 month after migration, then archive with `_deprecated_` prefix.
 * Kept for rollback safety; new code uses Discussions.
 */
export const debriefs = pgTable(
  "debriefs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    title: text("title"),
    inputType: text("input_type").notNull(),
    rawContent: text("raw_content").notNull(),
    artifactUrl: text("artifact_url"),
    departmentId: uuid("department_id").references(() => projects.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    goalId: uuid("goal_id").references(() => goals.id, { onDelete: "set null" }),
    sourceInfo: jsonb("source_info").$type<Record<string, unknown>>(),
    status: text("status").notNull().default("processing"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("debriefs_company_idx").on(table.companyId),
    companyStatusIdx: index("debriefs_company_status_idx").on(table.companyId, table.status),
  }),
);
