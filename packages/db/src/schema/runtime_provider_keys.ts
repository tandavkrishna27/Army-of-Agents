import { sql } from "drizzle-orm";
import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";

export const runtimeProviderKeys = pgTable(
  "runtime_provider_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    displayName: text("display_name").notNull(),
    secretId: uuid("secret_id").notNull().references(() => companySecrets.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("active"),
    isDefault: boolean("is_default").notNull().default(false),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("runtime_provider_keys_company_idx").on(table.companyId),
    companyProviderIdx: index("runtime_provider_keys_company_provider_idx").on(
      table.companyId,
      table.provider,
    ),
    defaultPerCompanyProviderUq: uniqueIndex("runtime_provider_keys_default_uq")
      .on(table.companyId, table.provider)
      .where(sql`${table.isDefault} IS TRUE`),
  }),
);
