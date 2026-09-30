import { pgTable, uuid, text, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./organizations.js";
import { authUsers } from "./auth.js";

export const organizationInvitations = pgTable(
  "organization_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull().default("member"),
    // SHA-256 of a 32-byte random token; plaintext is shown once at mint time
    // and never persisted (mirrors invites.ts).
    tokenHash: text("token_hash").notNull(),
    status: text("status").notNull().default("pending"),
    invitedByUserId: text("invited_by_user_id").references(() => authUsers.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tokenHashUq: uniqueIndex("organization_invitations_token_hash_uq").on(table.tokenHash),
    orgStatusIdx: index("organization_invitations_org_status_idx").on(
      table.organizationId,
      table.status,
      table.expiresAt,
    ),
    pendingEmailUq: uniqueIndex("organization_invitations_pending_email_uq")
      .on(table.organizationId, table.email)
      .where(sql`status = 'pending'`),
    roleValid: check("organization_invitations_role_check", sql`role IN ('owner', 'admin', 'member', 'billing')`),
    statusValid: check("organization_invitations_status_check", sql`status IN ('pending', 'accepted', 'revoked', 'expired')`),
  }),
);
