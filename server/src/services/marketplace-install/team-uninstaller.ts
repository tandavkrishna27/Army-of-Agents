import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  teams,
  teamMembers,
  agents,
  aoaAgentTriggers,
  marketplaceInstallOperations,
} from "@armyofagents/db";
import { logger } from "../../middleware/logger.js";
import { protectedAgentsIn } from "../protected-agents.js";

export interface UninstallTeamOpts {
  db: Db;
  companyId: string;
  teamId: string;
}

/** A protected agent this uninstall detached instead of destroying. */
export interface RetainedProtectedAgent {
  id: string;
  name: string;
  /** Canonical protected-role slug, e.g. `steward`. */
  role: string;
  /** Why it is protected — founder-facing, from `PROTECTED_AGENT_ROLES`. */
  why: string;
}

export interface UninstallTeamResult {
  deletedAgentIds: string[];
  /**
   * Protected agents kept alive and detached. Carries the reason each was kept
   * because the founder needs to see *which* and *why*, not just a count — the
   * route projects the ids out of this as `retainedAgentIds` rather than the
   * service returning the same set twice.
   */
  retainedAgents: RetainedProtectedAgent[];
}

/**
 * Reverse of installTeam: delete agents + trigger rows + team row.
 * Skills are left in place — they may be shared with other agents.
 * The entire delete is wrapped in a single Postgres transaction (all-or-nothing).
 * Safe to call multiple times (idempotent: second call returns empty deletedAgentIds
 * because the team row is gone after the first run).
 *
 * Cascade order:
 *   1. aoaAgentTriggers   WHERE agentId IN (destroyed agents)
 *   2. agents             WHERE companyId + id IN (destroyed agents) → FK-cascades team_members
 *   3. teams              WHERE companyId + id = teamId              → FK-cascades team_members
 *   4. marketplace_install_operations                                → audit log
 *
 * ── Protected agents (D23): detach, don't destroy ───────────────────────────
 *
 * This function deletes member agents with raw SQL, so **`DELETE /agents/:id`'s
 * guards never see it** — a per-agent route check cannot cover this path. Any
 * member that is a protected AoA agent ({@link protectedAgentsIn}) is therefore
 * excluded from BOTH deletes: the agent row and its `aoa_agent_triggers` rows
 * survive. Deleting the team row FK-cascades away its `team_members` row, which
 * is the whole detachment — agents are not owned by teams (`teams.dismantle`
 * dismantles a team without touching its agents, and a protected agent that was
 * never a member already survives an uninstall untouched).
 *
 * **Why not refuse the whole uninstall.** That was the first implementation and
 * it was wrong: the crew team is created company-wide (`crew-bootstrap.ts`
 * passes no `targetDepartmentId`), and `loadTeamForRosterEdit` refuses BOTH
 * `addMember` and `removeMember` when `parentProjectId` is null. So a refusal
 * would leave the founder unable to detach the protected agent, unable to
 * uninstall the team, and with deleting the whole company as the only exit.
 * A department-parented team has `removeMember` as a way out; the company-wide
 * crew team has none. Reporting retention is not the same as silently omitting
 * requested members — {@link UninstallTeamResult.retainedAgents} says exactly
 * what was kept and why.
 */
export async function uninstallTeam(opts: UninstallTeamOpts): Promise<UninstallTeamResult> {
  const { db, companyId, teamId } = opts;

  // ── Pre-flight: read current state outside the transaction ────────────────

  const [teamRow] = await db
    .select({ id: teams.id, templateOrigin: teams.templateOrigin })
    .from(teams)
    .where(and(eq(teams.id, teamId), eq(teams.companyId, companyId)))
    .limit(1);

  if (!teamRow) {
    throw new Error(`Team not found: ${teamId}`);
  }

  // Joined to `agents` because the protected-agent check needs each member's
  // identity signals (name + templateOrigin), not just its id. The companyId
  // predicate matches the delete below, so the two can never disagree about
  // which rows are in scope.
  const memberRows = await db
    .select({
      agentId: teamMembers.agentId,
      name: agents.name,
      templateOrigin: agents.templateOrigin,
    })
    .from(teamMembers)
    .innerJoin(agents, eq(agents.id, teamMembers.agentId))
    .where(and(eq(teamMembers.teamId, teamId), eq(agents.companyId, companyId)));

  // ── D23: partition into destroy vs. detach, BEFORE any write ──────────────

  const retainedAgents: RetainedProtectedAgent[] = protectedAgentsIn(memberRows).map(
    ({ agent, role }) => ({
      id: agent.agentId,
      name: agent.name,
      role: role.slug,
      why: role.why,
    }),
  );
  const retainedIds = new Set(retainedAgents.map((a) => a.id));
  const agentIds = memberRows.map((m) => m.agentId).filter((id) => !retainedIds.has(id));

  if (retainedAgents.length > 0) {
    logger.info(
      { companyId, teamId, retainedAgents },
      "marketplace: retaining protected AoA agents through team uninstall",
    );
  }

  // ── Atomic delete ─────────────────────────────────────────────────────────

  const deletedAgentIds: string[] = [];

  await db.transaction(async (tx) => {
    if (agentIds.length > 0) {
      // 1. Delete trigger rows for the team agents being destroyed.
      //    `agentIds` excludes retained agents on purpose: dropping a protected
      //    agent's triggers destroys it functionally even though the row lives
      //    (`sweep-steward.ts` selects on kind='sweep' + enabled, and
      //    `seedCrewAgent` only seeds triggers for a NEWLY inserted row, so a
      //    wiped trigger is never restored).
      await tx
        .delete(aoaAgentTriggers)
        .where(inArray(aoaAgentTriggers.agentId, agentIds));

      // 2. Delete agents (FK cascade removes team_members rows too)
      const deleted = await tx
        .delete(agents)
        .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)))
        .returning({ id: agents.id });

      deletedAgentIds.push(...deleted.map((r) => r.id));
    }

    // 3. Delete team row. The FK cascade removes the retained agents'
    //    `team_members` rows — that is the detach: the agent row survives with
    //    its triggers, config and history, it simply stops being on this team.
    await tx
      .delete(teams)
      .where(and(eq(teams.id, teamId), eq(teams.companyId, companyId)));

    // 4. Audit log
    await tx.insert(marketplaceInstallOperations).values({
      companyId,
      catalogItemId: teamRow.templateOrigin ?? teamId,
      itemType: "team",
      status: "success",
      resultEntityId: teamId,
      completedAt: new Date(),
    });
  });

  logger.info(
    { companyId, teamId, deletedAgentIds, retainedAgentIds: retainedAgents.map((a) => a.id) },
    "marketplace: team uninstalled",
  );
  return { deletedAgentIds, retainedAgents };
}
