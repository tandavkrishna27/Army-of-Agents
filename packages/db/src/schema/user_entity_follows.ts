import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";
import { companies } from "./companies.js";

export const userEntityFollows = pgTable(
  "user_entity_follows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    followedAt: timestamp("followed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userCompanyEntityUq: uniqueIndex("user_entity_follows_user_company_entity_uq").on(
      table.userId,
      table.companyId,
      table.entityType,
      table.entityId,
    ),
    companyEntityIdx: index("user_entity_follows_company_entity_idx").on(
      table.companyId,
      table.entityType,
      table.entityId,
    ),
    entityTypeValid: check(
      "user_entity_follows_entity_type_check",
      sql`entity_type IN ('task', 'project', 'goal')`,
    ),
  }),
);
