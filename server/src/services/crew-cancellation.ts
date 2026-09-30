import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { internalAgentRuns } from "@armyofagents/db";

/**
 * Cancel all running internal_agent_runs for a specific agent.
 * Called by cancelActiveForAgent to reach crew sub-agent runs.
 */
export async function cancelCrewRunsForAgent(db: Db, agentId: string): Promise<void> {
  await db
    .update(internalAgentRuns)
    .set({
      status: "cancelled",
      errorMessage: "Cancelled due to agent pause",
      completedAt: new Date(),
    })
    .where(and(eq(internalAgentRuns.agentId, agentId), eq(internalAgentRuns.status, "running")));
}

/**
 * Cancel all running internal_agent_runs for a company.
 * Called by cancelBudgetScopeWork (company scope) to reach crew sub-agent runs.
 */
export async function cancelCrewRunsForCompany(db: Db, companyId: string): Promise<void> {
  await db
    .update(internalAgentRuns)
    .set({
      status: "cancelled",
      errorMessage: "Cancelled due to company budget hard-stop",
      completedAt: new Date(),
    })
    .where(and(eq(internalAgentRuns.companyId, companyId), eq(internalAgentRuns.status, "running")));
}
