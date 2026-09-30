import { and, eq, gt, isNotNull, isNull, lte, or } from "drizzle-orm";
import {
  activityLog,
  operatorBreakGlassGrants,
  organizationMemberships,
  type Db,
} from "@armyofagents/db";
import { logger } from "../middleware/logger.js";

/**
 * Operator break-glass (Phase 3, B3).
 *
 * A grant materializes an ORGANIZATION membership so the operator passes
 * assertTenantMembership on the next actor re-derive (this was the eng-review
 * bug: the grant used to write nothing, so a "granted" operator still failed the
 * tenant gate). Authorization itself is decided at CHECK TIME by
 * hasActiveBreakGlass() using a live TTL — never a cached flag. A sweeper deletes
 * the materialized membership once the grant expires or is revoked.
 */

export interface BreakGlassDeps {
  /**
   * Materialize the tenant-side access rows for a grant. `role` here is the
   * ORGANIZATION-membership role (owner|admin|member|billing) — NOT the grant's
   * company role. Must be idempotent (a re-grant should not error).
   */
  materializeMembership: (a: {
    organizationId: string;
    companyId: string | null;
    userId: string;
    role: string;
  }) => Promise<void>;
  /** Remove what materializeMembership wrote for this (organization, user). */
  revokeMembership: (a: { organizationId: string; userId: string }) => Promise<void>;
  /** Best-effort audit sink. Never throws in a way that fails the grant/sweep. */
  audit: (e: {
    action: string;
    operatorUserId: string;
    organizationId: string;
    companyId: string | null;
  }) => Promise<void>;
}

export interface BreakGlassGrantInput {
  operatorUserId: string;
  organizationId: string;
  /** null = org-wide grant (matches any company in the organization). */
  companyId: string | null;
  /** The company-level role the operator assumes (stored on the grant record). */
  role: string;
  reason: string;
  grantedByUserId: string;
  ttlMinutes: number;
}

/**
 * The materialized ORGANIZATION-membership role. The grant's `role` is the
 * separate company-level role; the org_memberships CHECK only allows
 * owner|admin|member|billing, and break-glass is emergency full-tenant access.
 */
const BREAK_GLASS_ORG_ROLE = "owner";

/**
 * Live-TTL read used at the authorization decision point. Authoritative and
 * independent of the sweeper: a grant is active iff it is not revoked and its
 * expires_at is still in the future. An org-wide grant (company_id NULL) matches
 * any company in that same organization only (org is scoped in the WHERE).
 */
export async function hasActiveBreakGlass(
  db: Db,
  operatorUserId: string,
  companyId: string,
  organizationId: string,
): Promise<boolean> {
  // Org-scope in SQL (Finding #1): an org-wide grant (company_id NULL)
  // authorizes ONLY the organization it was granted for — never every org.
  // Company-scoped grants still match by exact companyId within that org.
  const rows = await db
    .select({ companyId: operatorBreakGlassGrants.companyId })
    .from(operatorBreakGlassGrants)
    .where(
      and(
        eq(operatorBreakGlassGrants.operatorUserId, operatorUserId),
        eq(operatorBreakGlassGrants.organizationId, organizationId),
        isNull(operatorBreakGlassGrants.revokedAt),
        gt(operatorBreakGlassGrants.expiresAt, new Date()),
      ),
    );
  return rows.some((r) => r.companyId === null || r.companyId === companyId);
}

export function operatorBreakGlassService(db: Db, deps: BreakGlassDeps) {
  // ⚠ INERT TODAY — NO production trigger reaches grant()/revoke(). Only
  // sweepExpired() is wired at runtime (from index.ts boot + 60s tick), and REST
  // authorization honors hasActiveBreakGlass() (authz.ts) as a live-TTL read.
  // There is NO route / CLI / MCP tool that calls grant() or revoke(), so the
  // grant-row creation path is UNREACHABLE through a running server — operator
  // break-glass is a library + sweeper + read, not an end-to-end feature yet.
  //
  // grant() is INTENTIONALLY non-transactional and safe ONLY because nothing
  // reaches it. If a grant/revoke endpoint (operator console) is ever added, it
  // MUST also address these latent gaps:
  //   (1) Atomicity — wrap the grant INSERT + materializeMembership() + audit()
  //       in a single db.transaction(...). Today a failure after the insert
  //       leaves an active grant row with no materialized membership (or an
  //       un-audited grant), i.e. partial/active access.
  //   (2) One access decision — REST (assertCompanyAccess) and BOTH cookie-auth
  //       WS upgrade paths (realtime/live-events-ws.ts, services/upgrade-auth.ts)
  //       must share ONE authorization decision. Today those WS paths require
  //       ordinary org + company memberships and never consult the grant, so an
  //       operator with an active break-glass grant would still be refused the
  //       WS upgrade.
  //   (3) Company membership — materializeMembership() currently creates ONLY an
  //       ORGANIZATION membership (never a COMPANY one), so even a materialized
  //       break-glass grant cannot satisfy the WS company-membership check.
  //       An operator console must therefore also materialize the COMPANY
  //       membership those WS branches require (or have those branches call
  //       hasActiveBreakGlass() directly).
  async function grant(input: BreakGlassGrantInput) {
    const expiresAt = new Date(Date.now() + input.ttlMinutes * 60_000);
    const [row] = await db
      .insert(operatorBreakGlassGrants)
      .values({
        operatorUserId: input.operatorUserId,
        organizationId: input.organizationId,
        companyId: input.companyId,
        role: input.role,
        reason: input.reason,
        grantedByUserId: input.grantedByUserId,
        expiresAt,
      })
      .returning();
    // Materialize the ORGANIZATION membership so the operator passes
    // assertTenantMembership on the next re-derive. Uses a valid org role, not
    // the grant's company role.
    await deps.materializeMembership({
      organizationId: input.organizationId,
      companyId: input.companyId,
      userId: input.operatorUserId,
      role: BREAK_GLASS_ORG_ROLE,
    });
    await deps.audit({
      action: "operator.break_glass.granted",
      operatorUserId: input.operatorUserId,
      organizationId: input.organizationId,
      companyId: input.companyId,
    });
    return row;
  }

  async function revoke(operatorUserId: string, organizationId: string) {
    // company_id is intentionally NOT in the filter: an org-wide grant
    // (company_id NULL) must be matched too. This revokes every still-active
    // grant for this (operator, organization).
    await db
      .update(operatorBreakGlassGrants)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(operatorBreakGlassGrants.operatorUserId, operatorUserId),
          eq(operatorBreakGlassGrants.organizationId, organizationId),
          isNull(operatorBreakGlassGrants.revokedAt),
        ),
      );
    await deps.revokeMembership({ organizationId, userId: operatorUserId });
    await deps.audit({
      action: "operator.break_glass.revoked",
      operatorUserId,
      organizationId,
      companyId: null,
    });
  }

  /**
   * Boot + interval sweep: delete the materialized membership for every grant
   * that is past its expiry or has been revoked but not yet swept, then mark it
   * swept. Returns how many grants were processed.
   */
  async function sweepExpired(): Promise<number> {
    const stale = await db
      .select()
      .from(operatorBreakGlassGrants)
      .where(
        and(
          isNull(operatorBreakGlassGrants.sweptAt),
          or(
            lte(operatorBreakGlassGrants.expiresAt, new Date()),
            isNotNull(operatorBreakGlassGrants.revokedAt),
          ),
        ),
      );
    for (const g of stale) {
      await deps.revokeMembership({ organizationId: g.organizationId, userId: g.operatorUserId });
      await db
        .update(operatorBreakGlassGrants)
        .set({ sweptAt: new Date() })
        .where(eq(operatorBreakGlassGrants.id, g.id));
      await deps.audit({
        action: "operator.break_glass.swept",
        operatorUserId: g.operatorUserId,
        organizationId: g.organizationId,
        companyId: g.companyId,
      });
    }
    return stale.length;
  }

  return { grant, revoke, sweepExpired };
}

/**
 * Real boot dependencies. Materialize/revoke operate on organization_memberships
 * (the tenant-access row that gates assertTenantMembership); audit writes to
 * activity_log.
 *
 * NOTE (Finding #2): revokeMembership reclaims ONLY the membership break-glass
 * materialized (created_by_break_glass = true) and ONLY when no other still-active
 * grant for this (organization, operator) needs it. A pre-existing member's real
 * row (created_by_break_glass = false) is never deleted, and two overlapping
 * grants share one materialized row — the first to expire leaves it for the
 * still-active second grant.
 */
export function realBreakGlassDeps(db: Db): BreakGlassDeps {
  return {
    materializeMembership: async ({ organizationId, userId, role }) => {
      await db
        .insert(organizationMemberships)
        .values({ organizationId, userId, role, status: "active", createdByBreakGlass: true })
        .onConflictDoNothing();
    },
    revokeMembership: async ({ organizationId, userId }) => {
      // Provenance + ref-count (Finding #2): reclaim ONLY a row break-glass
      // itself created (created_by_break_glass = true), and ONLY when no other
      // still-active grant for this (organization, operator) needs it — two
      // overlapping grants share one materialized row.
      const active = await db
        .select({ id: operatorBreakGlassGrants.id })
        .from(operatorBreakGlassGrants)
        .where(
          and(
            eq(operatorBreakGlassGrants.organizationId, organizationId),
            eq(operatorBreakGlassGrants.operatorUserId, userId),
            isNull(operatorBreakGlassGrants.revokedAt),
            gt(operatorBreakGlassGrants.expiresAt, new Date()),
          ),
        );
      if (active.length > 0) return;
      await db
        .delete(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.organizationId, organizationId),
            eq(organizationMemberships.userId, userId),
            eq(organizationMemberships.createdByBreakGlass, true),
          ),
        );
    },
    audit: async ({ action, operatorUserId, organizationId, companyId }) => {
      // activity_log.company_id is NOT NULL and the table has no organization
      // column, so an org-wide grant (companyId null) has no company row to
      // attribute the mutation to. Rather than drop it silently, emit a
      // structured log line so org-wide break-glass grant/revoke/sweep
      // mutations are at least visible in the server log. A full org-scoped
      // audit feed is deferred to M6. Audit is best-effort and must never fail
      // the grant/sweep.
      if (!companyId) {
        logger.warn(
          { action, operatorUserId, organizationId, scope: "org_wide" },
          "operator break-glass org-wide mutation (no company-scoped activity_log row)",
        );
        return;
      }
      await db.insert(activityLog).values({
        companyId,
        actorType: "operator",
        actorId: operatorUserId,
        action,
        entityType: "operator_break_glass_grant",
        entityId: operatorUserId,
        details: { organizationId },
      });
    },
  };
}
