import {
  pgTable,
  uuid,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const taskDependencies = pgTable(
  "task_dependencies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    dependentIssueId: uuid("dependent_issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    dependencyIssueId: uuid("dependency_issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    uniqueDep: uniqueIndex("task_dep_unique_idx").on(
      table.dependentIssueId,
      table.dependencyIssueId,
    ),
    dependentIdx: index("task_dep_dependent_idx").on(
      table.companyId,
      table.dependentIssueId,
    ),
    dependencyIdx: index("task_dep_dependency_idx").on(
      table.companyId,
      table.dependencyIssueId,
    ),
  }),
);
