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
import { jobAttempts } from "./job_attempts.js";
import { leases } from "./leases.js";

// JOB-005 — the immutable, append-only ledger of ACCEPTED worker events.
//
// A row here is the durable record that ONE sequenced worker event was accepted
// under the active lease fence. Rows are NEVER updated or deleted by the runtime
// (the ingest service inserts with ON CONFLICT DO NOTHING so a replayed batch is a
// no-op). The stored `event` jsonb is the strict, already-validated PRT-004 event
// object (the worker-protocol schema forbids secret keys and bounds every field),
// and `event_digest` is the SHA-256 of its RFC 8785 canonical bytes with
// `eventDigest` omitted (recomputed by the server, never trusted from the wire).
//
// Tenant isolation is DB-enforced (FORCE RLS + aoa_app policy in the custom
// migration). Every parent relationship is a COMPOSITE tenant FK so an event can
// never be stamped with a different tenant than its job/attempt/lease — a redundant
// single-column FK would be a cross-tenant existence oracle (E2-F013), so there is
// none. organization_id keeps its own tenant-key FK.
export const jobEvents = pgTable(
  "job_events",
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
    // The wire event identity + its recomputed digest. `event_id` is globally
    // unique per tenant (idempotent re-delivery); `sequence` is the per-attempt
    // contiguous ordering (the cumulative ACK's acceptedThroughSeq is the MAX
    // stored sequence for the attempt because the ingest never leaves a gap).
    eventId: uuid("event_id").notNull(),
    sequence: integer("sequence").notNull(),
    eventType: text("event_type").notNull(),
    fenceToken: text("fence_token").notNull(),
    eventDigest: text("event_digest").notNull(),
    event: jsonb("event").$type<Record<string, unknown>>().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Idempotent re-delivery: the SAME event id can only ever be accepted once.
    orgEventUq: unique("job_events_org_event_uq").on(table.organizationId, table.eventId),
    // Per-attempt contiguous ordering: at most one row per (attempt, sequence).
    orgAttemptSeqUq: unique("job_events_org_attempt_seq_uq").on(
      table.organizationId,
      table.attemptId,
      table.sequence,
    ),
    attemptIdx: index("job_events_attempt_idx").on(
      table.organizationId,
      table.attemptId,
      table.sequence,
    ),
    eventTypeValid: check(
      "job_events_event_type_check",
      sql`event_type IN (
        'attempt_started', 'log', 'progress', 'usage', 'artifact_prepared',
        'browser_observation', 'browser_approval_requested', 'runtime_decision_requested',
        'service_instance_started', 'service_health', 'service_checkpoint_prepared',
        'service_checkpoint_restored', 'service_graceful_stop_observed',
        'service_instance_stopped', 'service_instance_lost', 'service_provider_interrupted',
        'service_provider_resumed', 'network_denied', 'terminal'
      )`,
    ),
    digestValid: check(
      "job_events_digest_check",
      sql`event_digest ~ '^[0-9a-f]{64}$'`,
    ),
    sequenceValid: check("job_events_sequence_check", sql`sequence > 0`),
    attemptNumberValid: check("job_events_attempt_number_check", sql`attempt_number > 0`),
    // Composite tenant FK to the owning attempt — proves event↔attempt share a
    // tenant; ON DELETE cascade (events die with their attempt).
    attemptFk: foreignKey({
      columns: [table.organizationId, table.companyId, table.jobId, table.attemptId],
      foreignColumns: [
        jobAttempts.organizationId,
        jobAttempts.companyId,
        jobAttempts.jobId,
        jobAttempts.id,
      ],
      name: "job_events_attempt_fk",
    }).onDelete("cascade"),
    // Composite tenant FK to the lease/fence the event was accepted under.
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
      name: "job_events_lease_fk",
    }).onDelete("cascade"),
  }),
);

export type JobEvent = typeof jobEvents.$inferSelect;
export type NewJobEvent = typeof jobEvents.$inferInsert;
