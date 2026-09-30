import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issueContextBundles } from "./issue_context_bundles.js";

export const issueContextBundleItems = pgTable(
  "issue_context_bundle_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    bundleId: uuid("bundle_id").notNull().references(() => issueContextBundles.id, { onDelete: "cascade" }),
    itemType: text("item_type").notNull(),
    sourceId: uuid("source_id"),
    label: text("label"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyBundleIdx: index("issue_context_bundle_items_company_bundle_idx").on(table.companyId, table.bundleId),
    companyTypeSourceIdx: index("issue_context_bundle_items_company_type_source_idx").on(
      table.companyId,
      table.itemType,
      table.sourceId,
    ),
  }),
);
