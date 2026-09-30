import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";

export const instanceSettings = pgTable(
  "instance_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    singletonKey: text("singleton_key").notNull().default("default"),
    general: jsonb("general").$type<Record<string, unknown>>().notNull().default({}),
    experimental: jsonb("experimental").$type<Record<string, unknown>>().notNull().default({}),
    /**
     * REL-004 Lane C — the provider/template kill-switch policy document, read on the worker
     * poll path by `aoa_app` (grant: migration 0261).
     *
     * DELIBERATELY nullable with NO default, and deliberately NOT a key inside `general`.
     *
     * SQL NULL is "no policy has ever been set", the permitted steady state of every fresh
     * install. A `DEFAULT '{}'::jsonb` would be a document that EXISTS and cannot be
     * understood, which `evaluateKillSwitches` refuses — the default alone would drain every
     * fleet on every install.
     *
     * It is not stored in `general` because `instanceSettingsService.updateGeneral` rewrites
     * that bag from a fixed field list plus a `migrationSnapshots`-only carve-out, so an
     * unknown key there is erased by the next Settings PATCH.
     */
    killSwitches: jsonb("kill_switches").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    singletonKeyIdx: uniqueIndex("instance_settings_singleton_key_idx").on(table.singletonKey),
  }),
);
