import {
  type AnyPgColumn,
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
import { fileImportJobs } from "./file_import_jobs.js";

/**
 * Phase 6: raw uploaded files (PDF, DOCX, image, video, PPTX, TXT) as
 * first-class tree nodes. Sibling concept to `memory_items` — both share
 * folderPath. Asset bytes live in StorageService at `storageKey`.
 *
 * Distinct from `memory_items` because the content here is a blob, not text.
 * Many assets generate multiple `memory_items` via the file-import pipeline;
 * those items reference the asset via `memory_items.sourceAssetId` (a column
 * we add in a follow-up phase) or via `importJobId` for assets that came in
 * through the legacy file-import flow.
 */
export const memoryAssets = pgTable(
  "memory_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    departmentId: uuid("department_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    folderPath: text("folder_path").notNull().default(""),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    fileSize: integer("file_size").notNull(),
    storageKey: text("storage_key").notNull(),
    importJobId: uuid("import_job_id").references((): AnyPgColumn => fileImportJobs.id, {
      onDelete: "set null",
    }),
    extractedItemCount: integer("extracted_item_count").notNull().default(0),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    uploadedByUserId: uuid("uploaded_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyIdx: index("memory_assets_company_idx").on(table.companyId),
    companyFolderIdx: index("memory_assets_company_folder_idx").on(
      table.companyId,
      table.departmentId,
      table.folderPath,
    ),
    importJobIdx: index("memory_assets_import_job_idx").on(table.importJobId),
  }),
);
