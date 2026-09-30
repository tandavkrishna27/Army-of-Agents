import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { debriefs } from "./debriefs.js";
import { projects } from "./projects.js";
import { goals } from "./goals.js";

/**
 * @deprecated Briefs are replaced by Discussion extracted items (discussion_extracted_items table).
 * This table is kept for backward compatibility and rollback safety.
 * Do NOT drop — keep for ≥1 month after migration, then archive with `_deprecated_` prefix.
 * Kept for rollback safety; new code uses Discussions.
 */
export const briefs = pgTable(
  "briefs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    debriefId: uuid("debrief_id").notNull().references(() => debriefs.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("draft"),
    departmentId: uuid("department_id").references(() => projects.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    goalId: uuid("goal_id").references(() => goals.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: text("reviewed_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("briefs_company_idx").on(table.companyId),
    debriefIdx: index("briefs_debrief_idx").on(table.debriefId),
    companyStatusIdx: index("briefs_company_status_idx").on(table.companyId, table.status),
  }),
);
