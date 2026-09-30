import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { environments } from "./environments.js";

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    role: text("role").notNull().default("general"),
    kind: text("kind").notNull().default("org"), // 'org' | 'platform' | 'aoa' — 'aoa' = Commander + sub-agents (trigger-driven)
    title: text("title"),
    icon: text("icon"),
    status: text("status").notNull().default("idle"),
    reportsTo: uuid("reports_to").references((): AnyPgColumn => agents.id, { onDelete: "set null" }),
    parentType: text("parent_type"),
    parentId: text("parent_id"),
    capabilities: text("capabilities"),
    adapterType: text("adapter_type").notNull().default("process"),
    adapterConfig: jsonb("adapter_config").$type<Record<string, unknown>>().notNull().default({}),
    runtimeConfig: jsonb("runtime_config").$type<Record<string, unknown>>().notNull().default({}),
    budgetMonthlyCents: integer("budget_monthly_cents").notNull().default(0),
    defaultEnvironmentId: uuid("default_environment_id").references(
      () => environments.id,
      { onDelete: "set null" },
    ),
    spentMonthlyCents: integer("spent_monthly_cents").notNull().default(0),
    permissions: jsonb("permissions").$type<Record<string, unknown>>().notNull().default({}),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    skillKeys: jsonb("skill_keys").$type<string[]>().notNull().default([]),
    templateOrigin: text("template_origin"),
    templateVersion: text("template_version"),
    /**
     * D22 — has anyone edited this agent's instruction bundle since AoA
     * materialized it from the catalog? Mirrors `company_skills.customized`.
     *
     * **Deliberately THREE-STATE, unlike the skills flag.**
     * - `false` — AoA wrote this bundle from a catalog template and no edit has
     *   gone through the API since. Safe to full-replace on a catalog bump.
     * - `true`  — a founder edit landed through one of the
     *   `/agents/:id/instructions*` routes. Never full-replace; notify instead.
     * - `null`  — UNKNOWN. The row predates this column, so no edit could have
     *   been observed. Treated exactly like `true` (fail closed): the harm this
     *   column exists to prevent is silently destroying edits we cannot see, and
     *   a row we have never observed is precisely that case.
     *
     * Nullable with NO default on purpose: a `false` default would assert
     * "untouched" about every pre-existing row, which is the one claim the data
     * cannot support. Insert paths that genuinely know the answer (marketplace
     * install) write `false` explicitly.
     */
    instructionsCustomized: boolean("instructions_customized"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("agents_company_status_idx").on(table.companyId, table.status),
    index("agents_company_reports_to_idx").on(table.companyId, table.reportsTo),
    index("agents_company_parent_idx").on(table.companyId, table.parentType, table.parentId),
    index("agents_template_origin_idx").on(table.companyId, table.templateOrigin),
    uniqueIndex("agents_aoa_name_per_company_idx")
      .on(table.companyId, table.name)
      .where(sql`${table.kind} = 'aoa'`),
  ],
);
