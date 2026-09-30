import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Db } from "@armyofagents/db";
import {
  authUsers,
  companies as companiesTable,
  companyMemberships,
  instanceUserRoles,
  invites,
  mcpApiKeys,
  organizationMemberships,
  principalPermissionGrants,
  userRoles,
} from "@armyofagents/db";
import type { PermissionKey, PrincipalType } from "@armyofagents/shared";
import { PERMISSION_KEYS } from "@armyofagents/shared";
import { conflict, notFound } from "../errors.js";
import { companyInviteExpiresAt } from "../routes/access-helpers.js";
import { tenantIsolationEnforced } from "../config/deployment-mode.js";
import { orgHierarchyService } from "./org-hierarchy.js";

const INVITE_TOKEN_PREFIX = "aoa_invite_";
const INVITE_TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const INVITE_TOKEN_SUFFIX_LENGTH = 24;
const INVITE_TOKEN_MAX_RETRIES = 5;

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function generateInviteToken() {
  const bytes = randomBytes(INVITE_TOKEN_SUFFIX_LENGTH);
  let suffix = "";
  for (let idx = 0; idx < INVITE_TOKEN_SUFFIX_LENGTH; idx += 1) {
    suffix += INVITE_TOKEN_ALPHABET[bytes[idx]! % INVITE_TOKEN_ALPHABET.length];
  }
  return `${INVITE_TOKEN_PREFIX}${suffix}`;
}

type MembershipRow = typeof companyMemberships.$inferSelect;
type GrantInput = {
  permissionKey: PermissionKey;
  scope?: Record<string, unknown> | null;
};

export function accessService(db: Db) {
  const orgHierarchy = orgHierarchyService(db);

  async function isInstanceAdmin(userId: string | null | undefined): Promise<boolean> {
    if (!userId) return false;
    // B1: there is NO data-plane instance_admin in cloud_auth. Returning false
    // here kills the canUser() short-circuit and (via team.effectiveRoleFromRows)
    // any cross-tenant role grant, even if an actor-clamp were somehow bypassed.
    if (tenantIsolationEnforced()) return false;
    const row = await db
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows) => rows[0] ?? null);
    return Boolean(row);
  }

  async function getMembership(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
  ): Promise<MembershipRow | null> {
    return db
      .select()
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, principalType),
          eq(companyMemberships.principalId, principalId),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function hasPermission(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    permissionKey: PermissionKey,
  ): Promise<boolean> {
    const membership = await getMembership(companyId, principalType, principalId);
    if (!membership || membership.status !== "active") return false;
    const grant = await db
      .select({ id: principalPermissionGrants.id })
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, principalType),
          eq(principalPermissionGrants.principalId, principalId),
          eq(principalPermissionGrants.permissionKey, permissionKey),
        ),
      )
      .then((rows) => rows[0] ?? null);
    return Boolean(grant);
  }

  async function canUser(
    companyId: string,
    userId: string | null | undefined,
    permissionKey: PermissionKey,
  ): Promise<boolean> {
    if (!userId) return false;
    if (await isInstanceAdmin(userId)) return true;
    return hasPermission(companyId, "user", userId, permissionKey);
  }

  async function listMembers(companyId: string) {
    return db
      .select()
      .from(companyMemberships)
      .where(eq(companyMemberships.companyId, companyId))
      .orderBy(sql`${companyMemberships.createdAt} desc`);
  }

  async function setMemberPermissions(
    companyId: string,
    memberId: string,
    grants: GrantInput[],
    grantedByUserId: string | null,
  ) {
    const member = await db
      .select()
      .from(companyMemberships)
      .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.id, memberId)))
      .then((rows) => rows[0] ?? null);
    if (!member) return null;

    await db.transaction(async (tx) => {
      await tx
        .delete(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, companyId),
            eq(principalPermissionGrants.principalType, member.principalType),
            eq(principalPermissionGrants.principalId, member.principalId),
          ),
        );
      if (grants.length > 0) {
        await tx.insert(principalPermissionGrants).values(
          grants.map((grant) => ({
            companyId,
            principalType: member.principalType,
            principalId: member.principalId,
            permissionKey: grant.permissionKey,
            scope: grant.scope ?? null,
            grantedByUserId,
            createdAt: new Date(),
            updatedAt: new Date(),
          })),
        );
      }
    });

    return member;
  }

  async function promoteInstanceAdmin(userId: string) {
    const existing = await db
      .select()
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows) => rows[0] ?? null);
    if (existing) return existing;
    return db
      .insert(instanceUserRoles)
      .values({
        userId,
        role: "instance_admin",
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function demoteInstanceAdmin(userId: string) {
    return db
      .delete(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function listUserCompanyAccess(userId: string) {
    return db
      .select()
      .from(companyMemberships)
      .where(and(eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId)))
      .orderBy(sql`${companyMemberships.createdAt} desc`);
  }

  async function setUserCompanyAccess(userId: string, companyIds: string[]) {
    const existing = await listUserCompanyAccess(userId);
    const existingByCompany = new Map(existing.map((row) => [row.companyId, row]));
    const target = new Set(companyIds);

    await db.transaction(async (tx) => {
      const toDelete = existing.filter((row) => !target.has(row.companyId));
      if (toDelete.length > 0) {
        for (const row of toDelete) {
          if (row.principalType === "user") {
            await orgHierarchy.reparentChildren(row.companyId, row.principalId, "user", tx as unknown as Db);
          }
        }
        await tx.delete(companyMemberships).where(inArray(companyMemberships.id, toDelete.map((row) => row.id)));

        // H8: cascade-revoke this user's MCP API keys for the companies they
        // were just removed from. An mcp_api_keys row freezes companyId+userId
        // at mint time and the auth middleware only filters on revokedAt, so
        // without this a removed user keeps full programmatic MCP access via any
        // key they generated while a member. (Company DELETE handles its own
        // keys via the FK onDelete cascade; this is the per-user offboarding
        // path.) userId-scoped since toDelete is all this user's memberships.
        const removedUserCompanyIds = toDelete
          .filter((row) => row.principalType === "user")
          .map((row) => row.companyId);
        if (removedUserCompanyIds.length > 0) {
          await tx
            .update(mcpApiKeys)
            .set({ revokedAt: new Date() })
            .where(
              and(
                inArray(mcpApiKeys.companyId, removedUserCompanyIds),
                eq(mcpApiKeys.userId, userId),
                isNull(mcpApiKeys.revokedAt),
              ),
            );
        }
      }

      for (const companyId of target) {
        if (existingByCompany.has(companyId)) continue;
        await tx.insert(companyMemberships).values({
          companyId,
          principalType: "user",
          principalId: userId,
          status: "active",
          membershipRole: "member",
        });
      }
    });

    return listUserCompanyAccess(userId);
  }

  async function ensureMembership(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    membershipRole: string | null = "member",
    status: "pending" | "active" | "suspended" = "active",
  ) {
    const existing = await getMembership(companyId, principalType, principalId);
    if (existing) {
      if (existing.status !== status || existing.membershipRole !== membershipRole) {
        const updated = await db
          .update(companyMemberships)
          .set({ status, membershipRole, updatedAt: new Date() })
          .where(eq(companyMemberships.id, existing.id))
          .returning()
          .then((rows) => rows[0] ?? null);
        return updated ?? existing;
      }
      return existing;
    }

    return db
      .insert(companyMemberships)
      .values({
        companyId,
        principalType,
        principalId,
        status,
        membershipRole,
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function ensureRealOperator(companyId: string, userId: string | null | undefined): Promise<string> {
    let operatorId = userId ?? null;
    // local_trusted passes a synthetic principal (e.g. "local-board") that is TRUTHY but
    // has NO auth-user row. Treat a missing OR non-existent id as "needs a real operator".
    if (operatorId) {
      const exists = await db.select({ id: authUsers.id }).from(authUsers)
        .where(eq(authUsers.id, operatorId)).limit(1).then((r) => r[0]);
      if (!exists) operatorId = null;
    }
    if (!operatorId) {
      operatorId = randomUUID();
      await db.insert(authUsers).values({
        id: operatorId,
        email: `operator-${operatorId.slice(0, 8)}@local.invalid`,
        name: "Operator",
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    await ensureMembership(companyId, "user", operatorId, "owner", "active");
    const existingRole = await db.select({ id: userRoles.id }).from(userRoles)
      .where(and(eq(userRoles.companyId, companyId), eq(userRoles.userId, operatorId), eq(userRoles.role, "founder")))
      .limit(1).then((r) => r[0]);
    if (!existingRole) {
      await db.insert(userRoles).values({ companyId, userId: operatorId, role: "founder" });
    }
    // A cloud_auth founder is authorized ENTIRELY through
    // principal_permission_grants: canUser()/hasPermission() read grant rows, NOT
    // the userRoles founder row, and isInstanceAdmin() returns false under tenant
    // isolation (no local_implicit bypass either). Every OTHER role-assignment
    // path (join-approval, team.updateRole) already seeds the role's grants — this
    // founder-at-creation path was the one that did NOT, so a cloud_auth founder
    // was left with a founder role row + owner membership but ZERO grants and got
    // 403'd on every canUser-gated route (Providers `agents:create`, routines /
    // projects `tasks:assign`, …). Seed the full founder grant set (all
    // PERMISSION_KEYS), self-granted, idempotently (ON CONFLICT DO NOTHING on the
    // unique grant index) so both a fresh create and an idempotent replay are safe.
    await db
      .insert(principalPermissionGrants)
      .values(
        PERMISSION_KEYS.map((permissionKey) => ({
          companyId,
          principalType: "user" as const,
          principalId: operatorId,
          permissionKey,
          scope: null,
          grantedByUserId: operatorId,
        })),
      )
      .onConflictDoNothing();
    // Task 10 (Phase 2 lockout cluster, ATOMIC cutover): the company's
    // founding operator is ALSO made an owner member of the company's
    // Organization (tenant). This is what lets a cloud_auth org owner who
    // creates their first company keep passing the org:* capability checks
    // for that org afterward (e.g. inviting teammates), without relying on
    // any instance_admin role -- cloud_auth mints none. Idempotent: does
    // nothing if a membership row already exists (P1's 0188 backfill or
    // organizationAccessService.ensureOrgOwner may already have written one
    // for this (organizationId, operatorId) pair -- never downgrades it).
    const companyRow = await db.select({ organizationId: companiesTable.organizationId })
      .from(companiesTable).where(eq(companiesTable.id, companyId)).limit(1).then((r) => r[0]);
    if (companyRow?.organizationId) {
      const existingOrgMembership = await db.select({ id: organizationMemberships.id }).from(organizationMemberships)
        .where(and(
          eq(organizationMemberships.organizationId, companyRow.organizationId),
          eq(organizationMemberships.userId, operatorId),
        )).limit(1).then((r) => r[0]);
      if (!existingOrgMembership) {
        await db.insert(organizationMemberships).values({
          organizationId: companyRow.organizationId, userId: operatorId, role: "owner", status: "active",
        });
      }
    }
    return operatorId;
  }

  async function setPrincipalGrants(
    companyId: string,
    principalType: PrincipalType,
    principalId: string,
    grants: GrantInput[],
    grantedByUserId: string | null,
  ) {
    await db.transaction(async (tx) => {
      await tx
        .delete(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.companyId, companyId),
            eq(principalPermissionGrants.principalType, principalType),
            eq(principalPermissionGrants.principalId, principalId),
          ),
        );
      if (grants.length === 0) return;
      await tx.insert(principalPermissionGrants).values(
        grants.map((grant) => ({
          companyId,
          principalType,
          principalId,
          permissionKey: grant.permissionKey,
          scope: grant.scope ?? null,
          grantedByUserId,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      );
    });
  }

  async function revokeInvite(companyId: string, inviteId: string) {
    const invite = await db
      .select()
      .from(invites)
      .where(and(eq(invites.id, inviteId), eq(invites.companyId, companyId)))
      .then((rows) => rows[0] ?? null);

    if (!invite) throw notFound("Invite not found");
    if (invite.acceptedAt) throw conflict("Cannot revoke an already accepted invite");
    if (invite.revokedAt) throw conflict("Invite is already revoked");

    await db
      .update(invites)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(eq(invites.id, inviteId));

    return invite;
  }

  async function resendInvite(companyId: string, inviteId: string) {
    const oldInvite = await db
      .select()
      .from(invites)
      .where(and(eq(invites.id, inviteId), eq(invites.companyId, companyId)))
      .then((rows) => rows[0] ?? null);

    if (!oldInvite) throw notFound("Invite not found");
    if (oldInvite.acceptedAt) throw conflict("Cannot resend an already accepted invite");

    // Revoke the old invite if it's still active
    if (!oldInvite.revokedAt) {
      await db
        .update(invites)
        .set({ revokedAt: new Date(), updatedAt: new Date() })
        .where(eq(invites.id, inviteId));
    }

    // Create a new invite with the same payload but fresh token and expiry
    let token: string | null = null;
    let created: typeof invites.$inferSelect | null = null;
    for (let attempt = 0; attempt < INVITE_TOKEN_MAX_RETRIES; attempt += 1) {
      const candidateToken = generateInviteToken();
      try {
        const row = await db
          .insert(invites)
          .values({
            companyId: oldInvite.companyId,
            inviteType: oldInvite.inviteType,
            tokenHash: hashToken(candidateToken),
            allowedJoinTypes: oldInvite.allowedJoinTypes,
            defaultsPayload: oldInvite.defaultsPayload,
            // Payload-aware TTL: human-only email-bound team invites keep
            // their 7-day window on resend; agent/both/open invites keep
            // the 10-minute one.
            expiresAt: companyInviteExpiresAt(
              oldInvite.defaultsPayload,
              oldInvite.allowedJoinTypes,
            ),
            invitedByUserId: oldInvite.invitedByUserId,
          })
          .returning()
          .then((rows) => rows[0]);
        token = candidateToken;
        created = row;
        break;
      } catch {
        // Retry on token hash collision
      }
    }

    if (!token || !created) {
      throw conflict("Failed to generate a unique invite token. Please retry.");
    }

    return { invite: created, token };
  }

  return {
    isInstanceAdmin,
    canUser,
    hasPermission,
    getMembership,
    ensureMembership,
    ensureRealOperator,
    listMembers,
    setMemberPermissions,
    promoteInstanceAdmin,
    demoteInstanceAdmin,
    listUserCompanyAccess,
    setUserCompanyAccess,
    setPrincipalGrants,
    revokeInvite,
    resendInvite,
  };
}
