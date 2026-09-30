import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { projects } from "./projects.js";

export const budgetCapacityReservations = pgTable(
  "budget_capacity_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    operationKind: text("operation_kind").notNull(),
    operationId: text("operation_id").notNull(),
    agentId: uuid("agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    maximumCostCents: integer("maximum_cost_cents").notNull(),
    settledCostCents: integer("settled_cost_cents").notNull().default(0),
    state: text("state").notNull().default("held"),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    stopRequestedAt: timestamp("stop_requested_at", { withTimezone: true }),
    stopReason: text("stop_reason"),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    operationUq: uniqueIndex("budget_capacity_reservations_operation_uq").on(
      table.companyId,
      table.operationKind,
      table.operationId
    ),
    companyStateWindowIdx: index(
      "budget_capacity_reservations_company_state_window_idx"
    ).on(table.companyId, table.state, table.windowStart, table.windowEnd),
    amountCheck: check(
      "budget_capacity_reservations_amount_check",
      sql`${table.maximumCostCents} > 0 AND ${table.settledCostCents} >= 0`
    ),
    stateCheck: check(
      "budget_capacity_reservations_state_check",
      sql`${table.state} IN ('held','unknown','settled','released')`
    ),
  })
);

export const budgetCapacitySettlements = pgTable(
  "budget_capacity_settlements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    reservationId: uuid("reservation_id")
      .notNull()
      .references(() => budgetCapacityReservations.id, { onDelete: "cascade" }),
    chargeId: text("charge_id").notNull(),
    costCents: integer("cost_cents").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    chargeUq: uniqueIndex("budget_capacity_settlements_charge_uq").on(
      table.companyId,
      table.chargeId
    ),
    reservationIdx: index("budget_capacity_settlements_reservation_idx").on(
      table.reservationId
    ),
    costCheck: check(
      "budget_capacity_settlements_cost_check",
      sql`${table.costCents} >= 0`
    ),
  })
);
