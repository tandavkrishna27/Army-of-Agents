import { sql } from "drizzle-orm";
import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const companySecretProviderConfigs = pgTable(
  "company_secret_provider_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    displayName: text("display_name").notNull(),
    status: text("status").notNull().default("ready"),
    isDefault: boolean("is_default").notNull().default(false),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    healthStatus: text("health_status"),
    healthCheckedAt: timestamp("health_checked_at", { withTimezone: true }),
    healthMessage: text("health_message"),
    healthDetails: jsonb("health_details").$type<Record<string, unknown>>(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("company_secret_provider_configs_company_idx").on(table.companyId),
    companyProviderIdx: index("company_secret_provider_configs_company_provider_idx").on(
      table.companyId,
      table.provider,
    ),
    defaultPerCompanyProviderUq: uniqueIndex("company_secret_provider_configs_default_uq")
      .on(table.companyId, table.provider)
      .where(sql`${table.isDefault} IS TRUE`),
  }),
);
