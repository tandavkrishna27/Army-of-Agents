import {
  pgTable, uuid, text, timestamp, jsonb, index, unique, check, foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { authUsers } from "./auth.js";
import { executionTargets } from "./execution_targets.js";
import { organizations } from "./organizations.js";

/** Tenant/platform authoritative, single-use enrollment secret and replay result. */
export const workerEnrollmentCodes = pgTable(
  "worker_enrollment_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    ownerUserId: text("owner_user_id").references(() => authUsers.id, { onDelete: "restrict" }),
    executionTargetId: uuid("execution_target_id").notNull(),
    targetAuthorityKey: text("target_authority_key").notNull(),
    locatorHash: text("locator_hash").notNull(),
    secretHash: text("secret_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    semanticIdempotencyKey: text("semantic_idempotency_key"),
    semanticDigest: text("semantic_digest"),
    deviceThumbprint: text("device_thumbprint"),
    semanticResult: jsonb("semantic_result").$type<Record<string, unknown>>(),
    createdByPrincipalKind: text("created_by_principal_kind").notNull(),
    createdByPrincipalId: text("created_by_principal_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    locatorUq: unique("worker_enrollment_codes_locator_uq").on(table.locatorHash),
    targetAuthorityFk: foreignKey({
      columns: [table.targetAuthorityKey, table.executionTargetId],
      foreignColumns: [executionTargets.targetAuthorityKey, executionTargets.id],
      name: "worker_enrollment_codes_target_authority_fk",
    }).onDelete("restrict"),
    scopeValid: check(
      "worker_enrollment_codes_scope_check",
      sql`(
        scope = 'platform' AND organization_id IS NULL AND owner_user_id IS NULL AND target_authority_key = 'platform'
      ) OR (
        scope = 'organization' AND organization_id IS NOT NULL AND owner_user_id IS NULL AND
        (target_authority_key = 'platform' OR target_authority_key = 'organization:' || organization_id::text)
      ) OR (
        scope = 'owner' AND organization_id IS NOT NULL AND owner_user_id IS NOT NULL AND
        target_authority_key = 'owner:' || organization_id::text || ':' || owner_user_id
      )`,
    ),
    digestValid: check(
      "worker_enrollment_codes_digest_check",
      sql`locator_hash ~ '^[0-9a-f]{64}$' AND secret_hash ~ '^[0-9a-f]{64}$' AND
        (semantic_digest IS NULL OR semantic_digest ~ '^[0-9a-f]{64}$') AND
        (device_thumbprint IS NULL OR device_thumbprint ~ '^[0-9a-f]{64}$')`,
    ),
    resultAtomic: check(
      "worker_enrollment_codes_result_atomic_check",
      sql`(
        consumed_at IS NULL AND semantic_idempotency_key IS NULL AND semantic_digest IS NULL AND
        device_thumbprint IS NULL AND semantic_result IS NULL
      ) OR (
        consumed_at IS NOT NULL AND semantic_idempotency_key IS NOT NULL AND semantic_digest IS NOT NULL AND
        device_thumbprint IS NOT NULL AND semantic_result IS NOT NULL
      )`,
    ),
    expiryIdx: index("worker_enrollment_codes_expiry_idx").on(table.organizationId, table.expiresAt),
    replayIdx: index("worker_enrollment_codes_replay_idx").on(
      table.organizationId, table.semanticIdempotencyKey, table.semanticDigest,
    ),
  }),
);

export type WorkerEnrollmentCode = typeof workerEnrollmentCodes.$inferSelect;
export type NewWorkerEnrollmentCode = typeof workerEnrollmentCodes.$inferInsert;
