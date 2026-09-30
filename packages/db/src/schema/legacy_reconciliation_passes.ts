import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { organizations } from "./organizations.js";

// MIG-010 Unit 2.4 (BLOCKER E-2/E-3): the durable MARKER of a COMPLETED legacy
// reconciliation pass, one row per Company per pass.
//
// WHY A SEPARATE TABLE AND NOT A COLUMN ON THE CROSSWALK. Design
// `2026-09-01-blocker-e-2-e-3-design.md` §10.4 ruled out all three storage shortcuts and
// each rejection is a defect avoided, not a preference:
//   * a watermark COLUMN on `legacy_resource_reconciliation` cannot express "the latest
//     COMPLETED pass" — the crosswalk is append-only per RESOURCE, so a column would say
//     when a record was written, never when a pass finished;
//   * a synthetic ROW in the crosswalk silently enters two gate predicates (the closure
//     inventory and the superseded-generation filter), so the marker would change the
//     verdict it exists to qualify;
//   * a per-record watermark newly BRICKS companies that pass the gate today.
//
// WHAT THE COLUMNS ARE DERIVED FROM. §11.4: *"latest marker" only means "latest COMPLETED
// pass" if the marker records completion, scope and identity.* So:
//   * completion  -> `completedAt`, and a row exists ONLY for a completed pass (it is the
//                    pass's LAST write for that Company). A crash between the records and
//                    the marker leaves "records, no marker", which the gate reads as NOT
//                    reconciled — the fail-closed direction, and a re-run completes it.
//   * scope       -> `organizationId` + `companyId`. The pass is organization-scoped
//                    (`reconcileOrganizationLegacyResources`, Unit 2.3) while closure is
//                    company-scoped, so both are facts about this marker.
//   * identity    -> `passId`, one value per pass INVOCATION, shared by every Company
//                    marker that invocation writes. It is what makes "these markers came
//                    from the same pass" checkable rather than inferred from timestamps.
//   * the instant -> `snapshotAt`, read from the DATABASE clock before the pass lists
//                    anything. This is the watermark: the gate narrows its lease inventory
//                    to `created_at <= snapshotAt` (Unit 2.4b).
//
// ★★★ `keyGeneration` IS `NOT NULL`, WITH AN EXPLICIT `'ungenerationed'` SENTINEL.
// Design §13, and it is not a style choice. `key_generation` is nullable everywhere else in
// this system — `deriveE2bKeyGeneration` returns null for a company with no default e2b
// `runtime_provider_keys` row, and the crosswalk column is documented "Null for an
// operator-env-default (ungenerationed) company". The shipped gate's
// `r.keyGeneration !== null && r.keyGeneration !== current` filter therefore treats a NULL
// record as NOT superseded (filed as E7-F005), and a NULLABLE marker column would
// CONCENTRATE that hole: today it takes every record being NULL, whereas one NULL marker row
// would disable the staleness check outright. Make the NULL unrepresentable here, and compare
// with `IS DISTINCT FROM` semantics anyway — belt and braces, deliberately.
//
// The sentinel cannot collide with a real generation: those are `<secretId>:<version>`
// (`formatKeyGeneration`), i.e. always a uuid followed by a colon.
//
// SECURITY MODEL (custom RLS migration, C14 / Decision #122):
//   - `aoa_operator` WRITE (SELECT/INSERT, no UPDATE, no DELETE) — markers are durable
//     EVIDENCE of a completed pass. A pass that could rewrite its own marker is not
//     evidence, which is the same argument that keeps the crosswalk append-only (§9.2).
//   - `aoa_app` NONE. ★ This is a DELIBERATE NARROWING versus the three operator-metadata
//     precedents (`distributed_cutover_markers` 0233, `execution_target_revocations` 0239,
//     `legacy_resource_reconciliation` 0256), which all grant aoa_app SELECT. Nothing on the
//     aoa_app pool reads this marker: the canary gate runs on the OPERATOR pool (Unit 1.7
//     moved EXECUTE there) and so does the pass. BLOCKER E-1's lesson is that the GRANTEE is
//     the boundary, so a grant with no reader is authority given away for symmetry. If a
//     control-plane reader ever appears, add the grant THEN, in its own reviewed diff.
//   - tenants NONE — no aoa_app policy exists at all, so there is nothing for a tenant
//     transaction to match.
//   - FORCE ROW LEVEL SECURITY — defence in depth against a non-superuser owner mistake
//     (E2-F004 rationale), consistent with every other relation in RLS_RELATIONS.
export const legacyReconciliationPasses = pgTable(
  "legacy_reconciliation_passes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // IDENTITY. One value per pass invocation, shared across every Company it completes.
    passId: uuid("pass_id").notNull(),
    // SCOPE. The organization the pass ran for.
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // SCOPE. The company this marker completes. Closure is company-scoped.
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    // THE WATERMARK. Read from the DATABASE clock (`now()`, i.e. transaction start) before
    // the pass lists anything, so a lease whose transaction opened before this instant
    // carries `created_at <= snapshotAt` and stays IN scope even if it commits later — the
    // fail-closed direction (measured in mig-010-unit-2-4-probes.integration.test.ts).
    snapshotAt: timestamp("snapshot_at", { withTimezone: true }).notNull(),
    // The provider-control generation observed at pass start, or `'ungenerationed'`.
    // NOT NULL by design — see the E7-F005 note above.
    keyGeneration: text("key_generation").notNull(),
    // COMPLETION. Written with the row, which is the pass's last write for this Company.
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // One marker per Company per pass invocation: a re-entrant pass cannot double-mark, and
    // a retry that reuses the pass id converges instead of accumulating.
    passCompanyUq: uniqueIndex("legacy_reconciliation_passes_pass_company_uq").on(
      table.passId,
      table.companyId,
    ),
    // The gate's read is "the latest COMPLETED pass for this Company".
    companyCompletedIdx: index("legacy_reconciliation_passes_company_completed_idx").on(
      table.companyId,
      table.completedAt,
    ),
  }),
);

export type LegacyReconciliationPass = typeof legacyReconciliationPasses.$inferSelect;
export type NewLegacyReconciliationPass = typeof legacyReconciliationPasses.$inferInsert;
