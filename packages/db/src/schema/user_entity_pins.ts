import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { authUsers } from "./auth.js";

export const userEntityPins = pgTable(
  "user_entity_pins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(), // "task" | "artifact" | "goal"
    entityId: uuid("entity_id").notNull(),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // The unique index leads with (userId, companyId, …), so it already serves
    // every read (list + cockpit resolution filter on userId+companyId). A separate
    // (userId, companyId) index would be pure write-amplification — omitted.
    uniq: uniqueIndex("user_entity_pins_user_company_entity_uq").on(
      table.userId, table.companyId, table.entityType, table.entityId,
    ),
  }),
);
