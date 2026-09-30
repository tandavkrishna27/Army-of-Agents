import { pgTable, uuid, text, integer, timestamp, jsonb, index, uniqueIndex, check, unique, foreignKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { authUsers } from "./auth.js";
import { executionTargets } from "./execution_targets.js";
import { organizations } from "./organizations.js";

// Worker / execution-target registration identity (E2-D06). Rich worker columns
// (JOB-002, E3) are deferred (additive). `scope` follows the program-design
// `platform | organization | owner` model:
//   - `platform`  → cross-tenant infrastructure worker; organization_id IS NULL
//                   (a tenant GUC never matches NULL under forced RLS → these are
//                   operator-only, never tenant-visible; the operator-read policy
//                   shape is TEN-002).
//   - `organization` / `owner` → tenant-bound; organization_id IS NOT NULL.
// The `workers_scope_org_check` constraint enforces exactly that pairing at write
// time. organization_id is therefore the ONE new-path table that is legitimately
// NULLABLE (contrast the mandatory identity on jobs/services) — but it uses
// ON DELETE RESTRICT so a tenant cannot be torn down while it still owns workers.
// `owner_user_id` is reserved for the `owner`-scope binding JOB-002 adds later —
// deliberately NO FK at E2 (JOB-002 binds it to the identity source it chooses).
export const workers = pgTable(
  "workers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: text("scope").notNull(),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "restrict",
    }),
    ownerUserId: text("owner_user_id"),
    executionTargetId: uuid("execution_target_id").notNull(),
    targetAuthorityKey: text("target_authority_key").notNull(),
    devicePublicKey: text("device_public_key"),
    deviceThumbprint: text("device_thumbprint"),
    deviceGeneration: integer("device_generation").notNull().default(1),
    profileHash: text("profile_hash"),
    // JOB-009: the exact proof-bound E1 hello whose digest is profile_hash.
    // Dynamic poll capacity may only replace the capacity member after session
    // proof; it cannot widen these enrolled capabilities or policy facts.
    profileSnapshot: jsonb("profile_snapshot").$type<Record<string, unknown>>(),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    label: text("label").notNull(),
    status: text("status").notNull().default("enrolled"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    organizationIdx: index("workers_organization_idx").on(table.organizationId),
    targetIdx: index("workers_execution_target_idx").on(table.executionTargetId),
    scopeValid: check(
      "workers_scope_check",
      sql`scope IN ('platform', 'organization', 'owner')`,
    ),
    statusValid: check(
      "workers_status_check",
      sql`status IN ('enrolled', 'active', 'draining', 'revoked')`,
    ),
    scopeOrgValid: check(
      "workers_scope_org_check",
      sql`(scope = 'platform' AND organization_id IS NULL) OR (scope IN ('organization', 'owner') AND organization_id IS NOT NULL)`,
    ),
    scopeOwnerValid: check(
      "workers_scope_owner_check",
      sql`(scope = 'owner' AND owner_user_id IS NOT NULL) OR (scope IN ('platform', 'organization') AND owner_user_id IS NULL)`,
    ),
    targetScopeValid: check(
      "workers_target_scope_check",
      sql`(
        scope = 'platform' AND target_authority_key = 'platform'
      ) OR (
        scope = 'organization' AND (
          target_authority_key = 'platform' OR target_authority_key = 'organization:' || organization_id::text
        )
      ) OR (
        scope = 'owner' AND target_authority_key = 'owner:' || organization_id::text || ':' || owner_user_id
      )`,
    ),
    deviceIdentityValid: check(
      "workers_device_identity_check",
      sql`status = 'revoked' OR (
        device_public_key IS NOT NULL AND device_thumbprint IS NOT NULL AND profile_hash IS NOT NULL AND enrolled_at IS NOT NULL
      )`,
    ),
    // TEN-004: FK-target composite unique so future org-owned children (JOB-002,
    // E3) can bind (organization_id, id). organization_id is nullable here
    // (platform rows), but `id` is the PK so the pair is unique regardless; NULLs
    // are distinct under the default UNIQUE semantics, so multiple platform
    // (null-org) workers coexist freely.
    orgIdUq: unique("workers_org_id_uq").on(table.organizationId, table.id),
    orgIdAuthorityTargetUq: unique("workers_org_id_authority_target_uq").on(
      table.organizationId,
      table.id,
      table.targetAuthorityKey,
      table.executionTargetId,
    ),
    targetAuthorityFk: foreignKey({
      columns: [table.targetAuthorityKey, table.executionTargetId],
      foreignColumns: [executionTargets.targetAuthorityKey, executionTargets.id],
      name: "workers_target_authority_fk",
    }).onDelete("restrict"),
    ownerUserFk: foreignKey({
      columns: [table.ownerUserId],
      foreignColumns: [authUsers.id],
      name: "workers_owner_user_fk",
    }).onDelete("restrict"),
    platformTargetUq: uniqueIndex("workers_platform_target_uq")
      .on(table.executionTargetId)
      .where(sql`${table.scope} = 'platform'`),
    organizationTargetUq: uniqueIndex("workers_organization_target_uq")
      .on(table.organizationId, table.executionTargetId)
      .where(sql`${table.scope} = 'organization'`),
    ownerTargetUq: uniqueIndex("workers_owner_target_uq")
      .on(table.organizationId, table.executionTargetId, table.ownerUserId)
      .where(sql`${table.scope} = 'owner'`),
  }),
);

export type Worker = typeof workers.$inferSelect;
export type NewWorker = typeof workers.$inferInsert;
