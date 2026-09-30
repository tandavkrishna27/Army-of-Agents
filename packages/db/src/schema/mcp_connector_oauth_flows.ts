import { pgTable, uuid, text, timestamp, jsonb, index, integer } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companyMcpConnectors } from "./company_mcp_connectors.js";

/**
 * In-flight OAuth authorization flows for MCP connectors. Holds ONLY transient state
 * for the browser round-trip (PKCE verifier, discovered endpoints, DCR client id). The
 * `state` column is the anti-CSRF value echoed by the provider on callback; it is ALSO
 * HMAC-signed (see mcp-connector-oauth.ts) so the callback verifies signature THEN looks
 * up the row. No tokens are ever stored here — those go to company_secrets on success.
 */
export const mcpConnectorOauthFlows = pgTable(
  "mcp_connector_oauth_flows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    connectorId: uuid("connector_id").notNull().references(() => companyMcpConnectors.id, { onDelete: "cascade" }),
    catalogEntryId: text("catalog_entry_id"),
    oauthPolicyVersion: integer("oauth_policy_version"),
    state: text("state").notNull(),
    pkceVerifier: text("pkce_verifier").notNull(),
    clientId: text("client_id").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    authorizationEndpoint: text("authorization_endpoint").notNull(),
    tokenEndpoint: text("token_endpoint").notNull(),
    resource: text("resource").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    status: text("status").notNull().default("pending"), // pending | claimed | completed | failed | expired
    // No FK: the starting actor id may be a board sentinel (e.g. "local-board") with no user row —
    // an FK here would 500 the oauth/start INSERT in local_trusted. The route stores the user id
    // only when it's a real UUID (else null), mirroring company_mcp_connectors.createdByUserId.
    startedByUserId: text("started_by_user_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    stateIdx: index("mcp_connector_oauth_flows_state_idx").on(table.state),
    connectorIdx: index("mcp_connector_oauth_flows_connector_idx").on(table.connectorId),
    companyIdx: index("mcp_connector_oauth_flows_company_idx").on(table.companyId),
    statusExpiresIdx: index("mcp_connector_oauth_flows_status_expires_idx").on(
      table.status,
      table.expiresAt,
    ),
    statusUpdatedIdx: index("mcp_connector_oauth_flows_status_updated_idx").on(
      table.status,
      table.updatedAt,
    ),
  }),
);
