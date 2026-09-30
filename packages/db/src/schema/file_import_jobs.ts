import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

export const fileImportJobs = pgTable(
  "file_import_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    fileSize: integer("file_size").notNull(),
    storageKey: text("storage_key").notNull(),
    processorType: text("processor_type"),
    status: text("status").notNull().default("pending"),
    itemCount: integer("item_count").notNull().default(0),
    errorMessage: text("error_message"),
    parserWarnings: jsonb("parser_warnings").$type<string[]>(),
    retryCount: integer("retry_count").notNull().default(0),
    retryAfter: timestamp("retry_after", { withTimezone: true }),
    departmentId: uuid("department_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    defaultLayer: text("default_layer").notNull().default("domain"),
    defaultCategory: text("default_category").notNull().default("reference"),
    createdBy: text("created_by").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyIdx: index("file_import_jobs_company_idx").on(table.companyId),
    statusIdx: index("file_import_jobs_status_idx").on(table.status),
    pendingIdx: index("file_import_jobs_pending_idx").on(
      table.status,
      table.retryAfter,
      table.createdAt,
    ),
  }),
);
