import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export type MarketplaceReconciliationOperationState =
  | "claimed"
  | "running"
  | "success"
  | "partial"
  | "failed_before_mutation"
  | "outcome_unknown_after_mutation";

/**
 * Instance-scoped operation ledger for fleet marketplace reconciliation.
 *
 * Activity rows remain company-readable audit detail. This table owns the
 * globally unique operation ID and therefore also covers an empty fleet or a
 * failure before any company-scoped audit row can be written.
 */
export const marketplaceReconciliationOperations = pgTable(
  "marketplace_reconciliation_operations",
  {
    operationId: uuid("operation_id").primaryKey(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    state: text("state")
      .$type<MarketplaceReconciliationOperationState>()
      .notNull()
      .default("claimed"),
    deploymentSha: text("deployment_sha").notNull(),
    targetCount: integer("target_count").notNull().default(0),
    targetCompanyIds: uuid("target_company_ids")
      .array()
      .notNull()
      .default(sql`ARRAY[]::uuid[]`),
    catalog: jsonb("catalog").$type<Record<string, unknown> | null>(),
    activeSlot: integer("active_slot").notNull().default(1),
    leaseOwnerId: uuid("lease_owner_id"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    stateUpdatedIdx: index(
      "marketplace_reconciliation_operations_state_updated_idx",
    ).on(table.state, table.updatedAt),
    oneActiveOperationIdx: uniqueIndex(
      "marketplace_reconciliation_operations_one_active_idx",
    )
      .on(table.activeSlot)
      .where(sql`${table.state} in ('claimed', 'running')`),
    stateCheck: check(
      "marketplace_reconciliation_operations_state_check",
      sql`${table.state} in (
        'claimed',
        'running',
        'success',
        'partial',
        'failed_before_mutation',
        'outcome_unknown_after_mutation'
      )`,
    ),
    activeSlotCheck: check(
      "marketplace_reconciliation_operations_active_slot_check",
      sql`${table.activeSlot} = 1`,
    ),
    leaseCheck: check(
      "marketplace_reconciliation_operations_lease_check",
      sql`(
        (${table.state} in ('claimed', 'running')
          and ${table.leaseOwnerId} is not null
          and ${table.leaseExpiresAt} is not null)
        or
        (${table.state} not in ('claimed', 'running')
          and ${table.leaseOwnerId} is null
          and ${table.leaseExpiresAt} is null)
      )`,
    ),
  }),
);
