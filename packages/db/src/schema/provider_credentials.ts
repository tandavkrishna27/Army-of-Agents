import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { authUsers } from "./auth.js";
import { companies } from "./companies.js";

/**
 * Logical credential ownership only. Provider-native subscription files remain
 * in the owning execution target and are never stored in this table.
 */
export const providerCredentials = pgTable(
  "provider_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "restrict" }),
    executionTargetId: text("execution_target_id").notNull(),
    kind: text("kind").notNull(), // personal_subscription | company_api_key
    state: text("state").notNull().default("pending"), // pending | verified | revoked | suspended
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ownerIdx: index("provider_credentials_owner_idx").on(table.companyId, table.ownerUserId),
    targetIdx: index("provider_credentials_target_idx").on(
      table.companyId,
      table.executionTargetId,
      table.provider,
    ),
    identityUq: uniqueIndex("provider_credentials_identity_uq").on(
      table.companyId,
      table.provider,
      table.ownerUserId,
      table.executionTargetId,
      table.kind,
    ),
  }),
);

export const agentProviderCredentialBindings = pgTable(
  "agent_provider_credential_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    credentialId: uuid("credential_id")
      .notNull()
      .references(() => providerCredentials.id, { onDelete: "cascade" }),
    approvedByUserId: text("approved_by_user_id").references(() => authUsers.id, {
      onDelete: "set null",
    }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentIdx: index("agent_provider_credential_bindings_agent_idx").on(
      table.companyId,
      table.agentId,
    ),
    activeAgentCredentialUq: uniqueIndex(
      "agent_provider_credential_bindings_agent_credential_uq",
    ).on(table.agentId, table.credentialId),
  }),
);
