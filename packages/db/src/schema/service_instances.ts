import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  uniqueIndex,
  check,
  unique,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./organizations.js";
import { services } from "./services.js";

// A concrete instance of a `service` + its generation (E2-D06). Rich instance
// columns are deferred to E3 (additive). organization_id is DENORMALIZED onto the
// instance (NOT NULL, no default) so TEN-004 can later add the composite FK to
// (services.organization_id, services.id) proving instance↔service share a
// tenant. At TEN-001b only the plain service_id FK (ON DELETE CASCADE — instances
// die with their service) + the denormalized organization_id column exist; the
// composite FK is TEN-004.
//
// SVC-002 gave this table its first writer with a production caller. Every column added
// there is written by the reconciler's own transaction — the rule that keeps this from
// becoming a set of columns nothing fills, which is the vacuously-true acceptance pattern
// SVC-001 already declined `actor_context_policy_id` on. Columns SVC-002 deliberately did
// NOT add, with the ticket that owns each: `lease_id` / `worker_id` / `started_at` /
// `last_health_at` (SVC-003 — the lease is minted after SVC-002's transaction has
// committed, and health is the only writer of the last two); `restart_count` /
// `backoff_until` (SVC-004); `paused_at` / `budget_*` / `ttl_deadline_at` (SVC-005).
//
// SVC-003b took the first of those and RENAMED it, which is a deviation worth stating rather
// than quietly shipping. SVC-002 reserved `last_health_at` on the assumption that
// `service_health` would be its only writer. It is not: EVERY attributed service observation
// witnesses that the worker is alive, and the liveness deadline must age against the last
// time the worker was seen AT ALL — not the last time it happened to send the one event type
// whose name is "health". A column called `last_health_at` written by
// `service_instance_started` and `attempt_started` too would be a lie in its own name, so the
// column is `last_observed_at`. `started_at` stays unadded (SVC-004's restart history needs
// it; nothing in this ticket reads it).
export const serviceInstances = pgTable(
  "service_instances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // TEN-004/E2-F013: NO single-column FK to services.id — the composite
    // `service_instances_org_service_fk` (below) is the SOLE parent FK and carries
    // ON DELETE CASCADE (E2-D09). A redundant single-column parent FK is a
    // cross-tenant existence oracle (FK checks bypass RLS). organization_id keeps
    // its FK.
    serviceId: uuid("service_id").notNull(),
    // SVC-002. Denormalized and load-bearing, exactly as on `services` and
    // `service_generations`: `aoa.organization_id` is the ONLY GUC, so company scoping is
    // necessarily app-layer and this column is the sole company predicate any later reader
    // has. Its integrity comes from the TRIPLE composite FK below, never from a
    // single-column FK (which would bypass RLS and leak cross-tenant existence, E2-F013).
    //
    // NOT NULL with no default, deliberately: a sentinel-company default would be a
    // fail-open, and the reconciler writes this column in the same transaction that inserts
    // the row. The migration can add it NOT NULL without a backfill because this table has
    // never had a production writer (SVC-002-terrain.md §1: `service_instances` has one
    // INSERT in the tree with ZERO production callers), so every deployment's table is empty.
    companyId: uuid("company_id").notNull(),
    generation: integer("generation").notNull().default(1),
    status: text("status").notNull().default("pending"),
    // SVC-002. Without these the instance row is UNATTRIBUTABLE: nothing correlates an
    // instance with the job serving it and SVC-003 has nothing to fence against. Both ids
    // exist inside the reconciler's single transaction, so both are written by the same
    // commit that adds the columns (no vacuously-true column).
    //
    // Deliberately PLAIN COLUMNS rather than a composite FK into
    // `jobs(organization_id, company_id, id)`, even though `jobs_org_company_id_uq` exists.
    // The direction of the dependency would be wrong: `jobs` is the generic control plane,
    // and a service-specific child FK into it makes job lifecycle management service-aware,
    // with non-obvious ON DELETE semantics (a deleted job should probably NOT delete the
    // instance row that is the audit record of it). Recorded as a judgement call, not an
    // impossibility — SVC-002-design.md §10.3, still unmade.
    //
    // Nullable because the ORDER inside the transaction is insert-then-submit: the instance
    // id is minted first so the workload can carry it. The reconciler UPDATEs both to
    // non-null before commit, so a committed reconciler-authored row always carries them.
    jobId: uuid("job_id"),
    attemptId: uuid("attempt_id"),
    // ★★★ SVC-003b — THE LIVENESS DEADLINE'S ONLY INPUT, and its NULLABILITY is the whole
    // safety property rather than an omission.
    //
    // Written by `applyServiceProjectionForFence` for every observation that survived
    // attribution + identity + generation — INCLUDING the ones that move no status. The
    // common case for a healthy service is `service_health healthy` arriving every 10 s onto
    // an already-`healthy` row (`noop_same_status`), so a stamp written only on a real status
    // move would go stale on every working service and the deadline would kill all of them.
    //
    // NULL is NOT "very old". NULL means THE WORKER HAS NEVER BEEN OBSERVED, and the deadline
    // may not age a liveness window against an observation it does not have — that is the
    // fail-open SVC-008b's stop-verdict work exists to refuse, pointed at the opposite
    // outcome. A never-observed instance is aged against `created_at` under a SEPARATE and
    // deliberately longer admission deadline instead, and the two windows never substitute for
    // each other. `classifyServiceInstanceLiveness` is where that split lives.
    //
    // No default: `defaultNow()` here would forge an observation at INSERT time — the
    // reconciler creating a row is not the worker being seen — and would erase the very
    // distinction above.
    lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),
    // ★★★ SVC-005a — WHO drove this row terminal, and it is a FENCE INPUT rather than
    // telemetry.
    //
    // E9-F009 recorded the gap: `service_instances` carried `status` and `updated_at` and
    // nothing that said WHO moved the row, so a worker that reported itself gone and a
    // control plane that GAVE UP on a worker it could not reach were indistinguishable in
    // durable state. E9-F009 §2 called that the "durable half" and left it open. This column
    // is that half, and SVC-005a needs it because the distinction is load-bearing for the
    // generation rollout fence, not merely informative:
    //
    //   'worker_stopped'  the worker's own attributed, fenced observation that the PROCESS WAS
    //                   SEEN GONE. The ONLY witness.
    //   'worker_unconfirmed'  the worker's own attributed, fenced event, but one that does NOT
    //                   assert an observed stop -- `service_instance_lost`, which the daemon
    //                   emits when `inspect` could not describe the sandbox OR when "a full
    //                   stop ladder ended with the process still observed `running`"
    //                   (packages/worker-daemon/src/supervisor/service-lifecycle.ts). Fenced
    //                   and authentic, and still NOT evidence that anything stopped. Splitting
    //                   this off the witness was external review of PR #415's P1.
    //   'liveness_deadline'  SVC-003b's clock condemned it because nothing had been heard.
    //                   The worker may still be running (E9-F007). AN ASSUMPTION.
    //   'control_plane_backstop'  SVC-007a's cancelled-attempt projection moved it because
    //                   the ATTEMPT was terminal and the instance was stranded. Also an
    //                   assumption about the process, though a better-founded one.
    //
    // ★ WRITTEN ONLY WHEN THE STATUS BEING WRITTEN IS TERMINAL, at the single chokepoint
    // `writeServiceInstanceStatus` — the ONE writer of `status`, which all four authors
    // already funnel through. A non-terminal move leaves it NULL, so the column never claims
    // an authorship for a row that has not ended.
    //
    // NULLABLE, and no default. NULL means "this row has not been terminalized" for a live
    // row, and for a terminal row it means "terminalized before this column existed" — a
    // state the fence must read as UNKNOWN and therefore as NOT-A-WITNESS, which is the
    // fail-closed direction. A default would forge an author.
    terminalizedBy: text("terminalized_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    organizationIdx: index("service_instances_organization_idx").on(table.organizationId),
    serviceIdx: index("service_instances_service_idx").on(table.serviceId),
    // SVC-001: reconciled against the FROZEN authority `SERVICE_INSTANCE_STATUSES`
    // (packages/worker-protocol states.ts) - all NINE. The previous list had five and
    // included `interrupted`, which is not a frozen state at all. Hand-written for the
    // same reason as services (no worker-protocol dependency here); the reconciliation is
    // asserted server-side, and asserts set EQUALITY so an EXTRA value is caught too.
    statusValid: check(
      "service_instances_status_check",
      sql`status IN ('pending', 'leased', 'starting', 'healthy', 'unhealthy', 'stopping', 'stopped', 'failed', 'lost')`,
    ),
    // SVC-005a: all four authors, spelled once in the database. Hand-written here for the
    // same reason `service_instances_status_check` is (packages/db does not depend on
    // worker-protocol), and reconciled against the server-side constant
    // `SERVICE_INSTANCE_TERMINAL_AUTHORS` by `T-P5c` in
    // server/src/__tests__/service-generation-rollout.test.ts, which reads THIS literal as
    // source text and asserts set EQUALITY, so an author added on one side and not the other
    // is caught rather than silently storable. `T-P5` asserts the same equality against the
    // applied DDL of migration 0279, and `T-P5d` against each other.
    //
    // ★ WHAT T-P5c DOES NOT PROVE, because this comment previously claimed an enforcement
    // that did not exist and external review of PR #415 caught it: reading this literal says
    // nothing about the constraint any deployed database is actually running — 0279 is
    // immutable once applied and T-P5 is what covers it. What this copy governs is the DDL
    // `db:generate` would emit NEXT for this table, which is why a divergence here is worth
    // catching even though today's deployment would not notice it.
    //
    // NULL is admitted by a CHECK on a nullable column and is the pre-column / not-yet-
    // terminal state; the fence reads it as NOT-A-WITNESS.
    terminalizedByValid: check(
      "service_instances_terminalized_by_check",
      sql`terminalized_by IS NULL OR terminalized_by IN ('worker_stopped', 'worker_unconfirmed', 'liveness_deadline', 'control_plane_backstop')`,
    ),
    // SVC-001: this table previously had NO unique constraint at all, so nothing could
    // bind a composite tenant FK to an instance. Every child table SVC-002/003 needs was
    // blocked on this one line.
    orgIdUq: unique("service_instances_org_id_uq").on(table.organizationId, table.id),
    // ★★★ SVC-002 — THE AUTHORITY for "one service, one running instance, without
    // duplicate placement". Everything else the reconciler does about duplicates is
    // convenience.
    //
    // WHY AN INDEX AND NOT A LOCK. A unique index is enforced by the storage engine on
    // EVERY insert, including one written by a caller that does not exist yet. The advisory
    // lock the reconciler takes is ADVISORY: nothing forces SVC-004's restart path or
    // SVC-007's manual "start now" control to take it, and a concurrency test written
    // against two copies of the reconciler cannot see a writer that skips it. Same objection
    // kills `SELECT ... FOR UPDATE` on the parent `services` row (an inserter that never
    // reads `services` takes no lock) and the submission idempotency key (it constrains
    // `jobs`, not this table). The invariant has to live in the database or it is not an
    // invariant.
    //
    // THE PREDICATE IS DERIVED, NOT HAND-PICKED. 'stopped' / 'failed' / 'lost' are exactly
    // the three states with no outgoing transitions in the FROZEN `serviceInstance`
    // lifecycle (packages/worker-protocol states.ts SERVICE_INSTANCE_TRANSITIONS, mirrored
    // in docs/architecture/distributed-execution-lifecycles.json). Hand-written here for the
    // same reason the CHECK above is (packages/db does not depend on worker-protocol); the
    // reconciliation against the frozen authority is asserted server-side.
    //
    // House precedent: `job_artifacts` carries three disjoint partial uniques over a natural
    // key for exactly this purpose (DAT-002/006/009).
    liveInstanceUq: uniqueIndex("service_instances_live_service_uq")
      .on(table.organizationId, table.serviceId)
      .where(sql`status NOT IN ('stopped', 'failed', 'lost')`),
    // TEN-004 + SVC-002: composite org-scoped FK. Widened from the (organization_id,
    // service_id) PAIR to the (organization_id, company_id, service_id) TRIPLE for E2-F013's
    // reason: with the pair, an instance could carry company B while its service belongs to
    // company A inside one org, with every constraint satisfied — and the denormalized
    // company_id is the sole company predicate any later reader has, so its integrity is the
    // whole guarantee. This is the same correction SVC-001 applied to `service_generations`.
    // The FK target `services_org_company_id_uq` already exists (SVC-001). ON DELETE cascade
    // (E2-D09) — instances die with their service. Still the SOLE service FK: the redundant
    // single-column one was DROPPED in E2-F013 (0212) because it bypassed RLS and leaked
    // cross-tenant existence.
    orgCompanyServiceFk: foreignKey({
      columns: [table.organizationId, table.companyId, table.serviceId],
      foreignColumns: [services.organizationId, services.companyId, services.id],
      name: "service_instances_org_company_service_fk",
    }).onDelete("cascade"),
  }),
);

export type ServiceInstance = typeof serviceInstances.$inferSelect;
export type NewServiceInstance = typeof serviceInstances.$inferInsert;
