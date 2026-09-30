import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex, check, foreignKey } from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";
import { executionTargets } from "./execution_targets.js";
import { organizations } from "./organizations.js";

// DAT-006 — explicit LOCAL-FOLDER grant admission (E5). A folder grant is the durable
// `(owner_user, execution_target, declared base path, granted/revoked)` record the
// FROZEN `snapshotProvenance.folderGrantId` uuid resolves to server-side. It is
// permission to READ / STAGE the declared content into an isolated snapshot — NOT
// permission to keep writing to a live user folder after lease loss (accepted-caveats).
//
// It is a tenant-scoped, owner-grained record on a NEW per-table-RLS table (TEN-006
// pattern), NOT a widen of job_artifacts: wrong lifetime (durable, spans jobs),
// ownership grain (owner_user × execution_target), and cardinality. Modeled on
// `workers`: the composite FK to execution_targets(target_authority_key, id) + the
// `owner:<org>:<user>` authority-key CHECK bind a grant to exactly one owner desktop.
// organization_id is DENORMALIZED (NOT NULL) so the per-table tenant-isolation RLS
// policy predicate (organization_id = current_setting('aoa.organization_id')) is always
// well-defined. Distributed-flag-gated; inert until a capture/reconcile path reads it.
export const folderGrants = pgTable(
  "folder_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    ownerUserId: text("owner_user_id").notNull(),
    executionTargetId: uuid("execution_target_id").notNull(),
    targetAuthorityKey: text("target_authority_key").notNull(),
    deviceGeneration: integer("device_generation").notNull().default(1),
    // The value the frozen `snapshotProvenance.folderGrantId` resolves to. Unique so a
    // captured snapshot's folderGrantId maps to exactly one grant row.
    folderGrantId: uuid("folder_grant_id").notNull().defaultRandom(),
    // The declared base the grant admits reads/staging for. A captured path is admitted
    // only when it is a safe relative path WITHIN this base (resolver, DAT-006).
    declaredBasePath: text("declared_base_path").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    organizationIdx: index("folder_grants_organization_idx").on(table.organizationId),
    targetIdx: index("folder_grants_target_idx").on(table.executionTargetId),
    // A folder grant is always OWNER-scoped to a desktop: the authority key MUST be the
    // canonical `owner:<org>:<user>` form (mirrors the workers/execution_targets owner
    // authority-key convention). No platform/organization folder grants exist.
    ownerAuthorityValid: check(
      "folder_grants_owner_authority_check",
      sql`target_authority_key = 'owner:' || organization_id::text || ':' || owner_user_id`,
    ),
    // The folderGrantId resolves 1:1.
    folderGrantIdUq: uniqueIndex("folder_grants_folder_grant_id_uq").on(table.folderGrantId),
    // Admission natural key: at most one ACTIVE (non-revoked) grant per
    // (org, execution_target, owner, declared base) — a replayed admission of the same
    // base is idempotent (DO-NOTHING), and a revoked grant does not block re-admission.
    activeBaseUq: uniqueIndex("folder_grants_active_base_uq")
      .on(table.organizationId, table.executionTargetId, table.ownerUserId, table.declaredBasePath)
      .where(sql`revoked_at IS NULL`),
    // Composite org-scoped FK to the owner desktop's execution target — a grant cannot
    // reference a target with a different (target_authority_key, id) pair. ON DELETE
    // restrict (a target with live grants is not silently dropped). Mirrors
    // workers_target_authority_fk.
    targetAuthorityFk: foreignKey({
      columns: [table.targetAuthorityKey, table.executionTargetId],
      foreignColumns: [executionTargets.targetAuthorityKey, executionTargets.id],
      name: "folder_grants_target_authority_fk",
    }).onDelete("restrict"),
    ownerUserFk: foreignKey({
      columns: [table.ownerUserId],
      foreignColumns: [authUsers.id],
      name: "folder_grants_owner_user_fk",
    }).onDelete("restrict"),
  }),
);

export type FolderGrant = typeof folderGrants.$inferSelect;
export type NewFolderGrant = typeof folderGrants.$inferInsert;
