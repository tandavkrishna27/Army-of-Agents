import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { plugins } from "./plugins.js";

/**
 * `plugin_config` table — stores operator-provided instance configuration
 * for each plugin (one row per company+plugin pair, enforced by a unique index
 * on `(company_id, plugin_id)`).
 *
 * Plugins are company-scoped. The `companyId` column is NOT NULL and references
 * the `companies` table. The `config_json` column holds the values that the
 * operator enters in the plugin settings UI. These values are validated at
 * runtime against the plugin's `instanceConfigSchema` from the manifest.
 *
 * @see PLUGIN_SPEC.md §21.3
 */
export const pluginConfig = pgTable(
  "plugin_config",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    configJson: jsonb("config_json").$type<Record<string, unknown>>().notNull().default({}),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Replaces old unique-on-pluginId-alone index.
    companyPluginIdx: uniqueIndex("plugin_config_company_plugin_idx").on(
      table.companyId,
      table.pluginId,
    ),
    companyIdx: index("plugin_config_company_idx").on(table.companyId),
  }),
);
