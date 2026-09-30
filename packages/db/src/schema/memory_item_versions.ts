import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { memoryItems } from "./memory_items.js";

export const memoryItemVersions = pgTable(
  "memory_item_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memoryItemId: uuid("memory_item_id").notNull().references(() => memoryItems.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    content: text("content").notNull(),
    status: text("status").notNull().default("draft"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    memoryItemIdx: index("memory_item_versions_item_idx").on(table.memoryItemId),
    memoryItemStatusIdx: index("memory_item_versions_item_status_idx").on(table.memoryItemId, table.status),
    memoryItemVersionUq: uniqueIndex("memory_item_versions_item_version_uq").on(table.memoryItemId, table.versionNumber),
  }),
);
