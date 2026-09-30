import { pgTable, uuid, text, integer, timestamp, boolean, index, check, unique, foreignKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./organizations.js";
import { jobs } from "./jobs.js";

// The kernel "run" surface (program-design's job/company/run — rich run columns
// deferred to E3). organization_id is DENORMALIZED onto the attempt (NOT NULL, no
// default) so TEN-004 can later add the composite FK to (jobs.organization_id,
// jobs.id) proving attempt↔job share a tenant. At TEN-001a only the plain job_id
// FK (ON DELETE CASCADE — attempts die with their job) + the denormalized
// organization_id column exist; the composite FK is TEN-004.
export const jobAttempts = pgTable(
  "job_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    companyId: uuid("company_id").notNull(),
    // TEN-004/E2-F013: NO single-column FK to jobs.id — the composite
    // `job_attempts_org_job_fk` (below) is the SOLE parent FK and carries ON DELETE
    // CASCADE (E2-D09). A redundant single-column parent FK is a cross-tenant
    // existence oracle (FK checks bypass RLS). organization_id keeps its FK.
    jobId: uuid("job_id").notNull(),
    attemptNumber: integer("attempt_number").notNull().default(1),
    status: text("status").notNull().default("pending"),
    // JOB-009: one immutable, server-owned placement snapshot per attempt. The
    // row itself is the uniqueness boundary; the repository writes these
    // columns only while placement_decided_at IS NULL.
    placementDisposition: text("placement_disposition"),
    placementOwner: text("placement_owner"),
    placementTargetId: uuid("placement_target_id"),
    placementTargetClass: text("placement_target_class"),
    placementTargetScope: text("placement_target_scope"),
    placementTargetGeneration: integer("placement_target_generation"),
    placementProfileHash: text("placement_profile_hash"),
    placementProviderConstraintHash: text("placement_provider_constraint_hash"),
    placementFallbackDisposition: text("placement_fallback_disposition"),
    placementReasonCode: text("placement_reason_code"),
    placementMode: text("placement_mode"),
    placementLeaseEligible: boolean("placement_lease_eligible"),
    placementInputDigest: text("placement_input_digest"),
    placementPolicyDigest: text("placement_policy_digest"),
    placementDecidedAt: timestamp("placement_decided_at", { withTimezone: true }),
    // JOB-006 immutable retry backoff. Set ONCE when the reaper allocates this
    // attempt as a retry (N>1) — the earliest instant it may be dispatched. NULL for
    // the initial attempt (attempt_number = 1). The reaper drives the job's
    // available_at + attempt-ready outbox available_at from this value, so it is
    // never mutated after creation.
    backoffUntil: timestamp("backoff_until", { withTimezone: true }),
    // JOB-007 shared Organization concurrency/capacity claim, STORED ON THE ATTEMPT
    // (not a parallel counter). The claim is the sole distributed-side occupancy fact
    // the org-capacity authority counts alongside legacy heartbeat runs. Lifecycle:
    //   'unclaimed' (default) -> 'held' (admitted to run under the org cap) -> 'released'.
    // Release is ONE conditional transition ('held' -> 'released') so retry, reaper,
    // revocation, and cost-exhaustion may all race but release EXACTLY once. Never
    // re-claimed after release (the attempt is terminal by then).
    capacityClaimState: text("capacity_claim_state").notNull().default("unclaimed"),
    // The workload bucket this claim was recorded under (snapshot of the job's
    // workload_type at claim time). NULL until claimed.
    capacityWorkloadType: text("capacity_workload_type"),
    capacityClaimedAt: timestamp("capacity_claimed_at", { withTimezone: true }),
    capacityReleasedAt: timestamp("capacity_released_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    organizationIdx: index("job_attempts_organization_idx").on(table.organizationId),
    jobIdx: index("job_attempts_job_idx").on(table.jobId),
    leaseCandidateIdx: index("job_attempts_lease_candidate_idx")
      .on(
        table.organizationId,
        table.placementTargetId,
        table.jobId,
        table.id,
      )
      .where(sql`
        ${table.status} = 'pending' AND
        ${table.placementDisposition} = 'selected' AND
        ${table.placementMode} = 'active' AND
        ${table.placementLeaseEligible} = true
      `),
    statusValid: check(
      "job_attempts_status_check",
      sql`status IN ('pending', 'offered', 'leased', 'running', 'cancel_requested', 'succeeded', 'failed', 'cancelled', 'expired')`,
    ),
    // TEN-004: FK-target composite unique so `leases` can bind (organization_id,
    // attempt_id) → job_attempts(organization_id, id).
    orgIdUq: unique("job_attempts_org_id_uq").on(table.organizationId, table.id),
    orgCompanyIdUq: unique("job_attempts_org_company_id_uq").on(
      table.organizationId,
      table.companyId,
      table.id,
    ),
    placementAtomic: check(
      "job_attempts_placement_atomic_check",
      sql`(
        placement_decided_at IS NULL AND placement_disposition IS NULL AND
        placement_owner IS NULL AND placement_target_id IS NULL AND
        placement_target_class IS NULL AND placement_target_scope IS NULL AND
        placement_target_generation IS NULL AND placement_profile_hash IS NULL AND
        placement_provider_constraint_hash IS NULL AND placement_fallback_disposition IS NULL AND
        placement_reason_code IS NULL AND placement_mode IS NULL AND
        placement_lease_eligible IS NULL AND placement_input_digest IS NULL AND
        placement_policy_digest IS NULL
      ) OR (
        placement_decided_at IS NOT NULL AND
        placement_disposition IN ('selected', 'legacy', 'queued', 'failed') AND
        placement_fallback_disposition IS NOT NULL AND placement_reason_code IS NOT NULL AND
        placement_mode IN ('active', 'shadow', 'legacy') AND
        placement_lease_eligible IS NOT NULL AND
        placement_lease_eligible = (
          placement_disposition = 'selected' AND placement_mode = 'active'
        ) AND
        placement_input_digest ~ '^[0-9a-f]{64}$' AND
        placement_policy_digest ~ '^[0-9a-f]{64}$' AND (
          (placement_disposition = 'selected' AND
           placement_owner IN ('managed_cloud', 'organization_dedicated', 'owner_desktop') AND
           placement_target_id IS NOT NULL AND
           placement_target_class = placement_owner AND
           placement_target_scope IN ('platform', 'organization', 'owner') AND
           placement_target_generation > 0 AND
           placement_profile_hash ~ '^[0-9a-f]{64}$' AND
           placement_provider_constraint_hash ~ '^[0-9a-f]{64}$') OR
          (placement_disposition = 'legacy' AND placement_owner = 'legacy' AND
           placement_target_id IS NULL AND placement_target_class IS NULL AND
           placement_target_scope IS NULL AND placement_target_generation IS NULL AND
           placement_profile_hash IS NULL AND placement_provider_constraint_hash IS NULL) OR
          (placement_disposition IN ('queued', 'failed') AND placement_owner IS NULL AND
           placement_target_id IS NULL AND placement_target_class IS NULL AND
           placement_target_scope IS NULL AND placement_target_generation IS NULL AND
           placement_profile_hash IS NULL AND placement_provider_constraint_hash IS NULL)
        )
      )`,
    ),
    orgCompanyJobIdUq: unique("job_attempts_org_company_job_id_uq").on(
      table.organizationId,
      table.companyId,
      table.jobId,
      table.id,
    ),
    capacityClaimValid: check(
      "job_attempts_capacity_claim_check",
      sql`(
        capacity_claim_state = 'unclaimed' AND capacity_workload_type IS NULL AND
        capacity_claimed_at IS NULL AND capacity_released_at IS NULL
      ) OR (
        capacity_claim_state = 'held' AND capacity_workload_type IS NOT NULL AND
        capacity_claimed_at IS NOT NULL AND capacity_released_at IS NULL
      ) OR (
        capacity_claim_state = 'released' AND capacity_workload_type IS NOT NULL AND
        capacity_claimed_at IS NOT NULL AND capacity_released_at IS NOT NULL
      )`,
    ),
    jobAttemptNumberUq: unique("job_attempts_job_number_uq").on(
      table.organizationId,
      table.companyId,
      table.jobId,
      table.attemptNumber,
    ),
    // TEN-004: composite org-scoped FK — an attempt's (organization_id, job_id)
    // must exist together in jobs(organization_id, id), so an attempt cannot be
    // stamped with a different tenant than its job. The redundant single-column job
    // FK was DROPPED in E2-F013 (0212) — it bypassed RLS and leaked cross-tenant
    // existence; this composite is the SOLE job FK, ON DELETE cascade (E2-D09).
    orgJobFk: foreignKey({
      columns: [table.organizationId, table.companyId, table.jobId],
      foreignColumns: [jobs.organizationId, jobs.companyId, jobs.id],
      name: "job_attempts_org_job_fk",
    }).onDelete("cascade"),
  }),
);

export type JobAttempt = typeof jobAttempts.$inferSelect;
export type NewJobAttempt = typeof jobAttempts.$inferInsert;
