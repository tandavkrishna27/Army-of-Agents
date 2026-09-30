import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  unique,
  check,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./organizations.js";
import { jobAttempts } from "./job_attempts.js";

/** Durable tenant notification. JOB-003 is the first consumer; JOB-001 only inserts. */
export const jobOutbox = pgTable(
  "job_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    companyId: uuid("company_id").notNull(),
    jobId: uuid("job_id").notNull(),
    attemptId: uuid("attempt_id").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("pending"),
    payload: jsonb("payload").$type<Record<string, string>>().notNull(),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
    claimToken: uuid("claim_token"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    claimIdx: index("job_outbox_claim_idx").on(
      table.organizationId,
      table.status,
      table.availableAt,
      table.createdAt,
      table.id,
    ),
    organizationJobIdx: index("job_outbox_organization_job_idx").on(
      table.organizationId,
      table.jobId,
    ),
    statusValid: check(
      "job_outbox_status_check",
      sql`status IN ('pending', 'claimed', 'delivered', 'retry', 'dead_letter')`,
    ),
    kindValid: check("job_outbox_kind_check", sql`kind IN ('attempt_ready')`),
    attemptKindUq: unique("job_outbox_attempt_kind_uq").on(
      table.organizationId,
      table.attemptId,
      table.kind,
    ),
    attemptFk: foreignKey({
      columns: [table.organizationId, table.companyId, table.jobId, table.attemptId],
      foreignColumns: [
        jobAttempts.organizationId,
        jobAttempts.companyId,
        jobAttempts.jobId,
        jobAttempts.id,
      ],
      name: "job_outbox_attempt_fk",
    }).onDelete("cascade"),
  }),
);

export type JobOutbox = typeof jobOutbox.$inferSelect;
export type NewJobOutbox = typeof jobOutbox.$inferInsert;
