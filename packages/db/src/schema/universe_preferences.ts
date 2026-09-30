import { integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { UniversePreferenceOverrides } from "@armyofagents/shared";
import { authUsers } from "./auth.js";
import { companies } from "./companies.js";

export const universePreferences = pgTable(
  "universe_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    schemaVersion: integer("schema_version").notNull().default(1),
    revision: integer("revision").notNull().default(1),
    overrides: jsonb("overrides").$type<UniversePreferenceOverrides>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  table => ({
    ownerUq: uniqueIndex("universe_preferences_company_user_uq").on(table.companyId, table.userId),
  }),
);
