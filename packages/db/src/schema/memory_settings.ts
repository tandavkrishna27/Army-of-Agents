import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

/**
 * Per-company (and per-department override) memory governance (enterprise memory
 * model, P1). `departmentId` null = the company default; a non-null row overrides
 * the default for that department. `autonomyLevel` is the AutonomyLevel text enum
 * (manual|supervised|trusted|policy), independent of
 * `internal_agent_config.crew_autonomy_level` (integer 0–2). P1 wires only the
 * autonomy + active_context-tier dials; the retention/legal-hold/run-miner/
 * screening/private-memory/working-ttl columns are the governance surface consumed
 * by P3/P4/P5. This table is the single owner of memory_settings (overview
 * cross-phase reconciliation contract §3).
 */
export const memorySettings = pgTable(
  "memory_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    // null = company default. Deleting a department deletes its override, so
    // effective resolution naturally falls back to the company default.
    departmentId: uuid("department_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    autonomyLevel: text("autonomy_level").notNull().default("supervised"),
    activeContextTier: text("active_context_tier").notNull().default("durable"),
    retentionDays: integer("retention_days").notNull().default(90),
    legalHold: boolean("legal_hold").notNull().default(false),
    runMinerEnabled: boolean("run_miner_enabled").notNull().default(true),
    runMinerBudgetCents: integer("run_miner_budget_cents"), // null = uncapped
    externalScreeningEnabled: boolean("external_screening_enabled")
      .notNull()
      .default(true),
    privateMemoryEnabled: boolean("private_memory_enabled").notNull().default(true),
    workingMemoryTtlDays: integer("working_memory_ttl_days"), // null = default; reserved for P4
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Spec'd composite unique (dept-override rows). Postgres treats NULLs as
    // distinct, so this alone does NOT stop duplicate company-default rows.
    companyDeptUq: uniqueIndex("memory_settings_company_dept_uq").on(
      table.companyId,
      table.departmentId,
    ),
    // Exactly one company-default row per company — the partial unique the
    // composite above cannot express (department_id IS NULL).
    companyDefaultUq: uniqueIndex("memory_settings_company_default_uq")
      .on(table.companyId)
      .where(sql`${table.departmentId} IS NULL`),
    companyIdx: index("memory_settings_company_idx").on(table.companyId),
  }),
);
