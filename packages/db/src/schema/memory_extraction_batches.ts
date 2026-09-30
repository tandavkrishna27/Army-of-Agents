import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Groups multiple extraction jobs from a single founder upload action.
 *
 * When a founder drops 12 files into Memory, one batch row is created and 12
 * memory_extractions rows reference it. This lets the UI:
 *   - Show batch progress (5 of 12 done)
 *   - Bulk approve at the end
 *   - Aggregate cost / runs across the batch
 *
 * Status:
 *   - queued     — created, waiting for worker
 *   - running    — at least one extraction is in flight
 *   - completed  — all extractions terminal (succeeded OR failed)
 *   - cancelled  — founder cancelled mid-batch (in-flight may still settle)
 */
export const memoryExtractionBatches = pgTable(
  "memory_extraction_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    /** Founder user id or agent id (text to match memory_items.createdBy convention). */
    createdBy: text("created_by").notNull(),
    totalFiles: integer("total_files").notNull().default(0),
    succeededCount: integer("succeeded_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    status: text("status").notNull().default("queued"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    companyCreatedIdx: index("memory_extraction_batches_company_created_idx").on(
      table.companyId,
      table.createdAt,
    ),
    companyStatusIdx: index("memory_extraction_batches_company_status_idx").on(
      table.companyId,
      table.status,
    ),
  }),
);
