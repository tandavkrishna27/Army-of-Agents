import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  check,
  foreignKey,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { jobAttempts } from "./job_attempts.js";
import { workers } from "./workers.js";

/**
 * Exact static-negative lease eligibility certificate. Dynamic capacity,
 * liveness, lock, parsing, and authority failures are deliberately excluded.
 */
export const workerLeaseRejections = pgTable(
  "worker_lease_rejections",
  {
    organizationId: uuid("organization_id").notNull(),
    companyId: uuid("company_id").notNull(),
    jobId: uuid("job_id").notNull(),
    attemptId: uuid("attempt_id").notNull(),
    workerId: uuid("worker_id").notNull(),
    targetId: uuid("target_id").notNull(),
    targetAuthorityKey: text("target_authority_key").notNull(),
    eligibilityVersion: integer("eligibility_version").notNull(),
    staticContextHash: text("static_context_hash").notNull(),
    workloadType: text("workload_type").notNull(),
    placementOwner: text("placement_owner").notNull(),
    placementTargetClass: text("placement_target_class").notNull(),
    placementTargetScope: text("placement_target_scope").notNull(),
    placementTargetGeneration: integer("placement_target_generation").notNull(),
    placementProfileHash: text("placement_profile_hash").notNull(),
    placementProviderConstraintHash: text("placement_provider_constraint_hash").notNull(),
    placementInputDigest: text("placement_input_digest").notNull(),
    placementPolicyDigest: text("placement_policy_digest").notNull(),
    reasonCode: text("reason_code").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    primaryKey: primaryKey({
      columns: [table.organizationId, table.workerId, table.attemptId],
      name: "worker_lease_rejections_pkey",
    }),
    attemptIdx: index("worker_lease_rejections_attempt_idx").on(
      table.organizationId,
      table.companyId,
      table.jobId,
      table.attemptId,
    ),
    cleanupIdx: index("worker_lease_rejections_cleanup_idx").on(
      table.organizationId,
      table.updatedAt,
      table.workerId,
      table.attemptId,
    ),
    workloadTypeValid: check(
      "worker_lease_rejections_workload_type_check",
      sql`workload_type IN ('batch', 'browser_session', 'service')`,
    ),
    placementOwnerValid: check(
      "worker_lease_rejections_placement_owner_check",
      sql`placement_owner IN ('managed_cloud', 'organization_dedicated', 'owner_desktop')`,
    ),
    placementTargetClassValid: check(
      "worker_lease_rejections_placement_target_class_check",
      sql`placement_target_class IN ('managed_cloud', 'organization_dedicated', 'owner_desktop')`,
    ),
    placementTargetScopeValid: check(
      "worker_lease_rejections_placement_target_scope_check",
      sql`placement_target_scope IN ('platform', 'organization', 'owner')`,
    ),
    reasonCodeValid: check(
      "worker_lease_rejections_reason_code_check",
      sql`reason_code IN ('static_requirements_mismatch')`,
    ),
    hashesValid: check(
      "worker_lease_rejections_hashes_check",
      sql`
        static_context_hash ~ '^[0-9a-f]{64}$' AND
        placement_profile_hash ~ '^[0-9a-f]{64}$' AND
        placement_provider_constraint_hash ~ '^[0-9a-f]{64}$' AND
        placement_input_digest ~ '^[0-9a-f]{64}$' AND
        placement_policy_digest ~ '^[0-9a-f]{64}$'
      `,
    ),
    eligibilityVersionValid: check(
      "worker_lease_rejections_eligibility_version_check",
      sql`eligibility_version > 0`,
    ),
    placementTargetGenerationValid: check(
      "worker_lease_rejections_placement_target_generation_check",
      sql`placement_target_generation > 0`,
    ),
    attemptFk: foreignKey({
      columns: [
        table.organizationId,
        table.companyId,
        table.jobId,
        table.attemptId,
      ],
      foreignColumns: [
        jobAttempts.organizationId,
        jobAttempts.companyId,
        jobAttempts.jobId,
        jobAttempts.id,
      ],
      name: "worker_lease_rejections_attempt_fk",
    }).onDelete("cascade"),
    workerTargetFk: foreignKey({
      columns: [
        table.organizationId,
        table.workerId,
        table.targetAuthorityKey,
        table.targetId,
      ],
      foreignColumns: [
        workers.organizationId,
        workers.id,
        workers.targetAuthorityKey,
        workers.executionTargetId,
      ],
      name: "worker_lease_rejections_worker_target_fk",
    }).onDelete("cascade"),
  }),
);

export type WorkerLeaseRejection = typeof workerLeaseRejections.$inferSelect;
export type NewWorkerLeaseRejection = typeof workerLeaseRejections.$inferInsert;
