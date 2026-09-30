import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Audited, time-boxed operator break-glass grants (Phase 3, B3).
 *
 * A grant lets a cloud operator reach a tenant's company data WITHOUT being a
 * standing member. Authorization is decided at CHECK TIME via hasActiveBreakGlass()
 * (live TTL: expires_at > now() AND revoked_at IS NULL) — never from a cached flag.
 * On grant, the service ALSO materializes an organization_membership so the operator
 * passes assertTenantMembership on re-derive; a sweeper deletes those materialized
 * rows once the grant expires or is revoked.
 *
 * company_id NULL = org-wide grant (matches any company in the organization).
 * No FKs on the *_user_id columns (they may reference operator identities that are
 * not org members) — kept as plain text on purpose.
 */
export const operatorBreakGlassGrants = pgTable(
  "operator_break_glass_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operatorUserId: text("operator_user_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    companyId: uuid("company_id"), // null = org-wide grant
    role: text("role").notNull().default("founder"),
    reason: text("reason").notNull(),
    grantedByUserId: text("granted_by_user_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    sweptAt: timestamp("swept_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    operatorActiveIdx: index("obg_operator_active_idx").on(table.operatorUserId, table.expiresAt),
    orgIdx: index("obg_org_idx").on(table.organizationId),
  }),
);
