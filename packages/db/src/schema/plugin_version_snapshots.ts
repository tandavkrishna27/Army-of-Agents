import { pgTable, uuid, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { plugins } from "./plugins.js";

export const pluginVersionSnapshots = pgTable(
  "plugin_version_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    packageName: text("package_name").notNull(),
    manifestJson: jsonb("manifest_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pluginCreatedIdx: index("pvs_plugin_created_idx").on(table.pluginId, table.createdAt),
    companyIdx: index("pvs_company_idx").on(table.companyId),
  }),
);
