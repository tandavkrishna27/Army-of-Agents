import { sql } from "drizzle-orm";
import { pgTable, uuid, text, jsonb, timestamp, integer, index, unique, check, foreignKey } from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";
import { organizations } from "./organizations.js"; // P1 (0188) — merged before P5

/**
 * Tenant-scoped execution-target registry (fleet inventory).
 *
 * P1 is merged first, so organizationId is a real FK now (M6-FK). It stays
 * NULLABLE: NULL organizationId = a system/shared target (the pooled gVisor row
 * and the seeded control-plane). ON DELETE CASCADE — deleting an org removes its
 * dedicated tenant targets outright. NULL == the security-defining "system/shared,
 * operator-trusted" signal (cross-tenant visible, custom isolation profile
 * allowed), so SET NULL would silently PROMOTE a deleted tenant's dedicated
 * targets into trusted shared infra; cascading them away is the only safe
 * behaviour. System rows (organization_id IS NULL) are never children of any org,
 * so an org delete never touches them — they never survive as tenant rows and
 * tenant rows never survive as system rows. `slug` matches the
 * AOA_EXECUTION_TARGET_ID string that provider_credentials rows bind to.
 */
export const executionTargets = pgTable(
  "execution_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }), // nullable = system/shared; org delete cascades tenant targets (they never survive as system rows)
    ownerUserId: text("owner_user_id"),
    // Nullable in the first generated migration so pre-E3 rows can be
    // deterministically backfilled before the follow-up NOT NULL migration.
    scope: text("scope").notNull(),
    targetAuthorityKey: text("target_authority_key").notNull(),
    deviceGeneration: integer("device_generation").notNull().default(1),
    slug: text("slug").notNull(),
    kind: text("kind").notNull(), // pooled_gvisor | dedicated_worker | e2b | local_host | desktop
    trustClass: text("trust_class").notNull(), // shared_multitenant | dedicated_tenant | local_trusted
    status: text("status").notNull().default("active"), // active | draining | offline | disabled
    capabilities: jsonb("capabilities").$type<Record<string, unknown>>().notNull().default({}),
    // JOB-009: exact server-owned E1 target/provider profiles. Nullable legacy
    // rows are deliberately unmapped and therefore ineligible, never inferred.
    registeredProfile: jsonb("registered_profile").$type<Record<string, unknown>>(),
    registeredProfileHash: text("registered_profile_hash"),
    providerConstraintProfile: jsonb("provider_constraint_profile").$type<Record<string, unknown>>(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    // Finding #3: rotatable worker credential — SHA-256 hash only; the plaintext
    // is returned once at registration. The row id is no longer a credential.
    workerTokenHash: text("worker_token_hash"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // M5: system rows have organization_id = NULL. Default NULLS DISTINCT would
    // let every NULL-org slug collide-never, so the control-plane seed and any
    // org-null pooled_gvisor row would DUPLICATE on every boot. NULLS NOT
    // DISTINCT (PG15+) makes NULL == NULL so (NULL, "control-plane") is unique
    // and onConflictDoNothing matches. Mirrors provider_quota_windows.ts:48-55.
    orgSlugUq: unique("execution_targets_org_slug_uq")
      .on(table.organizationId, table.slug)
      .nullsNotDistinct(),
    kindStatusIdx: index("execution_targets_kind_status_idx").on(table.kind, table.status),
    orgIdx: index("execution_targets_org_idx").on(table.organizationId),
    authorityIdUq: unique("execution_targets_authority_id_uq").on(table.targetAuthorityKey, table.id),
    authorityScopeValid: check(
      "execution_targets_authority_scope_check",
      sql`(
        scope = 'platform' AND organization_id IS NULL AND owner_user_id IS NULL AND target_authority_key = 'platform'
      ) OR (
        scope = 'organization' AND organization_id IS NOT NULL AND owner_user_id IS NULL AND
        target_authority_key = 'organization:' || organization_id::text
      ) OR (
        scope = 'owner' AND organization_id IS NOT NULL AND owner_user_id IS NOT NULL AND
        target_authority_key = 'owner:' || organization_id::text || ':' || owner_user_id
      )`,
    ),
    placementProfilesAtomic: check(
      "execution_targets_placement_profiles_atomic_check",
      sql`(
        registered_profile IS NULL AND registered_profile_hash IS NULL AND provider_constraint_profile IS NULL
      ) OR (
        registered_profile IS NOT NULL AND registered_profile_hash ~ '^[0-9a-f]{64}$' AND
        provider_constraint_profile IS NOT NULL
      )`,
    ),
    ownerUserFk: foreignKey({
      columns: [table.ownerUserId],
      foreignColumns: [authUsers.id],
      name: "execution_targets_owner_user_fk",
    }).onDelete("restrict"),
  }),
);
