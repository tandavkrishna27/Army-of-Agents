import { pgTable, uuid, text, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { executionTargets } from "./execution_targets.js";

export const environments = pgTable(
  "environments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    driver: text("driver").notNull().default("local"),
    status: text("status").notNull().default("active"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    envVars: jsonb("env_vars").$type<Record<string, unknown>>().notNull().default({}),
    connectionTarget: jsonb("connection_target").$type<Record<string, unknown>>(),
    target: jsonb("target").$type<Record<string, unknown>>(),
    executionTargetId: uuid("execution_target_id").references(() => executionTargets.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("environments_company_idx").on(table.companyId),
    companyStatusIdx: index("environments_company_status_idx").on(table.companyId, table.status),
    companyNameUq: uniqueIndex("environments_company_name_uq").on(table.companyId, table.name),
  }),
);
