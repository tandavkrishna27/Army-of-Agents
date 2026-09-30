import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { userRoles } from "@armyofagents/db";
import type { UserRole } from "@armyofagents/shared";

/**
 * Entity types for permission checks.
 */
export type EntityType = "task" | "goal" | "memory" | "agent" | "brief" | "artifact" | "suggestion";

/**
 * Actions for permission checks.
 */
export type PermissionAction = "create" | "read" | "update" | "delete" | "approve";

/**
 * Memory layer types for memory-specific RBAC.
 */
export type MemoryLayer = "identity" | "domain" | "active_context" | "working";

interface UserRoleRow {
  id: string;
  companyId: string;
  userId: string;
  role: string;
  projectId: string | null;
}

export function permissionService(db: Db) {
  /**
   * Get all roles for a user within a company.
   * Returns all role assignments (company-wide + department-scoped).
   */
  async function getUserRoles(companyId: string, userId: string): Promise<UserRoleRow[]> {
    return db
      .select()
      .from(userRoles)
      .where(and(eq(userRoles.companyId, companyId), eq(userRoles.userId, userId)));
  }

  /**
   * Get the effective role for a user. If the user has multiple roles,
   * returns the highest privilege level.
   * Role hierarchy: founder > team_lead > team_member
   * No role assigned → treated as team_member.
   */
  async function getEffectiveRole(companyId: string, userId: string): Promise<UserRole> {
    const roles = await getUserRoles(companyId, userId);
    if (roles.length === 0) return "team_member";
    if (roles.some((r) => r.role === "founder")) return "founder";
    if (roles.some((r) => r.role === "team_lead")) return "team_lead";
    return "team_member";
  }

  /**
   * Check if a user is a founder (short-circuits all permission checks).
   */
  async function isFounder(companyId: string, userId: string): Promise<boolean> {
    const roles = await getUserRoles(companyId, userId);
    return roles.some((r) => r.role === "founder");
  }

  /**
   * Get all department IDs where the user is a team_lead.
   */
  async function getTeamLeadDepartments(companyId: string, userId: string): Promise<string[]> {
    const roles = await getUserRoles(companyId, userId);
    return roles
      .filter((r) => r.role === "team_lead" && r.projectId != null)
      .map((r) => r.projectId!);
  }

  /**
   * Check if user has team_lead access for a specific department.
   */
  async function isTeamLeadForDepartment(
    companyId: string,
    userId: string,
    departmentId: string,
  ): Promise<boolean> {
    const departments = await getTeamLeadDepartments(companyId, userId);
    return departments.includes(departmentId);
  }

  /**
   * Get all team_lead rows for a user within a company, including the
   * company-wide scope (where projectId is null). Differs from
   * {@link getTeamLeadDepartments}, which filters out null-projectId rows.
   */
  async function getTeamLeadScope(
    companyId: string,
    userId: string,
  ): Promise<{ projectId: string | null }[]> {
    return db
      .select({ projectId: userRoles.projectId })
      .from(userRoles)
      .where(
        and(
          eq(userRoles.companyId, companyId),
          eq(userRoles.userId, userId),
          eq(userRoles.role, "team_lead"),
        ),
      );
  }

  /**
   * Memory-specific RBAC:
   * - Founder: full CRUD on all layers, all scopes
   * - Team lead: can create/approve domain and active_context items for THEIR department.
   *              Cannot touch identity layer or other departments.
   * - Team member: can create pending items only (same as agents — must be approved).
   */
  async function canAccessMemory(
    companyId: string,
    userId: string,
    action: PermissionAction,
    memoryItem?: {
      layer?: string | null;
      departmentId?: string | null;
      visibility?: string | null;
    },
  ): Promise<boolean> {
    // Founder: full access to everything
    if (await isFounder(companyId, userId)) return true;

    const effectiveRole = await getEffectiveRole(companyId, userId);

    if (action === "read") {
      // All roles can read memory items (shared items are readable by all)
      return true;
    }

    if (effectiveRole === "team_lead") {
      const layer = memoryItem?.layer;
      const departmentId = memoryItem?.departmentId;

      // Team lead cannot touch identity layer
      if (layer === "identity") return false;

      // For create action without specific item context, allow (will be validated on insert)
      if (action === "create" && !memoryItem) return true;

      // Team lead can create/approve domain and active_context for THEIR department
      if (layer === "domain" || layer === "active_context") {
        if (!departmentId) return false;
        return isTeamLeadForDepartment(companyId, userId, departmentId);
      }

      // For working layer, team lead can manage items in their department
      if (layer === "working") {
        if (!departmentId) return false;
        return isTeamLeadForDepartment(companyId, userId, departmentId);
      }

      // Shared items: writable only by owning department's team lead or founder
      if (memoryItem?.visibility === "shared" && departmentId) {
        if (action === "update" || action === "delete") {
          return isTeamLeadForDepartment(companyId, userId, departmentId);
        }
      }

      // For items without a layer, team lead can manage in their department
      if (departmentId) {
        return isTeamLeadForDepartment(companyId, userId, departmentId);
      }

      // No department → only founder can manage
      return false;
    }

    // team_member: can only create pending items
    if (effectiveRole === "team_member") {
      return action === "create";
    }

    return false;
  }

  /**
   * Check if user can approve/reject memory items.
   * - Founder: can approve all layers (sole gatekeeper for identity + domain).
   * - Team lead: can approve only `active_context` for their own department.
   * - Team member: cannot approve.
   * (Decisions #15/#52; R5 — team leads must NOT approve domain.)
   */
  async function canApproveMemory(
    companyId: string,
    userId: string,
    memoryItem?: {
      layer?: string | null;
      departmentId?: string | null;
    },
  ): Promise<boolean> {
    if (await isFounder(companyId, userId)) return true;

    const effectiveRole = await getEffectiveRole(companyId, userId);
    if (effectiveRole !== "team_lead") return false;

    // R5: the founder is the sole gatekeeper for identity AND domain (Decisions
    // #15/#52). A team lead may approve only `active_context` for their own
    // department (working memory is auto-created and never gated through here).
    const layer = memoryItem?.layer;
    if (layer !== "active_context") return false;

    const departmentId = memoryItem?.departmentId;
    if (!departmentId) return false;

    return isTeamLeadForDepartment(companyId, userId, departmentId);
  }

  /**
   * General entity permission check.
   */
  async function canAccessEntity(
    companyId: string,
    userId: string,
    entityType: EntityType,
    action: PermissionAction,
    context?: {
      departmentId?: string | null;
      assigneeUserId?: string | null;
      layer?: string | null;
      visibility?: string | null;
    },
  ): Promise<boolean> {
    // Founder always bypasses
    if (await isFounder(companyId, userId)) return true;

    const effectiveRole = await getEffectiveRole(companyId, userId);

    switch (entityType) {
      case "memory":
        return canAccessMemory(companyId, userId, action, context);

      case "task":
        if (action === "read") return true; // All can read tasks
        if (effectiveRole === "team_lead") {
          // Team lead can manage tasks in their department
          if (context?.departmentId) {
            return isTeamLeadForDepartment(companyId, userId, context.departmentId);
          }
          return true; // Allow if no department context
        }
        if (effectiveRole === "team_member") {
          // Team member: write only assigned tasks, or create new ones
          if (context?.assigneeUserId === userId) return true;
          return action === "create";
        }
        return false;

      case "goal":
        if (action === "read") return true;
        if (effectiveRole === "team_lead") {
          if (context?.departmentId) {
            return isTeamLeadForDepartment(companyId, userId, context.departmentId);
          }
          return true;
        }
        return false; // team_member cannot manage goals

      case "agent":
        // Founder only for agent configuration
        return action === "read";

      case "brief":
        if (action === "read") return true;
        // Founder only for approval
        return false;

      case "artifact":
        if (action === "read") return true;
        if (effectiveRole === "team_lead") return true;
        return action === "create"; // team_member can create

      case "suggestion":
        if (action === "read") return true;
        // Founder only for accept/dismiss
        return false;

      default:
        return false;
    }
  }

  /**
   * Assign a role to a user, handling NULL projectId uniqueness.
   * PostgreSQL treats NULLs as distinct in unique indexes, so we do
   * check-before-insert for company-wide roles (projectId IS NULL).
   */
  async function assignRole(
    companyId: string,
    userId: string,
    role: UserRole,
    projectId: string | null = null,
  ) {
    if (projectId === null) {
      // Check for existing company-wide role
      const existing = await db
        .select()
        .from(userRoles)
        .where(
          and(
            eq(userRoles.companyId, companyId),
            eq(userRoles.userId, userId),
            isNull(userRoles.projectId),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (existing) {
        // Update existing company-wide role
        return db
          .update(userRoles)
          .set({ role, updatedAt: new Date() })
          .where(eq(userRoles.id, existing.id))
          .returning()
          .then((rows) => rows[0]);
      }
    }

    return db
      .insert(userRoles)
      .values({ companyId, userId, role, projectId })
      .returning()
      .then((rows) => rows[0]);
  }

  /**
   * Remove a role assignment.
   */
  async function removeRole(companyId: string, userId: string, projectId: string | null = null) {
    const conditions = [eq(userRoles.companyId, companyId), eq(userRoles.userId, userId)];
    if (projectId === null) {
      conditions.push(isNull(userRoles.projectId));
    } else {
      conditions.push(eq(userRoles.projectId, projectId));
    }

    return db
      .delete(userRoles)
      .where(and(...conditions))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  return {
    getUserRoles,
    getEffectiveRole,
    isFounder,
    getTeamLeadDepartments,
    isTeamLeadForDepartment,
    getTeamLeadScope,
    canAccessMemory,
    canApproveMemory,
    canAccessEntity,
    assignRole,
    removeRole,
  };
}
