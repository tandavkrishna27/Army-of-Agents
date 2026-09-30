import { and, count, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import crypto from "node:crypto";
import type { Db } from "@armyofagents/db";
import {
  agents,
  assets,
  authUsers,
  companyMemberships,
  companyUserProfiles,
  instanceUserRoles,
  invites,
  issues,
  mcpApiKeys,
  principalPermissionGrants,
  projects,
  userRoles,
} from "@armyofagents/db";
import type {
  CompanyUserProfile,
  HumanWorkload,
  HumanWorkloadAttentionItem,
  HumanWorkloadManagedAgentTask,
  HumanWorkloadTaskSummary,
  HumanSocialLink,
  IssuePriority,
  IssueStatus,
  MemberDependencies,
  PermissionKey,
  TeamSummary,
  UpdateCompanyUserProfile,
  UpdateTeamMemberRole,
  UserRole,
} from "@armyofagents/shared";
import { PERMISSION_KEYS, humanSocialLinkSchema } from "@armyofagents/shared";
import { badRequest, conflict, notFound } from "../errors.js";
import { tenantIsolationEnforced } from "../config/deployment-mode.js";
import { accessService } from "./access.js";
import { humanCapabilitiesService } from "./human-capabilities.js";
import { orgHierarchyService } from "./org-hierarchy.js";
import { getUserProfile } from "./user-profiles.js";

const TEAM_INVITE_KEY = "teamInvite";
const OPEN_WORKLOAD_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"];
const TEAM_PERMISSION_KEYS = {
  founder: [...PERMISSION_KEYS],
  team_lead: ["tasks:assign", "tasks:assign_scope"],
  team_member: [],
} as const satisfies Record<UserRole, PermissionKey[]>;

export function parseInviteRoleMetadata(defaultsPayload: Record<string, unknown> | null | undefined) {
  if (!defaultsPayload) return null;
  const raw = defaultsPayload[TEAM_INVITE_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const role = record.role;
  const email = record.email;
  const projectId = record.projectId;
  if (role !== "team_lead" && role !== "team_member" && role !== "founder") return null;
  const parentId = record.parentId;
  return {
    email: typeof email === "string" ? email : null,
    role: role as UserRole,
    projectId: typeof projectId === "string" ? projectId : null,
    parentId: typeof parentId === "string" ? parentId : null,
  };
}

function derivePermissions(role: UserRole) {
  return {
    canAssignTasks: role === "founder" || role === "team_lead",
    canInviteUsers: role === "founder",
    canManageRoles: role === "founder",
    canEditIdentityMemory: role === "founder",
  };
}

function effectiveRoleFromRows(
  rows: Array<{ role: string; projectId: string | null }>,
  isInstanceAdmin: boolean,
): { role: UserRole | null; projectId: string | null } {
  if (isInstanceAdmin) return { role: "founder", projectId: null };
  if (rows.some((row) => row.role === "founder")) {
    return { role: "founder", projectId: null };
  }
  const leadRow = rows.find((row) => row.role === "team_lead");
  if (leadRow) {
    return { role: "team_lead", projectId: leadRow.projectId };
  }
  const memberRow = rows.find((row) => row.role === "team_member");
  if (memberRow) {
    return { role: "team_member", projectId: memberRow.projectId };
  }
  return { role: null, projectId: null };
}

function roleGrants(role: UserRole, projectId: string | null) {
  return TEAM_PERMISSION_KEYS[role].map((permissionKey) => ({
    permissionKey,
    scope:
      permissionKey === "tasks:assign_scope" && projectId
        ? { projectId }
        : null,
  }));
}

function assetContentPath(assetId: string) {
  return `/api/assets/${assetId}/content`;
}

function normalizeSocialLinks(value: unknown): HumanSocialLink[] {
  return Array.isArray(value) ? (value as HumanSocialLink[]) : [];
}

function toWorkloadTask(row: typeof issues.$inferSelect): HumanWorkloadTaskSummary {
  return {
    id: row.id,
    identifier: row.identifier ?? null,
    title: row.title,
    status: row.status as IssueStatus,
    priority: row.priority as IssuePriority,
    assigneeAgentId: row.assigneeAgentId ?? null,
    assigneeUserId: row.assigneeUserId ?? null,
    responsibleUserId: row.responsibleUserId ?? null,
    dueDate: row.dueDate ?? null,
    updatedAt: row.updatedAt,
  };
}

function workloadAttentionKind(status: string): HumanWorkloadAttentionItem["kind"] | null {
  if (status === "blocked") return "blocked_task";
  if (status === "in_review") return "review_task";
  return null;
}

export function teamService(db: Db) {
  const access = accessService(db);
  const humanCapabilities = humanCapabilitiesService(db);
  const orgHierarchy = orgHierarchyService(db);

  async function isInstanceAdmin(userId: string | null | undefined) {
    if (!userId) return false;
    // B1 defense-in-depth: no data-plane instance_admin in cloud_auth, so
    // effectiveRoleFromRows() cannot promote an operator to founder across tenants.
    if (tenantIsolationEnforced()) return false;
    const row = await db
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows) => rows[0] ?? null);
    return Boolean(row);
  }

  async function getUserRole(companyId: string, userId: string | null | undefined) {
    if (!userId) return { role: null, projectId: null } as const;
    const [instanceAdmin, rows] = await Promise.all([
      isInstanceAdmin(userId),
      db
        .select({
          role: userRoles.role,
          projectId: userRoles.projectId,
        })
        .from(userRoles)
        .where(and(eq(userRoles.companyId, companyId), eq(userRoles.userId, userId))),
    ]);
    return effectiveRoleFromRows(rows, instanceAdmin);
  }

  async function assertFounder(companyId: string, userId: string | null | undefined) {
    const { role } = await getUserRole(companyId, userId);
    if (role !== "founder") {
      throw conflict("Only founders can manage team roles");
    }
  }

  async function listTeam(companyId: string, currentUserId: string | null | undefined): Promise<TeamSummary> {
    const memberships = await db
      .select({
        principalId: companyMemberships.principalId,
        status: companyMemberships.status,
        parentType: companyMemberships.parentType,
        parentId: companyMemberships.parentId,
        isSystemAdmin: companyMemberships.isSystemAdmin,
      })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.status, "active"),
        ),
      );

    const userIds = memberships.map((membership) => membership.principalId);
    const [users, profileRows, roleRows, grants, pendingInvites, departmentRows] = await Promise.all([
      userIds.length > 0
        ? db
            .select({
              id: authUsers.id,
              email: authUsers.email,
              displayName: authUsers.displayName,
              avatarUrl: authUsers.avatarUrl,
              image: authUsers.image,
              name: authUsers.name,
            })
            .from(authUsers)
            .where(inArray(authUsers.id, userIds))
        : Promise.resolve([]),
      userIds.length > 0
        ? db
            .select({
              userId: companyUserProfiles.userId,
              displayName: companyUserProfiles.displayName,
              title: companyUserProfiles.title,
              bio: companyUserProfiles.bio,
              location: companyUserProfiles.location,
              timezone: companyUserProfiles.timezone,
              socialLinks: companyUserProfiles.socialLinks,
              avatarAssetId: companyUserProfiles.avatarAssetId,
            })
            .from(companyUserProfiles)
            .where(and(eq(companyUserProfiles.companyId, companyId), inArray(companyUserProfiles.userId, userIds)))
        : Promise.resolve([]),
      userIds.length > 0
        ? db
            .select({
              userId: userRoles.userId,
              role: userRoles.role,
              projectId: userRoles.projectId,
            })
            .from(userRoles)
            .where(and(eq(userRoles.companyId, companyId), inArray(userRoles.userId, userIds)))
        : Promise.resolve([]),
      userIds.length > 0
        ? db
            .select({
              principalId: principalPermissionGrants.principalId,
              permissionKey: principalPermissionGrants.permissionKey,
            })
            .from(principalPermissionGrants)
            .where(
              and(
                eq(principalPermissionGrants.companyId, companyId),
                eq(principalPermissionGrants.principalType, "user"),
                inArray(principalPermissionGrants.principalId, userIds),
              ),
            )
        : Promise.resolve([]),
      db
        .select({
          id: invites.id,
          defaultsPayload: invites.defaultsPayload,
          expiresAt: invites.expiresAt,
        })
        .from(invites)
        .where(
          and(
            eq(invites.companyId, companyId),
            isNull(invites.revokedAt),
            isNull(invites.acceptedAt),
            sql`${invites.expiresAt} > now()`,
          ),
        ),
      db
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(and(eq(projects.companyId, companyId), eq(projects.type, "department"))),
    ]);

    const userMap = new Map(users.map((user) => [user.id, user]));
    const profileMap = new Map(profileRows.map((profile) => [profile.userId, profile]));
    const roleRowsByUser = new Map<string, Array<{ role: string; projectId: string | null }>>();
    for (const row of roleRows) {
      const existing = roleRowsByUser.get(row.userId) ?? [];
      existing.push({ role: row.role, projectId: row.projectId });
      roleRowsByUser.set(row.userId, existing);
    }
    const grantsByUser = new Map<string, PermissionKey[]>();
    for (const grant of grants) {
      const existing = grantsByUser.get(grant.principalId) ?? [];
      existing.push(grant.permissionKey as PermissionKey);
      grantsByUser.set(grant.principalId, existing);
    }
    const departmentMap = new Map(departmentRows.map((row) => [row.id, row.name]));
    const adminIds = new Set<string>();
    for (const userId of userIds) {
      if (await isInstanceAdmin(userId)) {
        adminIds.add(userId);
      }
    }

    const members = memberships
      .map((membership) => {
        const roleRowsForUser = roleRowsByUser.get(membership.principalId) ?? [];
        const isAdmin = adminIds.has(membership.principalId);
        const effectiveRole = effectiveRoleFromRows(roleRowsForUser, isAdmin);
        if (!effectiveRole.role) return null;
        const user = userMap.get(membership.principalId);
        const profile = profileMap.get(membership.principalId);
        const avatarAssetId = profile?.avatarAssetId ?? null;
        return {
          userId: membership.principalId,
          email: user?.email ?? null,
          displayName: profile?.displayName ?? user?.displayName ?? user?.name ?? null,
          avatarUrl: avatarAssetId ? assetContentPath(avatarAssetId) : (user?.avatarUrl ?? user?.image ?? null),
          title: profile?.title ?? null,
          bio: profile?.bio ?? null,
          location: profile?.location ?? null,
          timezone: profile?.timezone ?? null,
          socialLinks: normalizeSocialLinks(profile?.socialLinks),
          avatarAssetId,
          role: effectiveRole.role,
          departmentId: effectiveRole.projectId,
          departmentName: effectiveRole.projectId ? (departmentMap.get(effectiveRole.projectId) ?? null) : null,
          permissions: grantsByUser.get(membership.principalId) ?? [],
          isCurrentUser: membership.principalId === currentUserId,
          isSystemAdmin: membership.isSystemAdmin ?? false,
          parentType: (membership.parentType as "user" | null) ?? null,
          parentId: membership.parentId ?? null,
        };
      })
      .filter((member): member is NonNullable<typeof member> => Boolean(member))
      .sort((left, right) => {
        const roleOrder = { founder: 0, team_lead: 1, team_member: 2 } as const;
        const roleSort = roleOrder[left.role] - roleOrder[right.role];
        if (roleSort !== 0) return roleSort;
        return (left.displayName ?? left.email ?? left.userId).localeCompare(
          right.displayName ?? right.email ?? right.userId,
        );
      });

    const pendingInviteSummaries = pendingInvites
      .map((invite) => {
        const metadata = parseInviteRoleMetadata(invite.defaultsPayload as Record<string, unknown> | null);
        if (!metadata) return null;
        const reportsToMember = metadata.parentId ? members.find((m) => m.userId === metadata.parentId) : null;
        return {
          id: invite.id,
          email: metadata.email,
          role: metadata.role,
          departmentId: metadata.projectId,
          departmentName: metadata.projectId ? (departmentMap.get(metadata.projectId) ?? null) : null,
          reportsToId: metadata.parentId,
          reportsToName: reportsToMember?.displayName ?? null,
          expiresAt: invite.expiresAt,
          inviteUrl: "",
        };
      })
      .filter((invite): invite is NonNullable<typeof invite> => Boolean(invite));

    const currentUser = await getUserRole(companyId, currentUserId);
    const currentMembership = memberships.find((m) => m.principalId === currentUserId);

    // Lazy bootstrap: if current user is founder and nobody has isSystemAdmin, auto-assign
    let isSystemAdmin = currentMembership?.isSystemAdmin ?? false;
    if (
      !isSystemAdmin &&
      currentUser.role === "founder" &&
      currentMembership &&
      !memberships.some((m) => m.isSystemAdmin)
    ) {
      await db
        .update(companyMemberships)
        .set({ isSystemAdmin: true, updatedAt: new Date() })
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalId, currentMembership.principalId),
          ),
        );
      isSystemAdmin = true;
    }

    return {
      currentUser: {
        userId: currentUserId ?? null,
        role: currentUser.role,
        departmentId: currentUser.projectId,
        isSystemAdmin,
        permissions: currentUser.role
          ? derivePermissions(currentUser.role)
          : {
              canAssignTasks: false,
              canInviteUsers: false,
              canManageRoles: false,
              canEditIdentityMemory: false,
            },
      },
      members,
      pendingInvites: pendingInviteSummaries,
    };
  }

  async function founderCount(companyId: string) {
    const founderRoleRows = await db
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .where(and(eq(userRoles.companyId, companyId), eq(userRoles.role, "founder")))
      .then((rows) => rows.map((row) => row.userId));
    const founderIds = new Set(founderRoleRows);
    const membershipUserIds = await db
      .select({ principalId: companyMemberships.principalId })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.status, "active"),
        ),
      );
    for (const membership of membershipUserIds) {
      if (await isInstanceAdmin(membership.principalId)) {
        founderIds.add(membership.principalId);
      }
    }
    return founderIds.size;
  }

  async function updateUserRole(
    companyId: string,
    userId: string,
    input: UpdateTeamMemberRole,
    grantedByUserId: string | null,
  ) {
    const membership = await access.getMembership(companyId, "user", userId);
    if (!membership || membership.status !== "active") throw notFound("Team member not found");

    const currentRole = await getUserRole(companyId, userId);
    if (currentRole.role === "founder" && input.role !== "founder") {
      const founders = await founderCount(companyId);
      if (founders <= 1) {
        throw conflict("You cannot remove the last founder");
      }
    }

    // Humans can only report to humans
    if (input.parentType && input.parentType !== "user") {
      throw conflict("Team members can only report to other team members");
    }

    // Handle parent assignment
    if (input.parentType !== undefined || input.parentId !== undefined) {
      if (input.parentId && input.parentType) {
        await orgHierarchy.ensureParent(companyId, input.parentType, input.parentId);
        await orgHierarchy.assertNoCycle(companyId, userId, "user", input.parentId, input.parentType);
      }
    }

    await db.transaction(async (tx) => {
      await tx.delete(userRoles).where(and(eq(userRoles.companyId, companyId), eq(userRoles.userId, userId)));
      await tx.insert(userRoles).values({
        companyId,
        userId,
        role: input.role,
        projectId: input.role === "founder" ? null : (input.projectId ?? null),
      });

      const membershipUpdate: Record<string, unknown> = {
        membershipRole: input.role,
        updatedAt: new Date(),
      };
      if (input.parentType !== undefined || input.parentId !== undefined) {
        membershipUpdate.parentType = input.parentType ?? null;
        membershipUpdate.parentId = input.parentId ?? null;
      }

      await tx
        .update(companyMemberships)
        .set(membershipUpdate)
        .where(eq(companyMemberships.id, membership.id));
    });

    await access.setPrincipalGrants(companyId, "user", userId, roleGrants(input.role, input.role === "founder" ? null : (input.projectId ?? null)), grantedByUserId);

    return getUserRole(companyId, userId);
  }

  async function removeMember(companyId: string, userId: string) {
    const membership = await access.getMembership(companyId, "user", userId);
    if (!membership || membership.status !== "active") throw notFound("Team member not found");

    // Cannot remove system admin — must transfer first
    const isTargetAdmin = await isCompanySystemAdmin(companyId, userId);
    if (isTargetAdmin) {
      throw conflict("Cannot remove the system admin. Transfer admin rights first.");
    }

    const currentRole = await getUserRole(companyId, userId);
    if (currentRole.role === "founder") {
      const founders = await founderCount(companyId);
      if (founders <= 1) throw conflict("Cannot remove the last founder");
    }

    await db.transaction(async (tx) => {
      // Re-parent all children pointing to this user
      await orgHierarchy.reparentChildren(companyId, userId, "user", tx as unknown as Db);
      // Removed humans must not remain accountable owners of open or future-visible tasks.
      await tx
        .update(issues)
        .set({ responsibleUserId: null, updatedAt: new Date() })
        .where(and(eq(issues.companyId, companyId), eq(issues.responsibleUserId, userId)));
      // Delete role assignments
      await tx.delete(userRoles).where(and(eq(userRoles.companyId, companyId), eq(userRoles.userId, userId)));
      // Delete permission grants
      await tx.delete(principalPermissionGrants).where(and(
        eq(principalPermissionGrants.companyId, companyId),
        eq(principalPermissionGrants.principalType, "user"),
        eq(principalPermissionGrants.principalId, userId),
      ));
      // Delete membership
      await tx.delete(companyMemberships).where(eq(companyMemberships.id, membership.id));
      // H8: cascade-revoke the offboarded user's MCP API keys for this company.
      // Auth only filters keys on revokedAt, so a removed member otherwise keeps
      // programmatic MCP access via any key they minted while a member.
      await tx
        .update(mcpApiKeys)
        .set({ revokedAt: new Date() })
        .where(and(
          eq(mcpApiKeys.companyId, companyId),
          eq(mcpApiKeys.userId, userId),
          isNull(mcpApiKeys.revokedAt),
        ));
    });
  }

  async function applyInviteRole(
    companyId: string,
    userId: string,
    defaultsPayload: Record<string, unknown> | null | undefined,
    grantedByUserId: string | null,
  ) {
    const metadata = parseInviteRoleMetadata(defaultsPayload);
    if (!metadata) return null;

    const result = await updateUserRole(
      companyId,
      userId,
      { role: metadata.role as UserRole, projectId: metadata.projectId },
      grantedByUserId,
    );

    // Auto-assign system admin to the first founder in a company
    if (metadata.role === "founder") {
      const founders = await founderCount(companyId);
      if (founders === 1) {
        await db
          .update(companyMemberships)
          .set({ isSystemAdmin: true, updatedAt: new Date() })
          .where(
            and(
              eq(companyMemberships.companyId, companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.principalId, userId),
            ),
          );
      }
    }

    return result;
  }

  async function updateCompanyUserProfile(
    companyId: string,
    userId: string,
    input: UpdateCompanyUserProfile,
    updatedByUserId: string | null,
  ): Promise<CompanyUserProfile> {
    const membership = await access.getMembership(companyId, "user", userId);
    if (!membership || membership.status !== "active") throw notFound("Team member not found");

    if (input.avatarAssetId) {
      const asset = await db
        .select({
          id: assets.id,
          companyId: assets.companyId,
          contentType: assets.contentType,
        })
        .from(assets)
        .where(and(eq(assets.id, input.avatarAssetId), eq(assets.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!asset) throw notFound("Avatar asset not found");
      if (!asset.contentType.startsWith("image/")) {
        throw conflict("Avatar asset must be an image");
      }
    }

    const now = new Date();
    const profilePatch: Partial<typeof companyUserProfiles.$inferInsert> = {
      updatedAt: now,
      updatedByUserId,
    };
    for (const key of ["displayName", "title", "bio", "location", "timezone", "socialLinks", "avatarAssetId"] as const) {
      if (input[key] !== undefined) {
        (profilePatch as Record<string, unknown>)[key] = input[key];
      }
    }

    const insertValues: typeof companyUserProfiles.$inferInsert = {
      companyId,
      userId,
      displayName: input.displayName ?? null,
      title: input.title ?? null,
      bio: input.bio ?? null,
      location: input.location ?? null,
      timezone: input.timezone ?? null,
      socialLinks: input.socialLinks ?? [],
      avatarAssetId: input.avatarAssetId ?? null,
      updatedAt: now,
      updatedByUserId,
    };

    const profile = await db
      .insert(companyUserProfiles)
      .values(insertValues)
      .onConflictDoUpdate({
        target: [companyUserProfiles.companyId, companyUserProfiles.userId],
        set: profilePatch,
      })
      .returning()
      .then((rows) => rows[0] ?? null);

    if (!profile) throw conflict("Unable to update team profile");
    return {
      ...profile,
      socialLinks: normalizeSocialLinks(profile.socialLinks),
    } as CompanyUserProfile;
  }

  async function isCompanySystemAdmin(companyId: string, userId: string | null | undefined): Promise<boolean> {
    if (!userId) return false;
    const rows = await db
      .select({ isSystemAdmin: companyMemberships.isSystemAdmin })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
          eq(companyMemberships.status, "active"),
        ),
      );
    return rows[0]?.isSystemAdmin === true;
  }

  async function assertSystemAdmin(companyId: string, userId: string | null | undefined): Promise<void> {
    const isAdmin = await isCompanySystemAdmin(companyId, userId);
    if (!isAdmin) throw conflict("Only the system admin can perform this action");
  }

  async function transferAdmin(companyId: string, fromUserId: string, toUserId: string): Promise<void> {
    await assertSystemAdmin(companyId, fromUserId);

    if (fromUserId === toUserId) throw conflict("Cannot transfer admin to yourself");

    const targetRole = await getUserRole(companyId, toUserId);
    if (targetRole.role !== "founder") {
      throw conflict("System admin can only be transferred to a founder");
    }

    await db.transaction(async (tx) => {
      await tx
        .update(companyMemberships)
        .set({ isSystemAdmin: false, updatedAt: new Date() })
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, fromUserId),
          ),
        );
      await tx
        .update(companyMemberships)
        .set({ isSystemAdmin: true, updatedAt: new Date() })
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, toUserId),
          ),
        );
    });
  }

  async function addMember(
    companyId: string,
    input: { name: string; email: string; role: UserRole; projectId?: string | null; parentType?: "user" | null; parentId?: string | null },
    addedByUserId: string,
  ): Promise<{ userId: string }> {
    // Fix 1 (P2): in cloud_auth, humans are admitted ONLY through the invite
    // chokepoint (approveHumanJoinRequestTx), which writes BOTH the org and the
    // company membership. Direct-add writes only the company membership, so
    // assertCompanyAccess (authz.ts:71 — org AND company required) would 403 the
    // added user on every request — a full lockout. Reject the path instead of
    // patching it; this also collapses cloud admission onto the single audited
    // seam that future seat-quota / SSO / SCIM enforcement hooks into.
    // Self-hosted has no tenant boundary and is unchanged.
    if (tenantIsolationEnforced()) {
      throw badRequest(
        "Direct add is not available in cloud mode. Send an email invite instead — it grants organization and company access together.",
      );
    }

    await assertFounder(companyId, addedByUserId);

    if (input.role === "founder") {
      await assertSystemAdmin(companyId, addedByUserId);
    }

    // Check email uniqueness within company
    const existingMembers = await db
      .select({ principalId: companyMemberships.principalId })
      .from(companyMemberships)
      .innerJoin(authUsers, eq(companyMemberships.principalId, authUsers.id))
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(authUsers.email, input.email),
        ),
      );
    if (existingMembers.length > 0) {
      throw conflict("A team member with this email already exists in this company");
    }

    // Find or create auth user by email
    const existingUsers = await db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.email, input.email));

    let userId: string;

    if (existingUsers.length > 0) {
      userId = existingUsers[0].id;
    } else {
      const newUserId = crypto.randomUUID();
      await db.insert(authUsers).values({
        id: newUserId,
        email: input.email,
        name: input.name,
        displayName: input.name,
        invitedBy: addedByUserId,
        invitedAt: new Date(),
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      userId = newUserId;
    }

    // Create membership
    await access.ensureMembership(companyId, "user", userId, input.role ?? "team_member", "active");

    // Create role (also sets parent via membership update)
    await updateUserRole(
      companyId,
      userId,
      {
        role: input.role,
        projectId: input.role === "founder" ? null : (input.projectId ?? null),
        parentType: input.parentType,
        parentId: input.parentId,
      },
      addedByUserId,
    );

    await humanCapabilities.ensureStandardDocuments(companyId, userId, addedByUserId);

    // Converge with the invited path (join-approval.ts) and founder
    // company-create (routes/companies.ts): every admit path materializes the
    // company Human Operating Profile from the member's global profile through
    // the shared helper. Best-effort — never fail the add.
    try {
      await materializeCompanyProfileFromGlobal(db, companyId, userId, addedByUserId);
    } catch {
      // best-effort — never fail the add
    }

    return { userId };
  }

  async function getReportsFor(companyId: string, userId: string) {
    // Humans reporting to this user
    const humanReports = await db
      .select({
        userId: companyMemberships.principalId,
        displayName: authUsers.displayName,
        email: authUsers.email,
        role: userRoles.role,
      })
      .from(companyMemberships)
      .innerJoin(authUsers, eq(companyMemberships.principalId, authUsers.id))
      .leftJoin(
        userRoles,
        and(eq(userRoles.companyId, companyId), eq(userRoles.userId, companyMemberships.principalId)),
      )
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.parentType, "user"),
          eq(companyMemberships.parentId, userId),
          eq(companyMemberships.status, "active"),
        ),
      );

    // Agents directly reporting to this user
    const directAgents = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, companyId),
          eq(agents.parentType, "user"),
          eq(agents.parentId, userId),
          ne(agents.status, "terminated"),
        ),
      );

    // Count sub-agents per direct agent via BFS
    const agentTrees: Array<{ rootAgentId: string; rootAgentName: string; subAgentCount: number; agentIds: string[] }> = [];
    for (const agent of directAgents) {
      let subCount = 0;
      const queue = [agent.id];
      const visited = new Set<string>();
      while (queue.length > 0) {
        const parentId = queue.shift()!;
        if (visited.has(parentId)) continue;
        visited.add(parentId);
        const children = await db
          .select({ id: agents.id })
          .from(agents)
          .where(
            and(
              eq(agents.companyId, companyId),
              eq(agents.parentType, "agent"),
              eq(agents.parentId, parentId),
              ne(agents.status, "terminated"),
            ),
          );
        subCount += children.length;
        for (const child of children) {
          queue.push(child.id);
        }
      }
      agentTrees.push({
        rootAgentId: agent.id,
        rootAgentName: agent.name,
        subAgentCount: subCount,
        agentIds: Array.from(visited),
      });
    }

    return { teamMembers: humanReports, agentTrees };
  }

  async function getDependencies(companyId: string, userId: string): Promise<MemberDependencies> {
    const reports = await getReportsFor(companyId, userId);

    const assignedRows = await db
      .select({ cnt: count() })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.assigneeUserId, userId),
          ne(issues.status, "done"),
          ne(issues.status, "cancelled"),
        ),
      );

    const createdRows = await db
      .select({ cnt: count() })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.createdByUserId, userId),
          ne(issues.status, "done"),
          ne(issues.status, "cancelled"),
        ),
      );

    return {
      teamMembers: reports.teamMembers.map((m) => ({
        userId: m.userId,
        displayName: m.displayName,
        email: m.email,
        role: (m.role as UserRole) ?? "team_member",
      })),
      agentTrees: reports.agentTrees,
      assignedTaskCount: Number(assignedRows[0]?.cnt ?? 0),
      createdTaskCount: Number(createdRows[0]?.cnt ?? 0),
    };
  }

  async function getWorkload(companyId: string, userId: string): Promise<HumanWorkload> {
    const membership = await access.getMembership(companyId, "user", userId);
    if (!membership || membership.status !== "active") throw notFound("Team member not found");

    const reports = await getReportsFor(companyId, userId);
    const managedAgentIds = Array.from(new Set(reports.agentTrees.flatMap((tree) => tree.agentIds)));
    const rootByAgentId = new Map<string, { rootAgentId: string; rootAgentName: string }>();
    for (const tree of reports.agentTrees) {
      for (const agentId of tree.agentIds) {
        rootByAgentId.set(agentId, {
          rootAgentId: tree.rootAgentId,
          rootAgentName: tree.rootAgentName,
        });
      }
    }

    const [responsibleRows, assignedRows, managedAgentRows, managedAgentTaskRows] = await Promise.all([
      db
        .select()
        .from(issues)
        .where(and(
          eq(issues.companyId, companyId),
          eq(issues.responsibleUserId, userId),
          inArray(issues.status, OPEN_WORKLOAD_STATUSES),
        )),
      db
        .select()
        .from(issues)
        .where(and(
          eq(issues.companyId, companyId),
          eq(issues.assigneeUserId, userId),
          inArray(issues.status, OPEN_WORKLOAD_STATUSES),
        )),
      managedAgentIds.length > 0
        ? db
            .select({
              id: agents.id,
              name: agents.name,
              role: agents.role,
              status: agents.status,
            })
            .from(agents)
            .where(and(
              eq(agents.companyId, companyId),
              inArray(agents.id, managedAgentIds),
              ne(agents.status, "terminated"),
            ))
        : Promise.resolve([]),
      managedAgentIds.length > 0
        ? db
            .select()
            .from(issues)
            .where(and(
              eq(issues.companyId, companyId),
              inArray(issues.assigneeAgentId, managedAgentIds),
              inArray(issues.status, OPEN_WORKLOAD_STATUSES),
            ))
        : Promise.resolve([]),
    ]);

    const managedTaskCounts = new Map<string, number>();
    for (const task of managedAgentTaskRows) {
      if (!task.assigneeAgentId) continue;
      managedTaskCounts.set(task.assigneeAgentId, (managedTaskCounts.get(task.assigneeAgentId) ?? 0) + 1);
    }

    const managedAgents = managedAgentRows.map((agent) => {
      const root = rootByAgentId.get(agent.id) ?? { rootAgentId: agent.id, rootAgentName: agent.name };
      return {
        id: agent.id,
        name: agent.name,
        role: agent.role,
        status: agent.status,
        rootAgentId: root.rootAgentId,
        rootAgentName: root.rootAgentName,
        openTaskCount: managedTaskCounts.get(agent.id) ?? 0,
      };
    });
    const agentNameById = new Map(managedAgents.map((agent) => [agent.id, agent.name]));
    const responsibleTasks = responsibleRows.map(toWorkloadTask);
    const assignedTasks = assignedRows.map(toWorkloadTask);
    const managedAgentTasks: HumanWorkloadManagedAgentTask[] = managedAgentTaskRows
      .filter((task) => Boolean(task.assigneeAgentId))
      .map((task) => {
        const managedAgentId = task.assigneeAgentId!;
        const root = rootByAgentId.get(managedAgentId) ?? {
          rootAgentId: managedAgentId,
          rootAgentName: agentNameById.get(managedAgentId) ?? "Agent",
        };
        return {
          ...toWorkloadTask(task),
          managedAgentId,
          managedAgentName: agentNameById.get(managedAgentId) ?? "Agent",
          rootAgentId: root.rootAgentId,
          rootAgentName: root.rootAgentName,
        };
      });

    const attentionItems: HumanWorkloadAttentionItem[] = [];
    for (const task of responsibleTasks) {
      const kind = workloadAttentionKind(task.status);
      if (!kind) continue;
      attentionItems.push({
        kind,
        taskId: task.id,
        identifier: task.identifier,
        title: task.title,
        status: task.status,
        source: "responsible",
        agentId: task.assigneeAgentId,
        agentName: task.assigneeAgentId ? (agentNameById.get(task.assigneeAgentId) ?? null) : null,
      });
    }
    for (const task of assignedTasks) {
      const kind = workloadAttentionKind(task.status);
      if (!kind) continue;
      attentionItems.push({
        kind,
        taskId: task.id,
        identifier: task.identifier,
        title: task.title,
        status: task.status,
        source: "assigned",
        agentId: null,
        agentName: null,
      });
    }
    for (const task of managedAgentTasks) {
      const kind = workloadAttentionKind(task.status);
      if (!kind) continue;
      attentionItems.push({
        kind,
        taskId: task.id,
        identifier: task.identifier,
        title: task.title,
        status: task.status,
        source: "managed_agent",
        agentId: task.managedAgentId,
        agentName: task.managedAgentName,
      });
    }

    return {
      companyId,
      userId,
      generatedAt: new Date(),
      summary: {
        responsibleOpenTaskCount: responsibleTasks.length,
        assignedOpenTaskCount: assignedTasks.length,
        managedAgentCount: managedAgents.length,
        managedAgentOpenTaskCount: managedAgentTasks.length,
        attentionCount: attentionItems.length,
      },
      responsibleTasks,
      assignedTasks,
      managedAgents,
      managedAgentTasks,
      attentionItems,
    };
  }

  async function reassignAndRemove(
    companyId: string,
    userId: string,
    input: {
      humanReassignments: Array<{ userId: string; newParentId: string | null }>;
      agentReassignments: Array<{ agentId: string; newParentId: string; newParentType: "user" }>;
    },
  ): Promise<void> {
    // Cannot remove system admin
    const isTargetAdmin = await isCompanySystemAdmin(companyId, userId);
    if (isTargetAdmin) {
      throw conflict("Cannot remove the system admin. Transfer admin rights first.");
    }

    // Cannot remove last founder
    const currentRole = await getUserRole(companyId, userId);
    if (currentRole.role === "founder") {
      const founders = await founderCount(companyId);
      if (founders <= 1) throw conflict("Cannot remove the last founder");
    }

    await db.transaction(async (tx) => {
      // Reassign human reports
      for (const reassignment of input.humanReassignments) {
        await tx
          .update(companyMemberships)
          .set({
            parentType: reassignment.newParentId ? "user" : null,
            parentId: reassignment.newParentId,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(companyMemberships.companyId, companyId),
              eq(companyMemberships.principalType, "user"),
              eq(companyMemberships.principalId, reassignment.userId),
            ),
          );
      }

      // Reassign agent trees (top-level only — sub-agents stay with parent agent)
      for (const reassignment of input.agentReassignments) {
        await tx
          .update(agents)
          .set({
            parentType: reassignment.newParentType,
            parentId: reassignment.newParentId,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(agents.id, reassignment.agentId),
              eq(agents.companyId, companyId),
            ),
          );
      }

      // Reassignment handles org reporting; task accountability needs explicit cleanup.
      await tx
        .update(issues)
        .set({ responsibleUserId: null, updatedAt: new Date() })
        .where(and(eq(issues.companyId, companyId), eq(issues.responsibleUserId, userId)));

      // Delete roles, permissions, membership
      await tx.delete(userRoles).where(
        and(eq(userRoles.companyId, companyId), eq(userRoles.userId, userId)),
      );
      await tx.delete(principalPermissionGrants).where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, "user"),
          eq(principalPermissionGrants.principalId, userId),
        ),
      );
      await tx.delete(companyMemberships).where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
        ),
      );
      // H8: cascade-revoke the offboarded user's MCP API keys for this company
      // (auth only filters keys on revokedAt — otherwise a removed member keeps
      // programmatic MCP access via any key minted while a member).
      await tx.update(mcpApiKeys)
        .set({ revokedAt: new Date() })
        .where(and(
          eq(mcpApiKeys.companyId, companyId),
          eq(mcpApiKeys.userId, userId),
          isNull(mcpApiKeys.revokedAt),
        ));
    });
  }

  return {
    addMember,
    assertFounder,
    assertSystemAdmin,
    applyInviteRole,
    getDependencies,
    getReportsFor,
    getWorkload,
    getUserRole,
    isCompanySystemAdmin,
    listTeam,
    reassignAndRemove,
    removeMember,
    roleGrants,
    transferAdmin,
    updateCompanyUserProfile,
    updateUserRole,
  };
}

/**
 * Copy the member's GLOBAL Human Operating Profile (`user_profiles`) into their
 * company-scoped profile (`company_user_profiles`). The single choke point
 * shared by ALL THREE admit paths — founder company-create
 * (routes/companies.ts), invited approval (`approveHumanJoinRequestTx`), and
 * manual add (`addMember`) — so a profile a member entered during onboarding is
 * never left blank on the company Team page (`listTeam` reads title/bio/
 * location/timezone/socialLinks exclusively from `company_user_profiles`).
 *
 * Contract:
 *  - Best-effort by convention: every caller wraps this in try/catch. It never
 *    swallows its own errors so callers keep full control of attribution/logging.
 *  - Transaction-aware: runs entirely on the passed `db` handle, so when a caller
 *    passes a savepoint-scoped `txDb` (the invited approval does) the write
 *    participates in that same transaction.
 *  - Null-safe: when the global profile is absent (e.g. a local_trusted synthetic
 *    operator) it writes explicit nulls + an empty socialLinks — byte-identical to
 *    the two inline blocks it replaces, and harmless.
 *
 * Field set copied: displayName, title, bio, timezone, socialLinks. `location`
 * is intentionally omitted — the global profile has no location column, matching
 * both original inline blocks exactly (no reconciliation needed).
 */
export async function materializeCompanyProfileFromGlobal(
  db: Db,
  companyId: string,
  userId: string,
  attributionUserId: string | null,
): Promise<void> {
  const globalProfile = await getUserProfile(db, userId);
  // The global PATCH route only Array.isArray-checks socialLinks, so parse-filter
  // each link through the shared validator instead of trusting the stored shape.
  const socialLinks = (globalProfile?.socialLinks ?? []).flatMap((link) => {
    const parsed = humanSocialLinkSchema.safeParse(link);
    return parsed.success ? [parsed.data] : [];
  });
  await teamService(db).updateCompanyUserProfile(
    companyId,
    userId,
    {
      displayName: globalProfile?.displayName ?? null,
      title: globalProfile?.title ?? null,
      bio: globalProfile?.bio ?? null,
      socialLinks,
      timezone: globalProfile?.timezone ?? null,
    },
    attributionUserId,
  );
}

/**
 * Repair a missing founder company profile after an idempotent company-create
 * replay without overwriting company-specific edits made after the original
 * create. The unique key makes the insert race-safe: an existing or concurrently
 * created profile wins unchanged.
 */
export async function ensureCompanyProfileFromGlobal(
  db: Db,
  companyId: string,
  userId: string,
  attributionUserId: string | null,
): Promise<void> {
  const globalProfile = await getUserProfile(db, userId);
  const socialLinks = (globalProfile?.socialLinks ?? []).flatMap((link) => {
    const parsed = humanSocialLinkSchema.safeParse(link);
    return parsed.success ? [parsed.data] : [];
  });
  await db
    .insert(companyUserProfiles)
    .values({
      companyId,
      userId,
      displayName: globalProfile?.displayName ?? null,
      title: globalProfile?.title ?? null,
      bio: globalProfile?.bio ?? null,
      timezone: globalProfile?.timezone ?? null,
      socialLinks,
      updatedByUserId: attributionUserId,
    })
    .onConflictDoNothing({
      target: [companyUserProfiles.companyId, companyUserProfiles.userId],
    });
}
