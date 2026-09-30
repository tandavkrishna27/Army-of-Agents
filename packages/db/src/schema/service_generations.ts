import { pgTable, uuid, integer, jsonb, text, timestamp, index, unique, foreignKey } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { services } from "./services.js";

// SVC-001 — the IMMUTABLE service definition. An update to a service does not mutate
// anything here; it mints a new row with the next `generation`.
//
// HOW IMMUTABILITY IS ENFORCED, and why it is not a trigger. There are ZERO
// `CREATE TRIGGER` / `CREATE RULE` statements across all 264 migrations in this repo, so
// there is no DB backstop to reach for. The mechanism is GRANT OMISSION: the migration
// grants `aoa_app` only SELECT and INSERT on this table — no UPDATE, no DELETE — and the
// relation ACL certificate is fail-closed (a relation missing from the manifest throws at
// import, and a mismatch fails typecheck). That is a real mechanism, not a convention:
// the whole job-control HTTP surface is mounted only over the non-owner `aoa_app` pool and
// `app.ts` refuses owner fallback by name.
//
// ★ THE FK MUST NOT CASCADE, and this is the subtle part. `aoa_app` holds DELETE on
// `services`, and a PostgreSQL referential action executes with the CONSTRAINT's rights
// rather than the caller's. Under `ON DELETE CASCADE`, `DELETE FROM services` would erase
// every row this table declares immutable, while `aoa_app` holds no DELETE on it — and the
// obvious acceptance test (DELETE here -> 42501) would still PASS, because it cannot see
// that path. Hence RESTRICT, plus an explicit parent-delete assertion.
//
// The consequence is deliberate: a service that has any generation becomes undeletable,
// and `desiredState='deleted'` is the tombstone. That is consistent with the frozen
// authority, where `deleted` has no outgoing transitions.
//
// There is deliberately NO `services.current_generation_id` pointing back here. That would
// form a non-deferrable RI cycle whose delete-ordering semantics nobody verified, and it is
// unnecessary: the current generation resolves by (organization_id, service_id,
// services.generation) against `service_generations_service_generation_uq`. The cost is one
// uniqueness invariant that lives in a test rather than a constraint, stated because no
// cross-table CHECK can express it.
//
// There is also deliberately NO `actor_context_policy_id`. The Outcome names an
// "actor/context policy reference", but there is nothing to point it at: `MemoryActor` has
// no `service` kind, no memory or context operation exists among the ten frozen worker
// operations, and the only candidate host-side pre-stage has zero production callers. A
// column nothing reads would make clause (b) vacuously true. Deferred to SVC-003 by name;
// see docs/replatform/epics/E9-service-agents/tickets/SVC-001-design.md section 4.
export const serviceGenerations = pgTable(
  "service_generations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // Denormalized, and load-bearing: `aoa.organization_id` is the only GUC, so company
    // scoping is necessarily app-layer and this column is the sole company predicate any
    // later reader has. Its integrity comes from the triple-composite FK below, never from
    // a single-column FK (which would bypass RLS and leak cross-tenant existence, E2-F013).
    companyId: uuid("company_id").notNull(),
    serviceId: uuid("service_id").notNull(),
    // Plain integer, never serial/IDENTITY: a sequence is a separate relation the
    // exact-match relation-ACL model would have to account for, for no benefit.
    generation: integer("generation").notNull(),
    // The definition this generation froze: command, args, env references, restart policy,
    // desired replicas (1 for now). Opaque here; validated at the API boundary against the
    // frozen `serviceWorkloadV1Schema` shape.
    definition: jsonb("definition").notNull(),
    // TTL is CONTROL-PLANE state (SVC-001 decision "C-prime"). It is deliberately NOT
    // mirrored into the job workload: `serviceWorkloadV1Schema` is frozen and .strict(),
    // and a worker has no channel on which to receive a time bound at all - control_command
    // is ACK-only, and the lease-renew response carries only `cancelRequested`. Enforcement
    // is the reconciler issuing requestCancellation({graceful:true}); latency is bounded by
    // the lease-renewal cadence, NOT instant, so SVC-005 must assert a bound.
    ttlSeconds: integer("ttl_seconds"),
    // Restore INPUT pointer only. Storage for a checkpoint a run PRODUCES is not built here
    // - and cannot be yet: `job_control_commands_kind_check` permits five of the frozen six
    // command kinds, omitting `checkpoint` entirely, so a checkpoint request cannot even be
    // persisted. Handed to SVC-004 by name. No FK: `job_artifacts` has only PARTIAL unique
    // indexes, which cannot be FK targets.
    checkpointArtifactId: uuid("checkpoint_artifact_id"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    organizationIdx: index("service_generations_organization_idx").on(table.organizationId),
    serviceIdx: index("service_generations_service_idx").on(table.organizationId, table.serviceId),
    // The invariant that replaces `services.current_generation_id`: one row per
    // (service, generation), so the current generation resolves by lookup.
    serviceGenerationUq: unique("service_generations_service_generation_uq").on(
      table.organizationId,
      table.serviceId,
      table.generation,
    ),
    // FK-target composite, so later tables can bind to a generation without a
    // single-column FK.
    orgIdUq: unique("service_generations_org_id_uq").on(table.organizationId, table.id),
    // ★ RESTRICT, never CASCADE — see the header. This is the SOLE parent FK and it proves
    // generation <-> service <-> company <-> org all share one tenant.
    orgCompanyServiceFk: foreignKey({
      columns: [table.organizationId, table.companyId, table.serviceId],
      foreignColumns: [services.organizationId, services.companyId, services.id],
      name: "service_generations_org_company_service_fk",
    }).onDelete("restrict"),
  }),
);

export type ServiceGeneration = typeof serviceGenerations.$inferSelect;
export type NewServiceGeneration = typeof serviceGenerations.$inferInsert;
