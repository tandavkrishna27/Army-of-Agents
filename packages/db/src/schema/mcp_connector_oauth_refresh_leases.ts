import { bigint, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";

/**
 * Cross-process ownership for refreshes of rotating OAuth tokens.
 *
 * `fencingToken` increases on every takeover. A refresh result may be committed
 * only while owner, fence, expected version, and lease expiry still match.
 * `request_started` is deliberately durable: expiry in that phase means the
 * provider outcome is indeterminate and the old refresh token must not be spent
 * again.
 */
export const mcpConnectorOauthRefreshLeases = pgTable(
  "mcp_connector_oauth_refresh_leases",
  {
    secretId: uuid("secret_id")
      .primaryKey()
      .references(() => companySecrets.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    ownerToken: uuid("owner_token").notNull(),
    fencingToken: bigint("fencing_token", { mode: "number" }).notNull(),
    expectedSecretVersion: integer("expected_secret_version").notNull(),
    phase: text("phase").notNull().default("acquired"),
    requestStartedAt: timestamp("request_started_at", { withTimezone: true }),
    leasedUntil: timestamp("leased_until", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);
