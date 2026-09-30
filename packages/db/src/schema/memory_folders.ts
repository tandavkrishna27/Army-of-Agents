import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

/**
 * Phase 6: user-created and seeded folders within the memory tree.
 *
 * - Seeded folders (e.g. "Engineering/Decisions") get a row when created
 *   via memoryFolderSeedsService on department creation. seedKey is set
 *   so we know not to delete them by accident.
 * - User-created folders also get a row. seedKey is null.
 * - Virtual folders (Pending Review, Active Goals, Pinned, Working) do NOT
 *   live in this table — they're computed at query time.
 *
 * `path` is normalized POSIX with `/` separators. The first segment is
 * either "Company" (for company-root folders) or a department slug.
 */
export const memoryFolders = pgTable(
  "memory_folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    departmentId: uuid("department_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    path: text("path").notNull(),
    displayName: text("display_name").notNull(),
    icon: text("icon"),
    sortOrder: integer("sort_order").notNull().default(0),
    seedKey: text("seed_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyIdx: index("memory_folders_company_idx").on(table.companyId),
    deptPathIdx: index("memory_folders_dept_path_idx").on(
      table.companyId,
      table.departmentId,
      table.path,
    ),
    uniquePathPerCompany: uniqueIndex("memory_folders_unique_path_per_company").on(
      table.companyId,
      table.path,
    ),
  }),
);
