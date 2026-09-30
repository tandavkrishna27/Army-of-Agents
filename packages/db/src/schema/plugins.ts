import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import type { PluginCategory, PluginStatus, PluginStatusReasonCode, PluginTrustTier, PaperclipPluginManifestV1 } from "@armyofagents/shared";

/**
 * `plugins` table — stores one row per installed plugin.
 *
 * Plugins are scoped per company. The unique constraint is on
 * `(company_id, plugin_key)`. The `companyId` column is NOT NULL and
 * references the `companies` table. The full manifest is persisted as JSONB
 * in `manifest_json` so the host can reconstruct capability and UI slot
 * information without loading the plugin package.
 *
 * @see PLUGIN_SPEC.md §21.3
 */
export const plugins = pgTable(
  "plugins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    catalogItemId: text("catalog_item_id"),
    pluginKey: text("plugin_key").notNull(),
    packageName: text("package_name").notNull(),
    version: text("version").notNull(),
    apiVersion: integer("api_version").notNull().default(1),
    categories: jsonb("categories").$type<PluginCategory[]>().notNull().default([]),
    manifestJson: jsonb("manifest_json").$type<PaperclipPluginManifestV1>().notNull(),
    status: text("status").$type<PluginStatus>().notNull().default("installed"),
    installOrder: integer("install_order"),
    /** Resolved package path for local-path installs; used to find worker entrypoint. */
    packagePath: text("package_path"),
    lastError: text("last_error"),
    statusReasonCode: text("status_reason_code").$type<PluginStatusReasonCode>(),
    trustTier: text("trust_tier").$type<PluginTrustTier>().notNull().default("untrusted"),
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyPluginKeyIdx: uniqueIndex("plugins_company_plugin_key_idx").on(
      table.companyId,
      table.pluginKey,
    ),
    statusIdx: index("plugins_status_idx").on(table.status),
  }),
);
