import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { environments } from "./environments.js";
import { environmentLeases } from "./environment_leases.js";

// MIG-008 (E10 desktop-migration): the durable, APPEND-ONLY crosswalk that records
// the pre-cutover reconciliation of every legacy `environment_leases` row + the
// platform-default `environments` resource into exactly ONE mapping OR terminal
// cleanup record. This is the closure store the reconciler asserts against.
//
// SECURITY MODEL (custom RLS migration, C14 / Decision #122; mirrors the DEP-003
// cutover marker 0233 operator-metadata shape — the MIG-008 reconciler is a
// SERVER-SIDE system/operator pass, NOT a per-tenant-request writer):
//   - `aoa_operator` WRITE (SELECT/INSERT/UPDATE, no DELETE — records are durable)
//     — two operator-authored entrypoints write these rows and nothing else does: the
//     reconciliation PASS inserts (`cli/reconcile-legacy-resources.ts`), and the
//     `unattributable` REMEDY updates exactly one record
//     (`cli/resolve-unattributable-record.ts`, MIG-010 Unit 2.5). See APPEND-ONLY below.
//   - `aoa_app` READ-ONLY — the control plane reads the closure store to gate a
//     cutover, but only OUTSIDE a tenant transaction (read policy predicate is
//     `current_setting('aoa.organization_id', true) IS NULL`).
//   - tenants NONE — an aoa_app query WITH the tenant GUC set never matches the
//     read policy, so the crosswalk is invisible to every tenant.
//   - FORCE ROW LEVEL SECURITY — defense-in-depth against a non-superuser owner
//     mistake (E2-F004 rationale).
//
// COMPANY-SCOPED (not org-scoped): the source (`environment_leases`) is
// company-scoped and closure is asserted per-company, so `companyId` is the data
// key. It is NOT the RLS tenant key (this is operator-metadata infra, keyed like
// the platform cutover marker). A distributed `ResourceLabels`-org attribution is
// recorded as `resourceLabelsHash` (a partial-attribution hash ONLY — never a
// leasable live fence; MIG-008 Invariant #2).
//
// APPEND-ONLY, WITH EXACTLY ONE UPDATE PATH (MIG-010 Unit 2.5, E7-F006). Rows are
// still never deleted (no DELETE grant to any role) and the reconciliation PASS still
// only ever inserts — `insertRecordIfAbsent` is `onConflictDoNothing`, so it cannot
// rewrite its own verdict, which is what makes this store evidence rather than state.
//
// The operator UPDATE grant is therefore NO LONGER VESTIGIAL. Its sole consumer is
// `server/src/cli/resolve-unattributable-record.ts`, the narrow operator remedy for a
// record that nothing else could ever clear: `assertClosure` fails on ANY
// `unattributable` disposition, so one such record refused the canary gate PERMANENTLY,
// and ordinary agent deletion creates one (`agent_id` is ON DELETE SET NULL).
//
// WHAT THAT PATH MAY DO: transition ONE `(company_id, resource_key)` record from
// `unattributable` to `terminal_cleanup`, rewriting `reason` with an operator-supplied
// justification and stamping `cleanup_outcome = 'operator_resolved'`.
//
// WHAT IT MAY NOT DO, structurally: it may NEVER mint `mapped`. That disposition says
// "a live resource is accounted for and left for drain", and an operator asserting it
// about a resource nobody could classify is precisely the forgeable claim (design
// section 9.2). The target disposition is a file constant, not an argument, and the
// `AND disposition = 'unattributable'` predicate lives in the UPDATE's own WHERE clause
// — so the command is idempotent, cannot overwrite an already-resolved record, and
// cannot touch a `mapped` or `terminal_cleanup` row even when handed its key. It also
// asserts `current_user = 'aoa_operator'` before the write, and has no bulk mode.
//
// `resource_type` is deliberately left at its `unattributable` sentinel by that path:
// the row records both what the machine could not classify and what the human decided.
// `resourceKey` is the deterministic idempotency key (one record per resource):
// for a lease it is the lease id; for the platform-default env resource it is
// `platform-default-env:<environmentId>` (its uuidv5 id is never reminted).
export const legacyResourceReconciliation = pgTable(
  "legacy_resource_reconciliation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // Nullable FK: a mapped/terminal lease record points at its source lease; the
    // platform-default env resource has no lease (environmentId only).
    environmentLeaseId: uuid("environment_lease_id").references(() => environmentLeases.id, {
      onDelete: "set null",
    }),
    // Nullable: the environments row id (the lease's env, or the platform-default env).
    environmentId: uuid("environment_id").references(() => environments.id, { onDelete: "set null" }),
    // Deterministic idempotency key — one record per resource.
    resourceKey: text("resource_key").notNull(),
    // One of the 5 MIG-008 types: ephemeral | warm_org | warm_commander |
    // workspace_ref | platform_default_env.
    resourceType: text("resource_type").notNull(),
    // The source lease.status at reconcile time (null for the platform-default env resource).
    legacyStatus: text("legacy_status"),
    provider: text("provider"),
    providerLeaseId: text("provider_lease_id"),
    // 'mapped' | 'terminal_cleanup' | 'unattributable'.
    disposition: text("disposition").notNull(),
    // Partial-attribution hash for a mapping record ONLY — never a synthesized live fence.
    resourceLabelsHash: text("resource_labels_hash"),
    // The SECRET-AWARE key-generation identity ("<secretId>:<version>") this resource was
    // attributed with (D3). Secret-aware because runtime_provider_keys.secretId is
    // repointable + per-secret versions restart at 1, so a bare version is not monotonic
    // across a rotation. Null for an operator-env-default (ungenerationed) company.
    keyGeneration: text("key_generation"),
    // Written by the PASS as 'delegated_cli004' (failed prior cleanup, terminal via the
    // CLI-004 reconcile composition) or 'no_handle'; null on a mapping record. MIG-010
    // Unit 2.5 adds one value the pass never writes: 'operator_resolved', stamped by
    // `cli/resolve-unattributable-record.ts` so a human-asserted terminal record is
    // distinguishable from a machine-derived one. ('paused_snapshot_reconciled' was
    // listed here and is dead — Option R made every paused row `mapped`.)
    cleanupOutcome: text("cleanup_outcome"),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // --- operator resolution (MIG-010 Unit 2.5, Codex P1) -------------------------------
    // A resolved record previously carried a `terminal_cleanup` / `operator_resolved` verdict
    // whose ONLY timestamp was `createdAt` -- the PASS's insert time, which PREDATES the
    // decision it records. That is not merely missing, it is misleading to anyone
    // reconstructing an incident, and it is the one loss here that cannot be recovered from
    // anywhere else: no history table, no DELETE, and `legacy_reconciliation_passes` records
    // pass completions rather than resolutions.
    //
    // Set from the DATABASE clock in the same UPDATE that flips the disposition, so the
    // "atomically" requirement is satisfied by construction rather than by a transaction.
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    // ★ ATTESTATION, NOT AUTHENTICATION. This is a self-declared handle, exactly as forgeable
    // as the justification beside it. The only authenticated fact available to an operator CLI
    // is the role it connected as, which `assertOperatorRole` already establishes. Calling this
    // an identity would be a false claim of enforcement, which this programme treats as worse
    // than no check at all.
    resolvedBy: text("resolved_by"),
    // The operator's justification lives HERE rather than overwriting `reason`. `reason` is the
    // CLASSIFIER's verdict and the crosswalk is evidence; an operator's prose replacing it is a
    // write over evidence even when the overwritten string is a compile-time constant.
    resolutionReason: text("resolution_reason"),
  },
  (table) => ({
    // One record per resource: re-running the reconciler is idempotent.
    companyResourceKeyUq: uniqueIndex("legacy_resource_reconciliation_company_resource_key_uq").on(
      table.companyId,
      table.resourceKey,
    ),
    companyIdx: index("legacy_resource_reconciliation_company_idx").on(table.companyId),
    dispositionIdx: index("legacy_resource_reconciliation_disposition_idx").on(table.disposition),
  }),
);

export type LegacyResourceReconciliation = typeof legacyResourceReconciliation.$inferSelect;
export type NewLegacyResourceReconciliation = typeof legacyResourceReconciliation.$inferInsert;
