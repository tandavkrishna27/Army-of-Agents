// server/src/services/internal-agent/authorize-tool.ts
//
// Role + capability gating for Commander tool invocations.
// See finding C13 in docs/superpowers/specs/2026-05-05-sprint-1-security-fixes-design.md.

import type {
  AgentCapability,
  CommanderToolPermission,
  CommanderToolPermissions,
  UserRole,
} from "@armyofagents/shared";
import {
  COMMANDER_TOOL_PERMISSION_DEFAULT,
  ROLE_RANK,
} from "@armyofagents/shared";
import type { AgentTool, ToolCategory, ToolContext } from "./types.js";

/**
 * Maps capabilities (as stored in internal_agent_config.enabledCapabilities)
 * to tool categories. A tool whose category appears here is gated on the
 * corresponding capability being enabled. Categories not listed here are
 * always allowed (core query/coordination/file/workflow surface).
 *
 * If you add a new capability that should gate a category, add it here.
 */
export const CAPABILITY_TO_CATEGORY: Partial<Record<AgentCapability, ToolCategory>> = {
  discussion_processing: "discussion",
  system_actions: "action",
  memory_management: "memory",
};

export type ToolAuthDecision =
  | { allowed: true }
  | { allowed: false; error: "FORBIDDEN_ROLE" | "CAPABILITY_DISABLED" | "NOT_IN_ALLOWLIST"; summary: string };

export type CommanderToolPolicyDecision =
  | {
      allowed: true;
      enabled: true;
      requiresApproval: boolean;
      minimumRole: CommanderToolPermission["minimumRole"];
    }
  | {
      allowed: false;
      enabled: boolean;
      requiresApproval: boolean;
      minimumRole: CommanderToolPermission["minimumRole"];
      error: "FORBIDDEN_ROLE" | "CAPABILITY_DISABLED" | "NOT_IN_ALLOWLIST" | "TOOL_DISABLED";
      summary: string;
    };

/**
 * D2: Per-agent tool allowlist for AoA and organization agents.
 *
 * Both model runtimes use default-deny semantics: absent/empty = deny all.
 */
export function authorizeToolInvocation(
  tool: AgentTool,
  userRole: string,
  enabledCapabilities: readonly string[] | undefined,
  opts?: { agentKind?: string; toolAllowlist?: readonly string[] },
): ToolAuthDecision {
  const capabilities = enabledCapabilities ?? [];
  // Model-runtime allowlist gate (default-deny for AoA and org agents).
  // Checked BEFORE role/capability gates so a misconfigured allowlist fails
  // closed rather than silently falling through to the less-restrictive gates.
  if (opts?.agentKind === "aoa" || opts?.agentKind === "org") {
    const allowlist = opts.toolAllowlist;
    if (!allowlist || allowlist.length === 0 || !allowlist.includes(tool.name)) {
      return {
        allowed: false,
        error: "NOT_IN_ALLOWLIST",
        summary: `Agent tool allowlist does not include '${tool.name}'`,
      };
    }
  }

  // Fail closed on unknown role strings (e.g., a malformed
  // AOA_SESSION_USER_ROLE env var). Unknown roles map to no rank.
  // If requiredRole is absent the tool is open to all roles — skip the gate.
  const userRank = ROLE_RANK[userRole as UserRole];
  if (tool.requiredRole !== undefined) {
    if (userRank === undefined || userRank < ROLE_RANK[tool.requiredRole]) {
      return {
        allowed: false,
        error: "FORBIDDEN_ROLE",
        summary: `Role '${userRole}' cannot invoke '${tool.name}' (requires '${tool.requiredRole}')`,
      };
    }
  }

  // Capability check
  for (const [cap, category] of Object.entries(CAPABILITY_TO_CATEGORY)) {
    if (tool.category !== category) continue;
    if (!capabilities.includes(cap)) {
      return {
        allowed: false,
        error: "CAPABILITY_DISABLED",
        summary: `Tool '${tool.name}' (category '${category}') requires capability '${cap}' which is not enabled for this company`,
      };
    }
  }

  return { allowed: true };
}

function getCommanderPermission(
  toolName: string,
  permissions?: CommanderToolPermissions | null,
): CommanderToolPermission {
  return permissions?.[toolName] ?? COMMANDER_TOOL_PERMISSION_DEFAULT;
}

function roleBlocked(
  userRole: string,
  requiredRole: CommanderToolPermission["minimumRole"],
): boolean {
  const userRank = ROLE_RANK[userRole as UserRole];
  return userRank === undefined || userRank < ROLE_RANK[requiredRole];
}

export function resolveCommanderToolPolicy(
  tool: AgentTool,
  ctx: Pick<
    ToolContext,
    | "userRole"
    | "enabledCapabilities"
    | "agentKind"
    | "toolAllowlist"
    | "commanderToolPermissions"
    | "runtimeApprovalsEnabled"
  >,
): CommanderToolPolicyDecision {
  const permission = getCommanderPermission(
    tool.name,
    ctx.commanderToolPermissions,
  );
  const requiresApproval =
    ctx.runtimeApprovalsEnabled !== false &&
    (tool.requiresConfirmation || permission.requireConfirmation);

  const baseDecision = authorizeToolInvocation(
    tool,
    ctx.userRole,
    ctx.enabledCapabilities,
    { agentKind: ctx.agentKind, toolAllowlist: ctx.toolAllowlist },
  );
  if (!baseDecision.allowed) {
    return {
      ...baseDecision,
      enabled: permission.enabled,
      requiresApproval,
      minimumRole: permission.minimumRole,
    };
  }

  if (!permission.enabled) {
    return {
      allowed: false,
      enabled: false,
      requiresApproval,
      minimumRole: permission.minimumRole,
      error: "TOOL_DISABLED",
      summary: `Tool '${tool.name}' is disabled for Commander`,
    };
  }

  if (roleBlocked(ctx.userRole, permission.minimumRole)) {
    return {
      allowed: false,
      enabled: true,
      requiresApproval,
      minimumRole: permission.minimumRole,
      error: "FORBIDDEN_ROLE",
      summary: `Role '${ctx.userRole}' cannot invoke '${tool.name}' via Commander (requires '${permission.minimumRole}')`,
    };
  }

  return {
    allowed: true,
    enabled: true,
    requiresApproval,
    minimumRole: permission.minimumRole,
  };
}
