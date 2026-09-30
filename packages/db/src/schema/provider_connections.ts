import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";
import { organizations } from "./organizations.js";
import { authUsers } from "./auth.js";

/**
 * The credential of record: WHO owns WHAT auth, WHERE it executes.
 *
 * `organization_id` FKs `organizations` (P1 is merged first). `company_id` NULL ⇒
 * an org-level connection shared to every company in the organization. Provider-
 * native subscription material is NEVER stored here (secret_ref stays NULL for
 * personal_subscription); it lives in the scoped on-disk auth home the
 * subscription ladder derives (cli-auth-topology.ts:172).
 *
 * SCOPE (beta): only api_key / personal_subscription / enterprise_gateway are
 * modeled. bedrock/vertex stay on the ambient-env passthrough (fold in post-beta).
 */
export const providerConnections = pgTable(
  "provider_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // P1 is merged first, so the FK is real now (RESTRICT: an org with live
    // connections cannot be hard-deleted out from under them).
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "restrict",
    }),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    // Catalog PROVIDER id ("anthropic"/"openai"/"google"), NOT the adapter type.
    provider: text("provider").notNull(),
    authMethod: text("auth_method", {
      enum: ["api_key", "personal_subscription", "enterprise_gateway"],
    }).notNull(),
    ownerUserId: text("owner_user_id").references(() => authUsers.id, { onDelete: "restrict" }),
    // P5 soft-ref (matches provider_credentials.execution_target_id).
    executionTargetId: text("execution_target_id"),
    // Points into the existing encrypted vault. RESTRICT: cannot delete a secret
    // an active connection uses (mirrors runtime_provider_keys.ts:13). NULL for
    // personal_subscription (its material is the on-disk home).
    secretRef: uuid("secret_ref").references(() => companySecrets.id, { onDelete: "restrict" }),
    state: text("state", { enum: ["pending", "verified", "revoked", "suspended"] })
      .notNull()
      .default("pending"),
    sharingPolicy: text("sharing_policy", {
      enum: ["owner_only", "company_agents", "org_agents"],
    })
      .notNull()
      .default("owner_only"),
    maxConcurrency: integer("max_concurrency").notNull().default(1),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    termsAttestedAt: timestamp("terms_attested_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgProviderIdx: index("provider_connections_org_provider_idx").on(
      table.organizationId,
      table.provider,
    ),
    companyProviderIdx: index("provider_connections_company_provider_idx").on(
      table.companyId,
      table.provider,
      table.state,
    ),
    ownerIdx: index("provider_connections_owner_idx").on(table.ownerUserId),
    // Identity — mirrors provider_credentials_identity_uq. nullsNotDistinct so a
    // second company-scoped api_key (owner NULL / target NULL) cannot duplicate.
    // organization_id LEADS the key (0195): org-level connections carry company_id
    // NULL, so without it two tenants' org-level api_keys collapse to one row per
    // provider per install under NULLS NOT DISTINCT.
    identityUq: unique("provider_connections_identity_uq")
      .on(
        table.organizationId,
        table.companyId,
        table.provider,
        table.authMethod,
        table.ownerUserId,
        table.executionTargetId,
      )
      .nullsNotDistinct(),
    // personal_subscription MUST have owner+target and MUST NOT hold a secret.
    // Shape-CHECK pattern from provider_readiness_status.ts:107.
    subscriptionShape: check(
      "provider_connections_subscription_shape_check",
      sql`(auth_method <> 'personal_subscription') OR (owner_user_id IS NOT NULL AND execution_target_id IS NOT NULL AND secret_ref IS NULL)`,
    ),
    // api_key MUST carry a vault secret. enterprise_gateway's token is optional
    // (some gateways are network-authed), so it is not required here.
    apiKeyShape: check(
      "provider_connections_api_key_shape_check",
      sql`(auth_method <> 'api_key') OR (secret_ref IS NOT NULL)`,
    ),
  }),
);

/**
 * The routing table: WHICH connection wins for WHOM. `provider` is denormalized
 * from the connection so one precedence query answers "resolve provider X for
 * agent Y". org_default rows carry company_id NULL.
 */
export const providerAssignments = pgTable(
  "provider_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id"),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => providerConnections.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    scopeType: text("scope_type", {
      enum: ["org_default", "company_default", "agent_override", "personal_execution_default"],
    }).notNull(),
    // NULL for org_default/company_default; agents.id for agent_override;
    // owner_user_id for personal_execution_default. NOT an FK — disposable route
    // rows, dangling ids simply never match (same rationale as
    // provider_readiness_status.scope_id, :52-60).
    scopeId: text("scope_id"),
    priority: integer("priority").notNull().default(0),
    state: text("state", { enum: ["active", "disabled"] }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    lookupIdx: index("provider_assignments_lookup_idx").on(
      table.companyId,
      table.provider,
      table.state,
    ),
    connectionIdx: index("provider_assignments_connection_idx").on(table.connectionId),
    // nullsNotDistinct REQUIRED so a second company_default (scope_id NULL) cannot
    // be minted (same reason as provider_readiness_scope_uq, PG15+). organization_id
    // LEADS the key (0195): org_default rows carry company_id NULL, so without it
    // two tenants' org_default assignments collapse to one row per provider.
    scopeUq: unique("provider_assignments_scope_uq")
      .on(table.organizationId, table.companyId, table.provider, table.scopeType, table.scopeId)
      .nullsNotDistinct(),
    scopeShape: check(
      "provider_assignments_scope_shape_check",
      sql`(scope_type IN ('org_default','company_default') AND scope_id IS NULL) OR (scope_type IN ('agent_override','personal_execution_default') AND scope_id IS NOT NULL)`,
    ),
  }),
);
