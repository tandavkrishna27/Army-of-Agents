import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { mcpApiKeys } from "./mcp_api_keys.js";

export const mcpClientConnections = pgTable(
  "mcp_client_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    apiKeyId: uuid("api_key_id").references(() => mcpApiKeys.id, { onDelete: "set null" }),
    userId: text("user_id").notNull(),
    clientName: text("client_name"),
    clientVersion: text("client_version"),
    userAgent: text("user_agent"),
    transport: text("transport").notNull().default("http"),
    remoteAddress: text("remote_address"),
    lastMethod: text("last_method"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyLastSeenIdx: index("mcp_client_connections_company_last_seen_idx").on(table.companyId, table.lastSeenAt),
    apiKeyLastSeenIdx: index("mcp_client_connections_api_key_last_seen_idx").on(table.apiKeyId, table.lastSeenAt),
  }),
);
