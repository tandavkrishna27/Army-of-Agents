import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const mcpApiKeys = pgTable(
  "mcp_api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    keyHashIdx: index("mcp_api_keys_key_hash_idx").on(table.keyHash),
    companyUserIdx: index("mcp_api_keys_company_user_idx").on(table.companyId, table.userId),
  }),
);
