export type NormalizedAgentPermissions = Record<string, unknown> & {
  canCreateAgents: boolean;
};

export function defaultPermissionsForRole(role: string): NormalizedAgentPermissions {
  return {
    // CXO-tier agents are auto-empowered to hire (no need to set
    // canCreateAgents explicitly). Was `=== "ceo"` before the role-enum
    // cleanup; see plan
    // docs/superpowers/plans/2026-04-30-agent-role-3-tier-cleanup.md.
    canCreateAgents: role === "cxo",
  };
}

export function normalizeAgentPermissions(
  permissions: unknown,
  role: string,
): NormalizedAgentPermissions {
  const defaults = defaultPermissionsForRole(role);
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) {
    return defaults;
  }

  const record = permissions as Record<string, unknown>;
  return {
    canCreateAgents:
      typeof record.canCreateAgents === "boolean"
        ? record.canCreateAgents
        : defaults.canCreateAgents,
  };
}
