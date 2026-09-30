import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";
import { companies } from "./companies.js";

/** Personal read-history for explicit Universe attention review. */
export const universeAttentionCheckpoints = pgTable(
  "universe_attention_checkpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull().default(0),
    lastAcknowledgedAt: timestamp("last_acknowledged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  table => ({
    ownerUq: uniqueIndex("universe_attention_checkpoints_company_user_uq").on(table.companyId, table.userId),
  }),
);
