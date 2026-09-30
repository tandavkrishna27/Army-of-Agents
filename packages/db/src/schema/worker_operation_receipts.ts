import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  check,
  unique,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./organizations.js";
import { leases } from "./leases.js";
import { workers } from "./workers.js";
import { executionTargets } from "./execution_targets.js";

/**
 * Durable semantic operation receipt. Transport proof IDs stay in the
 * short-lived replay register; this row stores only the bounded result required
 * to replay an acknowledged operation after response loss.
 */
export const workerOperationReceipts = pgTable(
  "worker_operation_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    companyId: uuid("company_id").notNull(),
    jobId: uuid("job_id").notNull(),
    attemptId: uuid("attempt_id").notNull(),
    leaseId: uuid("lease_id").notNull(),
    operation: text("operation").notNull(),
    workerId: uuid("worker_id").notNull(),
    targetId: uuid("target_id").notNull(),
    targetAuthorityKey: text("target_authority_key").notNull(),
    targetGeneration: integer("target_generation").notNull(),
    profileHash: text("profile_hash").notNull(),
    idempotencyKey: uuid("idempotency_key").notNull(),
    semanticDigest: text("semantic_digest").notNull(),
    outcome: jsonb("outcome").$type<Record<string, unknown>>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    scopeKeyUq: unique("worker_operation_receipts_scope_key_uq").on(
      table.organizationId,
      table.workerId,
      table.targetId,
      table.targetGeneration,
      table.profileHash,
      table.operation,
      table.idempotencyKey,
    ),
    expiryIdx: index("worker_operation_receipts_expiry_idx").on(
      table.organizationId,
      table.expiresAt,
      table.id,
    ),
    leaseIdx: index("worker_operation_receipts_lease_idx").on(
      table.organizationId,
      table.leaseId,
    ),
    operationValid: check(
      "worker_operation_receipts_operation_check",
      sql`operation IN ('lease_ack', 'lease_renew')`,
    ),
    digestValid: check(
      "worker_operation_receipts_digest_check",
      sql`semantic_digest ~ '^[0-9a-f]{64}$' AND profile_hash ~ '^[0-9a-f]{64}$'`,
    ),
    generationValid: check(
      "worker_operation_receipts_generation_check",
      sql`target_generation > 0`,
    ),
    retentionValid: check(
      "worker_operation_receipts_retention_check",
      sql`expires_at > created_at`,
    ),
    leaseFk: foreignKey({
      columns: [
        table.organizationId,
        table.companyId,
        table.jobId,
        table.attemptId,
        table.leaseId,
      ],
      foreignColumns: [
        leases.organizationId,
        leases.companyId,
        leases.jobId,
        leases.attemptId,
        leases.id,
      ],
      name: "worker_operation_receipts_lease_fk",
    }).onDelete("cascade"),
    workerFk: foreignKey({
      columns: [table.organizationId, table.workerId],
      foreignColumns: [workers.organizationId, workers.id],
      name: "worker_operation_receipts_worker_fk",
    }).onDelete("restrict"),
    targetFk: foreignKey({
      columns: [table.targetAuthorityKey, table.targetId],
      foreignColumns: [executionTargets.targetAuthorityKey, executionTargets.id],
      name: "worker_operation_receipts_target_fk",
    }).onDelete("restrict"),
  }),
);

export type WorkerOperationReceipt = typeof workerOperationReceipts.$inferSelect;
export type NewWorkerOperationReceipt = typeof workerOperationReceipts.$inferInsert;
