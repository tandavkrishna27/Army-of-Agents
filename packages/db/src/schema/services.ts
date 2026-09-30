import { pgTable, uuid, text, integer, timestamp, index, check, unique, foreignKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./organizations.js";
import { companies } from "./companies.js";

// Service desired-state row (E2-D06). Rich service columns are deferred to E3
// (additive). Like `jobs`, BOTH tenant identities are MANDATORY and
// NON-DEFAULTED — no sentinel-org fail-open: an insert that omits either FK
// fails the NOT NULL constraint (fail-closed). organization_id / company_id use
// ON DELETE RESTRICT so a tenant cannot be torn down while it still owns
// services (teardown is out of scope). TEN-004 adds the composite
// (organization_id, company_id) FK proving service↔company↔org share a tenant.
export const services = pgTable(
  "services",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // TEN-004/E2-F013: NO single-column FK to companies.id — the composite
    // `services_org_company_fk` (below) is the SOLE parent FK and carries ON DELETE
    // RESTRICT (E2-D09). A redundant single-column parent FK is a cross-tenant
    // existence oracle (FK checks bypass RLS). organization_id keeps its FK.
    companyId: uuid("company_id").notNull(),
    desiredState: text("desired_state").notNull().default("running"),
    generation: integer("generation").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    organizationIdx: index("services_organization_idx").on(table.organizationId),
    organizationCompanyIdx: index("services_organization_company_idx").on(
      table.organizationId,
      table.companyId,
    ),
    // SVC-001: reconciled against the FROZEN authority `SERVICE_DESIRED_STATES`
    // (packages/worker-protocol states.ts). `paused` was previously OMITTED, which made
    // SVC-005's pause/resume unstorable. This list is hand-written because packages/db
    // does NOT depend on worker-protocol; the reconciliation is asserted server-side in
    // service-desired-state-schema.integration.test.ts, which imports both.
    desiredStateValid: check(
      "services_desired_state_check",
      sql`desired_state IN ('running', 'paused', 'stopped', 'deleted')`,
    ),
    // TEN-004: FK-target composite unique so `service_instances` can bind
    // (organization_id, service_id) → services(organization_id, id).
    orgIdUq: unique("services_org_id_uq").on(table.organizationId, table.id),
    // SVC-001: FK-target TRIPLE composite so `service_generations` can bind
    // (organization_id, company_id, service_id) -> services(organization_id, company_id, id).
    // Two INDEPENDENT FKs would not do: nothing would tie a generation's company to its
    // SERVICE's company, so a generation could carry company B while its service belongs to
    // company A, both inside org X, with every constraint satisfied. Company scoping is
    // necessarily app-layer (aoa.organization_id is the ONLY GUC), which makes the
    // denormalized company_id the sole company predicate any later reader has - so its
    // integrity is the whole guarantee. Same shape as `jobs_org_company_id_uq`.
    orgCompanyIdUq: unique("services_org_company_id_uq").on(
      table.organizationId,
      table.companyId,
      table.id,
    ),
    // TEN-004: composite org-scoped FK — a service's (organization_id,
    // company_id) must exist together in companies(organization_id, id), so a
    // service cannot pair org A with a company owned by org B. The redundant single-column
    // company FK was DROPPED in E2-F013 (0212) — it bypassed RLS and leaked cross-tenant
    // existence; this composite is the SOLE company FK, ON DELETE restrict (E2-D09).
    orgCompanyFk: foreignKey({
      columns: [table.organizationId, table.companyId],
      foreignColumns: [companies.organizationId, companies.id],
      name: "services_org_company_fk",
    }).onDelete("restrict"),
  }),
);

export type Service = typeof services.$inferSelect;
export type NewService = typeof services.$inferInsert;
