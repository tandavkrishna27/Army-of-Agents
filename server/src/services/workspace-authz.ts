import type { Request } from "express";
import type { Db } from "@armyofagents/db";
import { forbidden, unauthorized } from "../errors.js";
import { permissionService } from "./permissions.js";

/**
 * Decision returned by {@link checkCanControlWorkspace}. Either the caller is
 * allowed to mutate workspace runtime state or a terminal HTTP status is
 * returned with an error message suitable for the response.
 */
export type WorkspaceControlAuthzDecision =
  | { allowed: true }
  | { allowed: false; status: 401 | 403; message: string };

export interface WorkspaceControlAuthzTarget {
  companyId: string;
  projectId: string | null;
}

const DENY_MESSAGE = "Insufficient permissions to control this workspace";
const SHELL_COMMAND_DENY_MESSAGE = "Only founders can configure workspace shell commands";

/**
 * Synchronous actor-shape check (no DB). Returns null if further DB-backed role
 * lookup is required for a terminal decision.
 */
function checkActorShape(req: Request): WorkspaceControlAuthzDecision | null {
  if (req.actor.type === "none") {
    return { allowed: false, status: 401, message: "Authentication required" };
  }
  if (req.actor.type === "agent" || req.actor.type === "mcp") {
    return { allowed: false, status: 403, message: DENY_MESSAGE };
  }
  if (req.actor.type === "board") {
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
      return { allowed: true };
    }
    return null;
  }
  // Unrecognised actor shape — fail closed.
  return { allowed: false, status: 403, message: "Unsupported actor" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function workspaceConfigPatchHasShellCommands(configPatch: unknown): boolean {
  if (!isRecord(configPatch)) return false;
  if (
    Object.prototype.hasOwnProperty.call(configPatch, "provisionCommand")
    || Object.prototype.hasOwnProperty.call(configPatch, "teardownCommand")
    || Object.prototype.hasOwnProperty.call(configPatch, "cleanupCommand")
  ) {
    return true;
  }

  const workspaceRuntime = configPatch.workspaceRuntime;
  if (!isRecord(workspaceRuntime)) return false;
  const services = workspaceRuntime.services;
  if (!Array.isArray(services)) return false;
  return services.some(
    (service) =>
      isRecord(service)
      && Object.prototype.hasOwnProperty.call(service, "command"),
  );
}

/**
 * Stronger gate for patches that introduce or edit shell command fields.
 * Runtime service control can be delegated to founders and scoped team leads,
 * but executable command configuration remains founder-only and human-only.
 */
export async function checkCanConfigureWorkspaceShellCommands(
  db: Db,
  req: Request,
  workspace: WorkspaceControlAuthzTarget,
): Promise<WorkspaceControlAuthzDecision> {
  if (req.actor.type === "none") {
    return { allowed: false, status: 401, message: "Authentication required" };
  }
  if (req.actor.type === "agent" || req.actor.type === "mcp") {
    return { allowed: false, status: 403, message: SHELL_COMMAND_DENY_MESSAGE };
  }
  if (req.actor.type !== "board") {
    return { allowed: false, status: 403, message: "Unsupported actor" };
  }
  if (req.actor.source === "local_implicit") {
    return { allowed: true };
  }

  const userId = req.actor.userId;
  if (!userId) {
    return { allowed: false, status: 401, message: "Authentication required" };
  }

  const permSvc = permissionService(db);
  const roles = await permSvc.getUserRoles(workspace.companyId, userId);
  if (roles.some((r) => r.role === "founder")) {
    return { allowed: true };
  }

  return { allowed: false, status: 403, message: SHELL_COMMAND_DENY_MESSAGE };
}

export async function assertCanConfigureWorkspaceShellCommands(
  db: Db,
  req: Request,
  workspace: WorkspaceControlAuthzTarget,
): Promise<void> {
  const decision = await checkCanConfigureWorkspaceShellCommands(db, req, workspace);
  if (decision.allowed) return;
  if (decision.status === 401) throw unauthorized(decision.message);
  throw forbidden(decision.message);
}

/**
 * Scope-aware permission check for mutating workspace runtime state. Founders
 * (in the workspace's company) and team_leads scoped to the workspace's
 * project (or company-wide, i.e. `projectId = null`) may control the
 * workspace. Everyone else — including team_members and users with no role
 * in the company — is denied.
 */
export async function checkCanControlWorkspace(
  db: Db,
  req: Request,
  workspace: WorkspaceControlAuthzTarget,
): Promise<WorkspaceControlAuthzDecision> {
  const shape = checkActorShape(req);
  if (shape) return shape;
  if (req.actor.type !== "board") {
    return { allowed: false, status: 403, message: "Unsupported actor" };
  }

  const userId = req.actor.userId;
  if (!userId) {
    return { allowed: false, status: 401, message: "Authentication required" };
  }
  const permSvc = permissionService(db);
  const roles = await permSvc.getUserRoles(workspace.companyId, userId);

  if (roles.length === 0) {
    return { allowed: false, status: 403, message: DENY_MESSAGE };
  }
  if (roles.some((r) => r.role === "founder")) {
    return { allowed: true };
  }

  const teamLeadAllowed = roles.some(
    (r) =>
      r.role === "team_lead"
      && (r.projectId === null
        || (workspace.projectId !== null && r.projectId === workspace.projectId)),
  );
  if (teamLeadAllowed) {
    return { allowed: true };
  }

  return { allowed: false, status: 403, message: DENY_MESSAGE };
}

/**
 * Throws {@link HttpError} (401 or 403) when the caller cannot control the
 * given workspace; returns without side effects otherwise.
 */
export async function assertCanControlWorkspace(
  db: Db,
  req: Request,
  workspace: WorkspaceControlAuthzTarget,
): Promise<void> {
  const decision = await checkCanControlWorkspace(db, req, workspace);
  if (decision.allowed) return;
  if (decision.status === 401) throw unauthorized(decision.message);
  throw forbidden(decision.message);
}

export async function assertCanOverrideTaskWorkspace(
  db: Db,
  req: Request,
  workspace: WorkspaceControlAuthzTarget,
): Promise<void> {
  await assertCanControlWorkspace(db, req, workspace);
}
