import { eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { aoaAgentTriggers } from "@armyofagents/db";
import { ROLE_MIN_AUTONOMY, type CrewRole } from "./autonomy.js";
const KNOWN_ROLES = new Set<string>(Object.keys(ROLE_MIN_AUTONOMY));
export async function resolveCrewRole(db: Db, agentId: string): Promise<CrewRole | null> {
  const rows = await db
    .select({ config: aoaAgentTriggers.config })
    .from(aoaAgentTriggers)
    .where(eq(aoaAgentTriggers.agentId, agentId));
  for (const r of rows) {
    const role = (r.config as Record<string, unknown> | null)?.role;
    if (typeof role === "string" && KNOWN_ROLES.has(role)) return role as CrewRole;
  }
  return null;
}
