// server/src/services/internal-agent/tools/crew-role-map.ts
//
// Crew role → agent resolution. Extracted from propose-crew-work.ts so both the
// direct tool path AND the controller commit handler (thread-agent-actions.ts)
// resolve assignees the same way. Source of truth for names: ensure-*.ts files.

import { and, eq, ne } from "drizzle-orm";
import { agents } from "@armyofagents/db";

/** Only crew AoA roles are listed; anything else resolves as unassigned (no error). */
const ROLE_TO_AGENT_NAME: Record<string, string> = {
  adjutant: "Adjutant",
  engineer: "Engineer",
  maker: "Maker", // legacy alias for Engineer
  scout: "Scout",
  planner: "Planner",
  navigator: "Navigator",
  router: "Navigator", // legacy alias for Navigator
  memory_keeper: "Memory Keeper",
  scribe: "Scribe",
};

/** Pure: role string → crew agent name, or undefined for unknown/empty. */
export function roleToAgentName(role: string): string | undefined {
  return ROLE_TO_AGENT_NAME[role.toLowerCase().trim()];
}

/**
 * Resolve a role string → crew agent UUID for the given company.
 * Returns undefined when the role is unknown or no matching agent exists.
 */
export async function resolveRoleToAgentId(
  db: { select: Function },
  companyId: string,
  role: string,
): Promise<string | undefined> {
  const agentName = roleToAgentName(role);
  if (!agentName) return undefined;

  const rows = await (db as any)
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        eq(agents.kind, "aoa"),
        eq(agents.name, agentName),
        ne(agents.status, "terminated"),
      ),
    )
    .limit(1);

  return rows[0]?.id as string | undefined;
}
