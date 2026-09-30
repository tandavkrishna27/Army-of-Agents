import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
  check,
  unique,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./organizations.js";
import { jobAttempts } from "./job_attempts.js";
import { leases } from "./leases.js";

// JOB-006 — the durable, monotonically-sequenced control-command channel for a
// fenced run.
//
// A row here is one server-authored control command (cancel / drain / graceful_stop)
// bound to a SPECIFIC lease fence, plus the worker's later ACK for it. Commands are
// NEVER worker-creatable (E1 audience `control_channel`): the operator/reaper inserts
// the command under the authoritative job+attempt lock, and the worker only ACKs it
// through the already-fence-guarded `ackControlCommand`. The stored `command` jsonb is
// the strict, already-validated PRT-003 control command body (no secret keys, every
// field bounded); the ACK columns are filled only by the guarded ACK mutator.
//
// Uniqueness pins two invariants: at most ONE command per (organization, lease,
// command id) — so a re-issued command is a no-op — and a strictly monotonic
// per-lease sequence via unique (organization, lease, command seq). The worker's
// `decideControlReceiverV1` (E1) classifies replay/gap/conflict/stale against this
// contiguous 1..N sequence.
//
// Tenant isolation is DB-enforced (FORCE RLS + aoa_app policy in the custom
// migration). Every parent relationship is a COMPOSITE tenant FK so a command can
// never be stamped with a different tenant than its job/attempt/lease — a redundant
// single-column FK would be a cross-tenant existence oracle (E2-F013), so there is
// none. organization_id keeps its own tenant-key FK.
export const jobControlCommands = pgTable(
  "job_control_commands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    companyId: uuid("company_id").notNull(),
    jobId: uuid("job_id").notNull(),
    attemptId: uuid("attempt_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    leaseId: uuid("lease_id").notNull(),
    // The wire command identity + its per-lease monotonic sequence.
    commandId: uuid("command_id").notNull(),
    commandSeq: integer("command_seq").notNull(),
    commandKind: text("command_kind").notNull(),
    // The fence the command is bound to; a superseded fence makes the command stale.
    fenceToken: text("fence_token").notNull(),
    reason: text("reason"),
    graceful: boolean("graceful"),
    deadline: timestamp("deadline", { withTimezone: true }),
    command: jsonb("command").$type<Record<string, unknown>>().notNull(),
    // Filled ONLY by the guarded `ackControlCommand`: the worker's echoed ACK.
    ackStatus: text("ack_status"),
    ackObservedAt: timestamp("ack_observed_at", { withTimezone: true }),
    ackDetail: text("ack_detail"),
    ackedAt: timestamp("acked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // At most one command per (org, lease, command id) — a re-issued command is a no-op.
    orgLeaseCommandUq: unique("job_control_commands_org_lease_command_uq").on(
      table.organizationId,
      table.leaseId,
      table.commandId,
    ),
    // Strictly monotonic per-lease sequence: at most one row per (org, lease, seq).
    orgLeaseSeqUq: unique("job_control_commands_org_lease_seq_uq").on(
      table.organizationId,
      table.leaseId,
      table.commandSeq,
    ),
    leaseSeqIdx: index("job_control_commands_lease_seq_idx").on(
      table.organizationId,
      table.leaseId,
      table.commandSeq,
    ),
    commandKindValid: check(
      "job_control_commands_kind_check",
      sql`command_kind IN ('cancel', 'drain', 'graceful_stop', 'product_approval_result', 'runtime_decision_result')`,
    ),
    ackStatusValid: check(
      "job_control_commands_ack_status_check",
      sql`ack_status IS NULL OR ack_status IN ('accepted', 'completed', 'rejected', 'stale')`,
    ),
    commandSeqValid: check("job_control_commands_seq_check", sql`command_seq > 0`),
    attemptNumberValid: check(
      "job_control_commands_attempt_number_check",
      sql`attempt_number > 0`,
    ),
    // Composite tenant FK to the owning attempt — proves command↔attempt share a
    // tenant; ON DELETE cascade (commands die with their attempt).
    attemptFk: foreignKey({
      columns: [table.organizationId, table.companyId, table.jobId, table.attemptId],
      foreignColumns: [
        jobAttempts.organizationId,
        jobAttempts.companyId,
        jobAttempts.jobId,
        jobAttempts.id,
      ],
      name: "job_control_commands_attempt_fk",
    }).onDelete("cascade"),
    // Composite tenant FK to the lease/fence the command is bound to.
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
      name: "job_control_commands_lease_fk",
    }).onDelete("cascade"),
  }),
);

export type JobControlCommand = typeof jobControlCommands.$inferSelect;
export type NewJobControlCommand = typeof jobControlCommands.$inferInsert;
