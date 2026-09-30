import {
  pgTable,
  uuid,
  text,
  bigint,
  jsonb,
  timestamp,
  index,
  unique,
  foreignKey,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { companies } from "./companies.js";

// MIG-003 (E10-REALTIME-FOUNDATION) — the durable, company-scoped realtime event
// log. It is the source of truth for cross-replica fan-out and `?sinceSeq=N`
// reconnect/catch-up. A row is the durable record that ONE durable-eligible
// LiveEvent was published for a company. `payload` stores the SAME minimal
// invalidation hint as the in-process emitter (no secrets — by construction);
// realtime is a HINT and the DB is truth, so a dropped NOTIFY delays realtime but
// never corrupts state (the safety poll + reconnect cursor recover the tail).
//
// Tenant isolation MIRRORS job_events (Decision #122): FORCE RLS + one org-scoped
// aoa_app tenant-isolation policy (custom migration), grants on BOTH surfaces
// (job-control-legacy-grants.ts + distributed-execution-databases spread). Every
// parent relationship to `companies` is a COMPOSITE tenant FK so a log row can
// never be stamped with a different tenant than its company — a redundant
// single-column company FK would be a cross-tenant existence oracle (E2-F013), so
// there is none. `organization_id` keeps its own tenant-root FK.
export const liveEventLog = pgTable(
  "live_event_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    companyId: uuid("company_id").notNull(),
    // Per-company CONTIGUOUS monotonic ordering (assigned in-tx via the
    // live_event_sequences counter with UPDATE ... RETURNING — never a global
    // sequence, so it matches the emitter keying and one durable log per company).
    seq: bigint("seq", { mode: "number" }).notNull(),
    // Idempotent re-delivery: the SAME event id can only ever be appended once.
    eventId: uuid("event_id").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Per-company contiguous ordering + the replay/cursor read index.
    companySeqUq: unique("live_event_log_company_seq_uq").on(table.companyId, table.seq),
    companySeqIdx: index("live_event_log_company_seq_idx").on(table.companyId, table.seq),
    // Idempotent append: one row per (organization, eventId).
    orgEventUq: unique("live_event_log_org_event_uq").on(table.organizationId, table.eventId),
    // Composite tenant FK to the owning company — proves log row ↔ company share a
    // tenant; ON DELETE cascade (log rows die with their company).
    companyFk: foreignKey({
      columns: [table.organizationId, table.companyId],
      foreignColumns: [companies.organizationId, companies.id],
      name: "live_event_log_company_fk",
    }).onDelete("cascade"),
  }),
);

// MIG-003 — the per-company atomic sequence source for `live_event_log.seq`. One
// row per company; `next_seq` is bumped `UPDATE ... RETURNING` in the same tenant
// tx as the log insert (serialized on the company row, so seq stays contiguous
// even under concurrent publishers — mirrors the discussions `entrySeq` pattern,
// NOT a global Postgres sequence). Same tenant FORCE-RLS + composite tenant FK as
// the log itself.
export const liveEventSequences = pgTable(
  "live_event_sequences",
  {
    companyId: uuid("company_id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    nextSeq: bigint("next_seq", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyFk: foreignKey({
      columns: [table.organizationId, table.companyId],
      foreignColumns: [companies.organizationId, companies.id],
      name: "live_event_sequences_company_fk",
    }).onDelete("cascade"),
  }),
);

export type LiveEventLogRow = typeof liveEventLog.$inferSelect;
export type NewLiveEventLogRow = typeof liveEventLog.$inferInsert;
export type LiveEventSequenceRow = typeof liveEventSequences.$inferSelect;
