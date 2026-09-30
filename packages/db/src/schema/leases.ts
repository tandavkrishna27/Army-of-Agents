import { pgTable, uuid, text, integer, timestamp, index, check, unique, uniqueIndex, foreignKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./organizations.js";
import { jobAttempts } from "./job_attempts.js";
import { workers } from "./workers.js";
import { executionTargets } from "./execution_targets.js";

// Lease over a job attempt (fence-token guarded). organization_id is DENORMALIZED
// (NOT NULL, no default) so TEN-004 can constrain lease↔attempt within one tenant.
// `fence` is an unpredictable fence token (text/uuid is fine at the kernel level;
// generation policy is later). At TEN-001a only the plain attempt_id FK (ON DELETE
// CASCADE) + denormalized organization_id exist; the partial-unique "at most one
// active lease per attempt" (uniqueIndex WHERE status in ('offered','active')) is TEN-004.
export const leases = pgTable(
  "leases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // TEN-004/E2-F013: NO single-column FK to job_attempts.id — the composite
    // `leases_org_attempt_fk` (below) is the SOLE parent FK and carries ON DELETE
    // CASCADE (E2-D09). A redundant single-column parent FK is a cross-tenant
    // existence oracle (FK checks bypass RLS). organization_id keeps its FK.
    attemptId: uuid("attempt_id").notNull(),
    // JOB-003 authority tuple. Nullable only for pre-JOB-003 kernel rows; the
    // check below requires the complete tuple for every rich leasing row.
    companyId: uuid("company_id"),
    jobId: uuid("job_id"),
    attemptNumber: integer("attempt_number"),
    workerId: uuid("worker_id"),
    targetId: uuid("target_id"),
    targetAuthorityKey: text("target_authority_key"),
    targetGeneration: integer("target_generation"),
    profileHash: text("profile_hash"),
    providerConstraintHash: text("provider_constraint_hash"),
    status: text("status").notNull().default("offered"),
    fence: text("fence").notNull(),
    ackDeadline: timestamp("ack_deadline", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    organizationIdx: index("leases_organization_idx").on(table.organizationId),
    attemptIdx: index("leases_attempt_idx").on(table.attemptId),
    statusValid: check(
      "leases_status_check",
      sql`status IN ('offered', 'active', 'released', 'expired', 'revoked')`,
    ),
    authorityAtomic: check(
      "leases_authority_atomic_check",
      sql`(
        company_id IS NULL AND job_id IS NULL AND attempt_number IS NULL AND
        worker_id IS NULL AND target_id IS NULL AND target_authority_key IS NULL AND
        target_generation IS NULL AND profile_hash IS NULL AND
        provider_constraint_hash IS NULL AND ack_deadline IS NULL AND expires_at IS NULL
      ) OR (
        company_id IS NOT NULL AND job_id IS NOT NULL AND attempt_number > 0 AND
        worker_id IS NOT NULL AND target_id IS NOT NULL AND target_authority_key IS NOT NULL AND
        target_generation > 0 AND profile_hash ~ '^[0-9a-f]{64}$' AND
        provider_constraint_hash ~ '^[0-9a-f]{64}$' AND
        ack_deadline IS NOT NULL AND expires_at IS NOT NULL AND ack_deadline < expires_at
      )`,
    ),
    activationValid: check(
      "leases_activation_check",
      sql`(status = 'active' AND activated_at IS NOT NULL) OR (status = 'offered' AND activated_at IS NULL) OR status IN ('released', 'expired', 'revoked')`,
    ),
    // TEN-004: composite org-scoped FK — a lease's (organization_id, attempt_id)
    // must exist together in job_attempts(organization_id, id), so a lease cannot
    // be stamped with a different tenant than its attempt. The redundant single-column
    // attempt FK was DROPPED in E2-F013 (0212) — it bypassed RLS and leaked cross-tenant
    // existence; this composite is the SOLE attempt FK, ON DELETE cascade (E2-D09).
    orgAttemptFk: foreignKey({
      columns: [table.organizationId, table.attemptId],
      foreignColumns: [jobAttempts.organizationId, jobAttempts.id],
      name: "leases_org_attempt_fk",
    }).onDelete("cascade"),
    orgCompanyJobAttemptFk: foreignKey({
      columns: [table.organizationId, table.companyId, table.jobId, table.attemptId],
      foreignColumns: [
        jobAttempts.organizationId,
        jobAttempts.companyId,
        jobAttempts.jobId,
        jobAttempts.id,
      ],
      name: "leases_org_company_job_attempt_fk",
    }).onDelete("cascade"),
    orgWorkerFk: foreignKey({
      columns: [table.organizationId, table.workerId],
      foreignColumns: [workers.organizationId, workers.id],
      name: "leases_org_worker_fk",
    }).onDelete("restrict"),
    targetAuthorityFk: foreignKey({
      columns: [table.targetAuthorityKey, table.targetId],
      foreignColumns: [executionTargets.targetAuthorityKey, executionTargets.id],
      name: "leases_target_authority_fk",
    }).onDelete("restrict"),
    orgCompanyJobAttemptIdUq: unique("leases_org_company_job_attempt_id_uq").on(
      table.organizationId,
      table.companyId,
      table.jobId,
      table.attemptId,
      table.id,
    ),
    // TEN-004: "at most one LIVE lease per attempt". A PARTIAL UNIQUE INDEX
    // (Postgres has no partial unique CONSTRAINT; `unique()` cannot express
    // `where`) covering only leases still in a live state — a released/expired/
    // revoked lease leaves the index so the attempt can be re-leased.
    activePerAttempt: uniqueIndex("leases_active_per_attempt_idx")
      .on(table.attemptId)
      .where(sql`status in ('offered', 'active')`),
  }),
);

export type Lease = typeof leases.$inferSelect;
export type NewLease = typeof leases.$inferInsert;
