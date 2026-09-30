import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  index,
  check,
  unique,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./organizations.js";
import { companies } from "./companies.js";

// New-path distributed-execution kernel: immutable job intent + aggregate status
// (E2-D06). Rich job columns are deferred to E3 (additive). Both tenant identities
// are MANDATORY and NON-DEFAULTED — no sentinel-org fail-open (contrast
// companies.organization_id): an insert that omits either FK fails the NOT NULL
// constraint (fail-closed). organization_id / company_id use ON DELETE RESTRICT so
// a tenant cannot be torn down while it still owns jobs (teardown is out of scope).
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // TEN-004/E2-F013: NO single-column FK to companies.id — a redundant
    // single-column parent FK is a cross-tenant EXISTENCE ORACLE (FK checks bypass
    // RLS, so a company_id that exists in ANOTHER org would pass a single-column FK
    // and fail only the composite FK, while an absent id fails the single-column FK
    // — the differing constraint name leaks existence, banned by H-01). The
    // composite `jobs_org_company_fk` (below) is the SOLE parent FK and carries the
    // ON DELETE (E2-D09). organization_id keeps its single-column FK (tenant key; a
    // cross-org value hits RLS WITH CHECK (42501) before any FK — not an oracle).
    companyId: uuid("company_id").notNull(),
    // Defaults preserve the additive E2 kernel insertion seam. JOB-001 always
    // supplies every field explicitly; the defaults only keep pre-E3 RLS probes
    // and already-created kernel rows valid during rolling migration.
    workloadType: text("workload_type").notNull().default("batch"),
    authenticatedPrincipalKind: text("authenticated_principal_kind").notNull().default("system"),
    authenticatedPrincipalId: text("authenticated_principal_id").notNull().default("legacy-kernel"),
    authenticatedSourceKind: text("authenticated_source_kind").notNull().default("legacy_kernel"),
    authenticatedSourceIdentity: text("authenticated_source_identity").notNull().default("legacy-kernel"),
    idempotencyKey: text("idempotency_key").notNull().default(sql`gen_random_uuid()::text`),
    commandDigest: text("command_digest").notNull().default("legacy-kernel"),
    sourceKind: text("source_kind").notNull().default("legacy_kernel"),
    sourceIdentity: text("source_identity").notNull().default("legacy-kernel"),
    sourceIntent: jsonb("source_intent").$type<Record<string, unknown>>().notNull().default({}),
    requesterPrincipalKind: text("requester_principal_kind").notNull().default("system"),
    requesterPrincipalId: text("requester_principal_id").notNull().default("legacy-kernel"),
    executorPrincipalKind: text("executor_principal_kind").notNull().default("system"),
    executorPrincipalId: text("executor_principal_id").notNull().default("legacy-kernel"),
    input: jsonb("input").$type<Record<string, unknown>>().notNull().default({}),
    inputHash: text("input_hash").notNull().default("legacy-kernel"),
    policySnapshot: jsonb("policy_snapshot").$type<Record<string, unknown>>().notNull().default({}),
    policyHash: text("policy_hash").notNull().default("legacy-kernel"),
    requirements: jsonb("requirements").$type<Record<string, unknown>>().notNull().default({}),
    placementRequest: jsonb("placement_request").$type<Record<string, unknown>>().notNull().default({}),
    priority: integer("priority").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    status: text("status").notNull().default("queued"),
    // JOB-006 server retry policy + dead-letter reason. `max_attempts` is the retry
    // ceiling the reaper compares `max(attempt_number)` against; the default keeps
    // pre-JOB-006 kernel rows valid (the reaper is dormant behind the distributed
    // flag). `dead_letter_reason` is set once when retries are exhausted (or an
    // operator dead-letters), and is NULL otherwise.
    maxAttempts: integer("max_attempts").notNull().default(3),
    deadLetterReason: text("dead_letter_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    organizationIdx: index("jobs_organization_idx").on(table.organizationId),
    organizationCompanyIdx: index("jobs_organization_company_idx").on(
      table.organizationId,
      table.companyId,
    ),
    claimIdx: index("jobs_claim_idx").on(
      table.organizationId,
      table.status,
      table.availableAt,
      table.priority.desc(),
      table.createdAt,
      table.id,
    ),
    operatorListIdx: index("jobs_operator_list_idx").on(
      table.organizationId,
      table.companyId,
      table.createdAt,
      table.id,
    ),
    statusValid: check(
      "jobs_status_check",
      sql`status IN ('queued', 'running', 'cancel_requested', 'succeeded', 'failed', 'cancelled', 'dead_letter')`,
    ),
    // TEN-004: FK-target composite unique. A PK on `id` alone cannot be the
    // target of a composite (organization_id, id) FK — children (job_attempts,
    // job_artifacts, job_secret_handles) reference EXACTLY this column set to
    // prove they share the job's tenant.
    orgIdUq: unique("jobs_org_id_uq").on(table.organizationId, table.id),
    orgCompanyIdUq: unique("jobs_org_company_id_uq").on(
      table.organizationId,
      table.companyId,
      table.id,
    ),
    idempotencyUq: unique("jobs_submission_idempotency_uq").on(
      table.organizationId,
      table.companyId,
      table.authenticatedPrincipalKind,
      table.authenticatedPrincipalId,
      table.authenticatedSourceKind,
      table.authenticatedSourceIdentity,
      table.idempotencyKey,
    ),
    // TEN-004: composite org-scoped FK — a job's (organization_id, company_id)
    // must exist together in companies(organization_id, id). Direct SQL cannot
    // pair org A with a company owned by org B. The redundant single-column company
    // FK was DROPPED in E2-F013 (migration 0212): FK checks bypass RLS, so a
    // cross-tenant vs absent company id failed a DIFFERENT constraint — a cross-tenant
    // existence oracle. This composite is the SOLE company FK, ON DELETE restrict (E2-D09).
    orgCompanyFk: foreignKey({
      columns: [table.organizationId, table.companyId],
      foreignColumns: [companies.organizationId, companies.id],
      name: "jobs_org_company_fk",
    }).onDelete("restrict"),
  }),
);

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
