import { normalizeAgentUrlKey } from "@armyofagents/shared";

export interface AgentShortnameRow {
  id: string;
  name: string;
  status: string;
  /**
   * Agent kind ("org" | "aoa" | "platform"). Optional so existing callers that
   * only select id/name/status keep compiling; used to tailor the collision
   * message (e.g. point at the AoA Team tab for built-in crew agents).
   */
  kind?: string | null;
}

interface AgentShortnameCollisionOptions {
  excludeAgentId?: string | null;
}

/**
 * Returns the first non-terminated agent whose normalized shortname matches the
 * candidate, or null. Org and AoA-crew agents share ONE shortname namespace on
 * purpose, so that `@shortname` references (MCP/CLI, `resolveByReference`) stay
 * unambiguous. Callers inspect the returned row's `kind` to explain WHICH agent
 * conflicts.
 */
export function findAgentShortnameCollision(
  candidateName: string,
  existingAgents: AgentShortnameRow[],
  options?: AgentShortnameCollisionOptions,
): AgentShortnameRow | null {
  const candidateShortname = normalizeAgentUrlKey(candidateName);
  if (!candidateShortname) return null;

  return (
    existingAgents.find((agent) => {
      if (agent.status === "terminated") return false;
      if (options?.excludeAgentId && agent.id === options.excludeAgentId) return false;
      return normalizeAgentUrlKey(agent.name) === candidateShortname;
    }) ?? null
  );
}

export function hasAgentShortnameCollision(
  candidateName: string,
  existingAgents: AgentShortnameRow[],
  options?: AgentShortnameCollisionOptions,
): boolean {
  return findAgentShortnameCollision(candidateName, existingAgents, options) !== null;
}

export function deduplicateAgentName(
  candidateName: string,
  existingAgents: AgentShortnameRow[],
): string {
  if (!hasAgentShortnameCollision(candidateName, existingAgents)) {
    return candidateName;
  }
  for (let i = 2; i <= 100; i += 1) {
    const suffixed = `${candidateName} ${i}`;
    if (!hasAgentShortnameCollision(suffixed, existingAgents)) {
      return suffixed;
    }
  }
  return `${candidateName} ${Date.now()}`;
}
