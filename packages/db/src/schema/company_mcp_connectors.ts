import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex, uuid, jsonb } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * External MCP servers a company has registered. `transport` selects which
 * columns are meaningful: "http" uses url + headerTemplate; "stdio" uses
 * command + args.
 *
 * SECRETS: headerTemplate/envTemplate values hold `${VAR}` PLACEHOLDERS ONLY.
 * The real value lives in company_secrets and is referenced by secretRef.
 */
export const companyMcpConnectors = pgTable(
  "company_mcp_connectors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    // Server name as it appears in MCP config. Lowercase, no spaces.
    serverName: text("server_name").notNull(),
    displayName: text("display_name").notNull(),
    transport: text("transport").notNull(), // "http" | "stdio"
    url: text("url"),
    command: text("command"),
    args: jsonb("args").$type<string[]>().notNull().default([]),
    headerTemplate: jsonb("header_template").$type<Record<string, string>>().notNull().default({}),
    envTemplate: jsonb("env_template").$type<Record<string, string>>().notNull().default({}),
    // Key into company_secrets (e.g. "mcp:notion"). Null for unauthenticated servers.
    secretRef: text("secret_ref"),
    // Whether this connector CANNOT function without a bound secret. Set from the
    // catalog entry at install; false for BYO connectors, whose founder supplies
    // everything up front. Load-bearing: resolveConnectorStatus refuses to mark a
    // requiresSecret connector `active` while secretRef is null, so an approval can
    // never activate an uncredentialed connector.
    requiresSecret: boolean("requires_secret").notNull().default(false),
    source: text("source").notNull().default("byo"), // "byo" | "catalog"
    // Immutable server-owned marketplace identity. User-authored/BYO rows keep
    // both fields null; OAuth authority is derived from these fields plus the
    // server's provider policy, never from mutable serverName/catalog metadata.
    catalogEntryId: text("catalog_entry_id"),
    oauthPolicyVersion: integer("oauth_policy_version"),
    // Catalog trust tier at INSTALL time ("verified" | "community" | "unverified"),
    // null for BYO connectors (no catalog provenance). Load-bearing for the FU-19
    // delivery-time D7 re-check: after a local_trusted -> authenticated conversion
    // a stored `verified` catalog stdio connector keeps the D7 catalog exemption,
    // while a null (BYO) or non-verified tier is dropped. Nullable & mode-agnostic
    // so it records provenance, not a decision.
    trustTier: text("trust_tier"),
    status: text("status").notNull().default("pending_approval"), // pending_approval | needs_credentials | active | disabled
    createdByUserId: uuid("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("company_mcp_connectors_company_idx").on(table.companyId),
    companyNameUq: uniqueIndex("company_mcp_connectors_company_name_uq").on(
      table.companyId,
      table.serverName,
    ),
    companyCatalogEntryUq: uniqueIndex("company_mcp_connectors_company_catalog_entry_uq")
      .on(table.companyId, table.catalogEntryId)
      .where(sql`${table.catalogEntryId} IS NOT NULL`),
  }),
);
