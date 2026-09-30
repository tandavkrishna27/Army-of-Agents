import type { Request } from "express";
import type { Db } from "@armyofagents/db";
import type { UserRole } from "@armyofagents/shared";
import { forbidden, unauthorized } from "../errors.js";
import { permissionService } from "../services/permissions.js";
import type { EntityType, PermissionAction } from "../services/permissions.js";
import { tenantIsolationEnforced } from "../config/deployment-mode.js";

/**
 * RBAC helper that extracts the userId from the request actor.
 * Returns null for agent actors (agents use separate permission paths).
 */
function getUserIdFromRequest(req: Request): string | null {
  if (req.actor.type === "board") {
    return req.actor.userId ?? null;
  }
  return null;
}

/**
 * Asserts that the current user has at least one of the specified roles.
 * Founder always passes. Agents are skipped (they use separate permission paths).
 * In local_trusted mode, all users are treated as having full access.
 */
export async function assertRole(
  db: Db,
  req: Request,
  companyId: string,
  ...roles: UserRole[]
): Promise<void> {
  // Agents bypass role checks — they have separate permission paths
  if (req.actor.type === "agent") return;

  if (req.actor.type === "none") throw unauthorized();

  // local_trusted mode: full access
  if (req.actor.source === "local_implicit") return;

  // Instance admin: full access
  // B1 defense-in-depth: no data-plane instance_admin bypass in cloud_auth
  // (belt against any future path that sets isInstanceAdmin true; the actor
  // clamp already forces it false there). local_implicit bypasses stay.
  if (req.actor.isInstanceAdmin && !tenantIsolationEnforced()) return;

  const userId = getUserIdFromRequest(req);
  if (!userId) throw unauthorized();

  const perms = permissionService(db);
  const effectiveRole = await perms.getEffectiveRole(companyId, userId);

  // Founder always passes
  if (effectiveRole === "founder") return;

  if (!roles.includes(effectiveRole)) {
    throw forbidden(`Requires one of: ${roles.join(", ")}`);
  }
}

/**
 * Human-governance role gate. Unlike assertRole, this never inherits the
 * historical agent bypass used by mixed board/agent workflow APIs.
 */
export async function assertHumanRole(
  db: Db,
  req: Request,
  companyId: string,
  ...roles: UserRole[]
): Promise<void> {
  if (req.actor.type === "none") throw unauthorized();
  if (req.actor.type !== "board") throw forbidden("Board access required");
  await assertRole(db, req, companyId, ...roles);
}

/**
 * Asserts that the current user has access to the specified department.
 * Founder: full access. Team lead: only their department. Team member: no department management.
 *
 * Bypasses, in order, BEFORE any department logic runs: agent actors,
 * local-trusted (`local_implicit`) requests, and instance admins. Only then is
 * the department scope consulted. Callers that need agent traffic gated must do
 * so themselves — this helper lets it straight through.
 *
 * `departmentId` may be null for a company-wide entity with no parent
 * department (D21 — e.g. the AoA crew team). There is no department to be lead
 * of, so the lead-scoped grant cannot apply: only the founder / instance-admin
 * / local-trusted paths above pass. Fails closed for team leads and members.
 */
export async function assertDepartmentAccess(
  db: Db,
  req: Request,
  companyId: string,
  departmentId: string | null,
): Promise<void> {
  if (req.actor.type === "agent") return;
  if (req.actor.type === "none") throw unauthorized();
  if (req.actor.source === "local_implicit") return;
  // B1 defense-in-depth: no data-plane instance_admin bypass in cloud_auth
  // (belt against any future path that sets isInstanceAdmin true; the actor
  // clamp already forces it false there). local_implicit bypasses stay.
  if (req.actor.isInstanceAdmin && !tenantIsolationEnforced()) return;

  const userId = getUserIdFromRequest(req);
  if (!userId) throw unauthorized();

  const perms = permissionService(db);
  if (await perms.isFounder(companyId, userId)) return;

  if (departmentId === null) {
    throw forbidden("Company-wide entity — founder access required");
  }

  const isLead = await perms.isTeamLeadForDepartment(companyId, userId, departmentId);
  if (!isLead) {
    throw forbidden("No access to this department");
  }
}

/**
 * Asserts that the current user can perform the specified action on a memory item.
 * Implements memory-specific RBAC rules.
 */
export async function assertMemoryAccess(
  db: Db,
  req: Request,
  companyId: string,
  action: PermissionAction,
  memoryItem?: {
    layer?: string | null;
    departmentId?: string | null;
    visibility?: string | null;
  },
): Promise<void> {
  if (req.actor.type === "agent") {
    // Agents can only create pending items (enforced by memory service)
    if (action !== "create" && action !== "read") {
      throw forbidden("Agents can only create or read memory items");
    }
    return;
  }

  if (req.actor.type === "none") throw unauthorized();
  if (req.actor.source === "local_implicit") return;
  // B1 defense-in-depth: no data-plane instance_admin bypass in cloud_auth
  // (belt against any future path that sets isInstanceAdmin true; the actor
  // clamp already forces it false there). local_implicit bypasses stay.
  if (req.actor.isInstanceAdmin && !tenantIsolationEnforced()) return;

  const userId = getUserIdFromRequest(req);
  if (!userId) throw unauthorized();

  const perms = permissionService(db);
  const allowed = await perms.canAccessMemory(companyId, userId, action, memoryItem);
  if (!allowed) {
    throw forbidden(`Insufficient permissions for memory ${action}`);
  }
}

/**
 * Asserts that the current user can approve/reject memory items.
 */
export async function assertMemoryApproval(
  db: Db,
  req: Request,
  companyId: string,
  memoryItem?: {
    layer?: string | null;
    departmentId?: string | null;
  },
): Promise<void> {
  if (req.actor.type === "agent") {
    throw forbidden("Agents cannot approve memory items");
  }

  if (req.actor.type === "none") throw unauthorized();
  if (req.actor.source === "local_implicit") return;
  // B1 defense-in-depth: no data-plane instance_admin bypass in cloud_auth
  // (belt against any future path that sets isInstanceAdmin true; the actor
  // clamp already forces it false there). local_implicit bypasses stay.
  if (req.actor.isInstanceAdmin && !tenantIsolationEnforced()) return;

  const userId = getUserIdFromRequest(req);
  if (!userId) throw unauthorized();

  const perms = permissionService(db);
  const allowed = await perms.canApproveMemory(companyId, userId, memoryItem);
  if (!allowed) {
    throw forbidden("Insufficient permissions to approve/reject memory items");
  }
}

/**
 * Asserts that the current user can perform the specified action on an entity.
 * General-purpose permission check.
 */
export async function assertEntityAccess(
  db: Db,
  req: Request,
  companyId: string,
  entityType: EntityType,
  action: PermissionAction,
  context?: {
    departmentId?: string | null;
    assigneeUserId?: string | null;
    layer?: string | null;
    visibility?: string | null;
  },
): Promise<void> {
  if (req.actor.type === "agent") return; // Agents use separate permission paths
  if (req.actor.type === "none") throw unauthorized();
  if (req.actor.source === "local_implicit") return;
  // B1 defense-in-depth: no data-plane instance_admin bypass in cloud_auth
  // (belt against any future path that sets isInstanceAdmin true; the actor
  // clamp already forces it false there). local_implicit bypasses stay.
  if (req.actor.isInstanceAdmin && !tenantIsolationEnforced()) return;

  const userId = getUserIdFromRequest(req);
  if (!userId) throw unauthorized();

  const perms = permissionService(db);
  const allowed = await perms.canAccessEntity(companyId, userId, entityType, action, context);
  if (!allowed) {
    throw forbidden(`Insufficient permissions for ${entityType} ${action}`);
  }
}
