import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  check,
  unique,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./organizations.js";
import { jobAttempts } from "./job_attempts.js";

// JOB-005 — the projection idempotency state machine.
//
// A row records that ONE accepted state-changing event drove ONE job/attempt
// projection (the first `attempt_started` owns attempt leased->running + job
// queued->running; a `terminal` owns the attempt's terminal completion). The row
// is the idempotency ledger so the projection is applied AT MOST once, replays
// safely, and a same-identity/different-digest re-drive is a hard conflict:
//
//   * unique (organization_id, company_id, projection_kind, source_identity) —
//     the projection is keyed by its driving event (source_identity = event id).
//   * source_digest pins the driving event's digest; a later row for the same
//     identity with a DIFFERENT digest is a conflict (the ingest also rejects it
//     upstream as hash_mismatch, so this is defense in depth).
//   * status pending|applied — `applied` (with applied_at) replays as a no-op;
//     `pending` (applied_at NULL) is crash-recoverable for a later multi-step
//     projection (JOB-011). JOB-005 applies the transition in the SAME tenant
//     transaction, so it writes rows directly as `applied`.
//
// Tenant isolation is DB-enforced (FORCE RLS + aoa_app policy). The parent
// relationship is a COMPOSITE tenant FK to the attempt — never a redundant
// single-column FK (cross-tenant existence oracle, E2-F013).
export const jobProjectionReceipts = pgTable(
  "job_projection_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    companyId: uuid("company_id").notNull(),
    projectionKind: text("projection_kind").notNull(),
    sourceIdentity: text("source_identity").notNull(),
    sourceDigest: text("source_digest").notNull(),
    jobId: uuid("job_id").notNull(),
    attemptId: uuid("attempt_id").notNull(),
    sourceFence: text("source_fence").notNull(),
    status: text("status").notNull(),
    targetAggregateId: uuid("target_aggregate_id").notNull(),
    // JOB-011 — disambiguates which aggregate table `target_aggregate_id` points at
    // (`approvals` / `agent_runtime_decisions` / `internal_agent_runtime_approvals`).
    // Nullable: JOB-005 attempt_started/attempt_terminal rows leave it NULL (the
    // target is always the attempt they already name via the composite FK).
    aggregateKind: text("aggregate_kind"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
  },
  (table) => ({
    identityUq: unique("job_projection_receipts_identity_uq").on(
      table.organizationId,
      table.companyId,
      table.projectionKind,
      table.sourceIdentity,
    ),
    attemptIdx: index("job_projection_receipts_attempt_idx").on(
      table.organizationId,
      table.companyId,
      table.jobId,
      table.attemptId,
    ),
    projectionKindValid: check(
      "job_projection_receipts_projection_kind_check",
      sql`projection_kind IN ('attempt_started', 'attempt_terminal', 'product_approval', 'runtime_decision', 'completion_policy', 'authoritative_cost', 'activity_audit', 'output_projection', 'task_terminal', 'service_instance_status')`,
    ),
    statusValid: check(
      "job_projection_receipts_status_check",
      sql`status IN ('pending', 'applied')`,
    ),
    // applied ⇒ applied_at present; pending ⇒ applied_at absent.
    appliedAtomic: check(
      "job_projection_receipts_applied_check",
      sql`(status = 'applied' AND applied_at IS NOT NULL) OR (status = 'pending' AND applied_at IS NULL)`,
    ),
    digestValid: check(
      "job_projection_receipts_digest_check",
      sql`source_digest ~ '^[0-9a-f]{64}$'`,
    ),
    attemptFk: foreignKey({
      columns: [table.organizationId, table.companyId, table.jobId, table.attemptId],
      foreignColumns: [
        jobAttempts.organizationId,
        jobAttempts.companyId,
        jobAttempts.jobId,
        jobAttempts.id,
      ],
      name: "job_projection_receipts_attempt_fk",
    }).onDelete("cascade"),
  }),
);

export type JobProjectionReceipt = typeof jobProjectionReceipts.$inferSelect;
export type NewJobProjectionReceipt = typeof jobProjectionReceipts.$inferInsert;
