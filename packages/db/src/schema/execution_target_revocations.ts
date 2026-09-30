import { pgTable, uuid, text, integer, timestamp, uniqueIndex, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// JOB-007 — durable OPERATOR-metadata fanout record for a committed target
// generation cutoff (worker/target revocation).
//
// SECURITY MODEL (custom RLS migration, C14 / Decision #122; mirrors the
// operator-metadata shape of `distributed_cutover_markers` in 0233):
//   - `aoa_operator` WRITE (SELECT, INSERT, UPDATE — no DELETE, records are
//     durable) — the revocation authority writes ONE record per committed cutoff
//     and the fanout worker advances its bounded scan/cursor/retry state.
//   - `aoa_app` READ-ONLY, and ONLY OUTSIDE a tenant transaction (the read policy
//     predicate is `current_setting('aoa.organization_id', true) IS NULL`) — the
//     fanout driver reads the pending records once, at the control-plane level,
//     then converges each admitted Organization SEPARATELY under `runInTenant`.
//   - tenants NONE — a tenant-scoped query (aoa_app WITH the tenant GUC set) never
//     matches the read policy, so the record is invisible to every tenant.
//   - FORCE ROW LEVEL SECURITY — defense-in-depth against a non-superuser owner
//     mistake (same rationale as the E2 tenant tables / E2-F004).
//
// This record is NOT lease authority: it never gates a lease/renew/complete. The
// authoritative cutoff is the target's bumped `execution_targets.device_generation`
// (which the fence guard's locked current-generation recheck reads); this record
// only drives idempotent, resumable convergence of already-stale leases. It
// contains NO job/event/secret data — only operator metadata about which target
// generation was cut off and how far the per-Organization fanout has progressed.
//
// Idempotency is keyed by `(target_id, revoked_generation)`: a second revocation
// invocation for the same committed cutoff is a no-op success. `organization_id`
// is the owning tenant for an organization/owner-scoped target (single-Org
// convergence), or NULL for a platform target (fan out to every admitted Org).
export const executionTargetRevocations = pgTable(
  "execution_target_revocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The revoked execution target. No FK: this is operator metadata that must
    // survive independently of tenant target lifecycle (an org/owner target may be
    // cascaded away while the durable cutoff record remains for audit/idempotency).
    targetId: uuid("target_id").notNull(),
    // The generation that was cut off: every lease/worker at generation <=
    // revoked_generation is stale. The target's live device_generation is
    // revoked_generation + 1 after the cutoff commits.
    revokedGeneration: integer("revoked_generation").notNull(),
    // Target scope at cutoff time ('platform' | 'organization' | 'owner'). A
    // platform target fans out to all admitted Orgs; org/owner converges one Org.
    targetScope: text("target_scope").notNull(),
    // Owning tenant for org/owner targets; NULL for platform targets.
    organizationId: uuid("organization_id"),
    // Bounded scan state machine: 'pending' -> 'converging' -> 'completed'. The
    // fanout worker advances it idempotently; a crash/restart resumes from 'pending'
    // or 'converging' and re-runs the durable idempotent per-Org scan to completion.
    status: text("status").notNull().default("pending"),
    // Resumable fanout cursor: the last Organization whose stale leases were
    // converged (NULL = not started). For an org/owner target there is at most one
    // Organization; for a platform target the worker rotates through admitted Orgs.
    scanCursor: uuid("scan_cursor"),
    // Bounded retry accounting for a transient per-Org convergence failure.
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    // Operator-supplied audit reason for the revocation.
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    targetGenerationUq: uniqueIndex("execution_target_revocations_target_generation_uq").on(
      table.targetId,
      table.revokedGeneration,
    ),
    statusIdx: index("execution_target_revocations_status_idx").on(
      table.status,
      table.createdAt,
      table.id,
    ),
    statusValid: check(
      "execution_target_revocations_status_check",
      sql`status IN ('pending', 'converging', 'completed')`,
    ),
    scopeValid: check(
      "execution_target_revocations_scope_check",
      sql`(
        target_scope = 'platform' AND organization_id IS NULL
      ) OR (
        target_scope IN ('organization', 'owner') AND organization_id IS NOT NULL
      )`,
    ),
    generationPositive: check(
      "execution_target_revocations_generation_check",
      sql`revoked_generation > 0`,
    ),
  }),
);

export type ExecutionTargetRevocation = typeof executionTargetRevocations.$inferSelect;
export type NewExecutionTargetRevocation = typeof executionTargetRevocations.$inferInsert;
