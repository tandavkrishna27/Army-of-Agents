import { pgTable, integer, text, jsonb, timestamp } from "drizzle-orm/pg-core";

/**
 * `marketplace_catalog_cache` — single-row cache table for the latest synced
 * marketplace catalog. Singleton pattern (only one row, id=1).
 *
 * Catalog itself is stored as JSONB. Sync metadata tracked separately.
 *
 * @see docs/superpowers/specs/2026-04-29-marketplace-v1-design.md §5.7
 */
export const marketplaceCatalogCache = pgTable("marketplace_catalog_cache", {
  id: integer("id").primaryKey().default(1), // always 1 (singleton)
  schemaVersion: text("schema_version").notNull(),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
  itemCount: integer("item_count").notNull(),
  catalogJson: jsonb("catalog_json").notNull(),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  lastSyncStatus: text("last_sync_status").$type<"success" | "failure">().notNull(),
  lastSyncError: text("last_sync_error"),
  source: text("source").$type<"cdn" | "bundled">().notNull(),
});
