import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { briefs } from "./briefs.js";
import { projects } from "./projects.js";
import { issues } from "./issues.js";
import { memoryItems } from "./memory_items.js";

/** @deprecated Replaced by discussion_extracted_items. Keep for rollback safety. */
export const briefItems = pgTable(
  "brief_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    briefId: uuid("brief_id").notNull().references(() => briefs.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    suggestedAssigneeId: uuid("suggested_assignee_id"),
    suggestedPriority: text("suggested_priority"),
    suggestedDepartmentId: uuid("suggested_department_id").references(() => projects.id, { onDelete: "set null" }),
    suggestedProjectId: uuid("suggested_project_id").references(() => projects.id, { onDelete: "set null" }),
    suggestedLayer: text("suggested_layer"),
    layer: text("layer"),
    dedupAction: text("dedup_action"),
    selectedMemoryId: uuid("selected_memory_id").references(() => memoryItems.id, { onDelete: "set null" }),
    mergedContent: text("merged_content"),
    status: text("status").notNull().default("pending"),
    resultTaskId: uuid("result_task_id").references(() => issues.id, { onDelete: "set null" }),
    resultMemoryId: uuid("result_memory_id").references(() => memoryItems.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    briefIdx: index("brief_items_brief_idx").on(table.briefId),
    briefStatusIdx: index("brief_items_brief_status_idx").on(table.briefId, table.status),
  }),
);
