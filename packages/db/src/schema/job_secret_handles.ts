import { pgTable, uuid, text, timestamp, integer, index, foreignKey } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { jobs } from "./jobs.js";

// Minimal opaque secret-HANDLE ownership index for a job (E2-D06). This is a
// skeleton so TEN-004 can constrain secret-handle↔job within one tenant; the RICH
// secret model (materialization, canaries, rotation) is deferred to E5
// (additive). `handle` is an opaque secret-handle id — no materialized secret
// value ever lands here. organization_id is DENORMALIZED (NOT NULL, no default)
// so TEN-004 can add the composite FK to (jobs.organization_id, jobs.id). At
// TEN-001b only the plain job_id FK (ON DELETE CASCADE — handles die with their
// job) + the denormalized organization_id column exist; the composite FK is
// TEN-004.
export const jobSecretHandles = pgTable(
  "job_secret_handles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // TEN-004/E2-F013: NO single-column FK to jobs.id — the composite
    // `job_secret_handles_org_job_fk` (below) is the SOLE parent FK and carries ON
    // DELETE CASCADE (E2-D09). A redundant single-column parent FK is a cross-tenant
    // existence oracle (FK checks bypass RLS). organization_id keeps its FK.
    jobId: uuid("job_id").notNull(),
    handle: text("handle").notNull(),
    // DAT-004 — the RICH secret-handle model (E5, additive). Every column below is
    // NULLABLE and NON-SECRET: the resolver maps an opaque handle onto one of the four
    // existing value stores and resolves the value BEHIND the fence — NO materialized
    // secret value ever lands in this table (invariant #3/#4). Nullable additions
    // inherit the whole-table `aoa_app` grant + FORCE-RLS policy (0211) with zero
    // keystone reconciliation (DAT-004-D1).
    //
    // `ref_kind` — the non-secret discriminator selecting the legacy broker:
    //   company_secret | connector_oauth | provider_key | device_local.
    refKind: text("ref_kind"),
    // `ref_id` — the non-secret pointer into the chosen broker (company_secrets.id /
    //   mcp:oauth:<id> name / provider:<id> name / provider_credentials.id-or-slug).
    //   NEVER a value.
    refId: text("ref_id"),
    // Denormalized owner (from the job at mint) for device_local / owner-bound handles.
    ownerPrincipalKind: text("owner_principal_kind"),
    ownerPrincipalId: text("owner_principal_id"),
    // Mirror the frozen wire ref so the resolver RE-CHECKS the sandbox-vs-proxy
    // invariant server-side (defense in depth against a hand-built envelope).
    materialization: text("materialization"), // proxy | env | file
    // DAT-008 — the materialization TARGET the frozen wire ref carries alongside the
    // kind: an env-var NAME for `env`, a sandbox path for `file`, and NULL for `proxy`
    // (whose wire arm is `.strict()` with no target at all). It is a NAME, never a
    // value. Without it the envelope could not be rebuilt: `{kind:"env"}` alone is not
    // a valid `secretMaterializationSchema` member, and for a handle pointing at an
    // AGENT's own secret the env-var name is not derivable from `ref_id`.
    // Nullable additive widen of an already-distributed table — inherits the existing
    // whole-table `aoa_app` grant + FORCE-RLS policy with no keystone reconciliation.
    materializationTarget: text("materialization_target"),
    // DAT-008 — the PINNED version of `ref_id` for a `company_secret` handle bound to
    // an agent's own secret_ref. The legacy runtime path honours an explicitly pinned
    // version (`resolveEnvBindings` passes `binding.version`), so resolving `latest`
    // instead would silently move a pinned agent onto a different secret version.
    // NULL means "latest", which is also the canonical default for an unpinned ref.
    // Text, not integer: the selector is `number | "latest"`.
    refVersion: text("ref_version"),
    usePolicy: text("use_policy"), // fence_proxy | remote_server_fenced | sandbox_local_only
    // The bound egress destination / networkPolicyRef — DAT-004 BINDS; DAT-005 ENFORCES.
    destination: text("destination"),
    // D5 — pin the handle to its placed target generation (defense in depth over the
    // lease-level generation cutoff in guardActiveFence). Null = unpinned.
    boundTargetGeneration: integer("bound_target_generation"),
    // DAT-005-D3 — the network-policy version applied at the last governed egress
    // resolve. `network_denied` cannot carry a version (frozen wire) and the version
    // is a frozen job-side concept (`networkPolicyRef.version`), so it is recorded
    // here server-side, written by `resolveExecutionSecret` in the SAME audit UPDATE
    // as last_resolved_at/resolve_count. Nullable additive (no keystone
    // reconciliation) — never a secret value.
    appliedPolicyVersion: integer("applied_policy_version"),
    // Audit-as-columns (DAT-004-D4): control-plane status + resolve audit, never a
    // value. `status` defaults to 'active' at mint (nullable for the additive widen).
    status: text("status"),
    lastResolvedAt: timestamp("last_resolved_at", { withTimezone: true }),
    resolveCount: integer("resolve_count"),
    // VESTIGIAL AND UNREAD — kept ON PURPOSE, do not delete without reading the note.
    //
    // DE-07's founder ruling (2026-09-09) retired this column as a revocation lever:
    // it shipped with ZERO writers tree-wide, and its single reader ANDed it with
    // `status = 'active'`, so it could never independently deny anything. That reader
    // conjunct is GONE (listActiveExecutionSecretHandles, job-control.ts) — nothing in
    // the tree reads `revokedAt` any more. Device-grained revocation is the cutoff
    // (revokeWorker -> bumpExecutionTargetGeneration -> the `target_revoked` deny), and
    // `status` is the per-handle surface a future revocation arms with ONE mutator
    // (`authorizeSecretResolve`'s `if (h.status !== "active") return "handle_revoked"`,
    // job-fence.ts:293).
    //
    // The DECLARATION stays because the DROP cannot ship in the same release as the
    // reader removal. `scripts/deploy/remote-compose-deploy.sh` rolls the BINARY back
    // on a failed deploy (on_exit -> rollback_previous) and reverts NO schema, so an
    // N-1 binary would come back up selecting `revoked_at` against a table that no
    // longer has it and every secret-handle operation would fail. This is the EXPAND
    // half of expand/contract; the CONTRACT (drop the column) is scheduled for a later
    // release, once the N-1 rollback window has closed — i.e. once no deployable binary
    // still names this column. Tracked as E0-F017.
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    organizationIdx: index("job_secret_handles_organization_idx").on(table.organizationId),
    jobIdx: index("job_secret_handles_job_idx").on(table.jobId),
    // TEN-004: composite org-scoped FK — a secret handle's (organization_id,
    // job_id) must exist together in jobs(organization_id, id), so a handle
    // cannot be owned by a different tenant than its job. The redundant single-column job
    // FK was DROPPED in E2-F013 (0212) — it bypassed RLS and leaked cross-tenant existence;
    // this composite is the SOLE job FK, ON DELETE cascade (E2-D09).
    orgJobFk: foreignKey({
      columns: [table.organizationId, table.jobId],
      foreignColumns: [jobs.organizationId, jobs.id],
      name: "job_secret_handles_org_job_fk",
    }).onDelete("cascade"),
  }),
);

export type JobSecretHandle = typeof jobSecretHandles.$inferSelect;
export type NewJobSecretHandle = typeof jobSecretHandles.$inferInsert;
