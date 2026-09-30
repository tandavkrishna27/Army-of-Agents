import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, integer, index, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { companySecretProviderConfigs } from "./company_secret_provider_configs.js";

export const companySecrets = pgTable(
  "company_secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // Tenant (Organization) denormalization for the RLS canary (Phase 3, B5).
    // Nullable + backfilled from companies.organization_id in migration 0189.
    organizationId: uuid("organization_id"),
    name: text("name").notNull(),
    key: text("key"),
    status: text("status").notNull().default("active"),
    managedMode: text("managed_mode").notNull().default("aoa_managed"),
    provider: text("provider").notNull().default("local_encrypted"),
    providerConfigId: uuid("provider_config_id").references(() => companySecretProviderConfigs.id, { onDelete: "set null" }),
    providerMetadata: jsonb("provider_metadata").$type<Record<string, unknown>>(),
    externalRef: text("external_ref"),
    latestVersion: integer("latest_version").notNull().default(1),
    description: text("description"),
    lastResolvedAt: timestamp("last_resolved_at", { withTimezone: true }),
    lastRotatedAt: timestamp("last_rotated_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("company_secrets_company_idx").on(table.companyId),
    companyProviderIdx: index("company_secrets_company_provider_idx").on(table.companyId, table.provider),
    companyNameUq: uniqueIndex("company_secrets_company_name_uq")
      .on(table.companyId, table.name)
      .where(sql`${table.deletedAt} IS NULL`),
  }),
);
