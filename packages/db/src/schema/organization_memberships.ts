import { pgTable, uuid, text, timestamp, index, uniqueIndex, check, boolean } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./organizations.js";
import { authUsers } from "./auth.js";

export const organizationMemberships = pgTable(
  "organization_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    status: text("status").notNull().default("active"),
    // Provenance (Finding #2): true only for a row break-glass materialization
    // created. A pre-existing owner/admin row stays false and must never be
    // reclaimed by the sweeper.
    createdByBreakGlass: boolean("created_by_break_glass").notNull().default(false),
    invitedByUserId: text("invited_by_user_id").references(() => authUsers.id, { onDelete: "set null" }),
    joinedAt: timestamp("joined_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgUserUq: uniqueIndex("organization_memberships_org_user_uq").on(table.organizationId, table.userId),
    userStatusIdx: index("organization_memberships_user_status_idx").on(table.userId, table.status),
    orgStatusIdx: index("organization_memberships_org_status_idx").on(table.organizationId, table.status),
    roleValid: check("organization_memberships_role_check", sql`role IN ('owner', 'admin', 'member', 'billing')`),
    statusValid: check("organization_memberships_status_check", sql`status IN ('pending', 'active', 'suspended')`),
  }),
);
