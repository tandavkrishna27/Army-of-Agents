import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const marketplacePendingUpdates = pgTable(
  "marketplace_pending_updates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    catalogItemId: text("catalog_item_id").notNull(),
    catalogItemName: text("catalog_item_name").notNull(),
    itemType: text("item_type").notNull(),
    currentVersion: text("current_version").notNull(),
    latestVersion: text("latest_version").notNull(),
    status: text("status").notNull().default("pending"),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("mpu_company_status_idx").on(table.companyId, table.status),
    companyItemUq: uniqueIndex("mpu_company_item_uq").on(table.companyId, table.catalogItemId),
  }),
);
