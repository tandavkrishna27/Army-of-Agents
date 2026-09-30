import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const internalAgentToolTrustRules = pgTable(
  "internal_agent_tool_trust_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    toolName: text("tool_name").notNull(),
    paramsHash: text("params_hash").notNull(),
    paramsHashVersion: text("params_hash_version").notNull().default("v1"),
    scope: text("scope").notNull().default("exact_params"),
    enabled: boolean("enabled").notNull().default(true),
    createdByUserId: text("created_by_user_id").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    exactParamsUq: uniqueIndex("ia_tool_trust_rules_exact_params_uq").on(
      table.companyId,
      table.userId,
      table.toolName,
      table.paramsHash,
      table.paramsHashVersion,
      table.scope,
    ),
    companyUserEnabledIdx: index("ia_tool_trust_rules_company_user_enabled_idx").on(
      table.companyId,
      table.userId,
      table.enabled,
    ),
    companyToolIdx: index("ia_tool_trust_rules_company_tool_idx").on(
      table.companyId,
      table.toolName,
    ),
  }),
);
