/**
 * DB-backed companion to the pure `memory-access.ts` (enterprise memory model, P1).
 *
 * `memory-access.ts` is deliberately pure (its P0 test imports it without mocking
 * @armyofagents/db). This sibling holds the code that must touch the DB or Drizzle:
 * the actor resolvers and the `memoryAccessConditions` WHERE-builder (P1-T2). It
 * type-imports MemoryActor from the pure module so both stay in sync.
 */
import { and, eq, inArray, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import {
  agentProjects,
  issues,
  memoryItems,
  projectGoals,
  userRoles,
  type Db,
} from "@armyofagents/db";
import type { MemoryActor } from "./memory-access.js";

/**
 * Actor for an agent run. departmentIds = the agent's `agent_projects` project ids.
 * These are `projects.id` rows of either type (department OR project), so the RBAC
 * filter matches a memory row's `departmentId` AND `projectId` against this set.
 * An agent with no assignments simply sees only identity + company-visibility memory.
 */
export async function actorForAgentRun(
  db: Db,
  companyId: string,
  agentId: string,
): Promise<MemoryActor> {
  const rows = await db
    .select({ projectId: agentProjects.projectId })
    .from(agentProjects)
    .where(and(eq(agentProjects.companyId, companyId), eq(agentProjects.agentId, agentId)));
  const departmentIds = rows.map((r) => r.projectId).filter((id): id is string => Boolean(id));
  return { kind: "agent", agentId, departmentIds };
}

/**
 * Actor for a human. A founder role short-circuits to `{ kind: "founder" }`. Otherwise
 * the actor is team_lead (if any team_lead row) or team_member, scoped to the
 * `projects.id` named on their role rows. Zero roles → team_member with no departments
 * (least privilege). Mirrors `resolveUserRole` in mcp/tools/scope.ts and is deliberately
 * stricter than `resolveUserScope`'s board-zero-rows→founder rule (an MCP-board concept,
 * not a run-path one).
 */
export async function actorForUser(
  db: Db,
  companyId: string,
  userId: string,
): Promise<MemoryActor> {
  const roles = await db
    .select({ role: userRoles.role, projectId: userRoles.projectId })
    .from(userRoles)
    .where(and(eq(userRoles.companyId, companyId), eq(userRoles.userId, userId)));
  if (roles.some((r) => r.role === "founder")) return { kind: "founder" };
  const departmentIds = roles.map((r) => r.projectId).filter((id): id is string => Boolean(id));
  const kind = roles.some((r) => r.role === "team_lead") ? "team_lead" : "team_member";
  return { kind, userId, departmentIds };
}

/**
 * MCP dispatch helper. Agent/Commander runs resolve from agent_projects. Human
 * callers use the already board-gated MCP scope so an external key can never
 * regain founder visibility merely because its owner has a founder role.
 */
export async function actorForMcp(
  db: Db,
  companyId: string,
  actor: { source: string; userId: string; agentId?: string | null },
  scope: { kind: "founder"; userId: string } | { kind: "scoped"; userId: string; projectIds: Set<string> },
): Promise<MemoryActor> {
  if ((actor.source === "agent" || actor.source === "commander") && actor.agentId) {
    return actorForAgentRun(db, companyId, actor.agentId);
  }
  if (scope.kind === "founder") return { kind: "founder" };
  return {
    kind: "team_member",
    userId: actor.userId,
    departmentIds: [...scope.projectIds],
    // External MCP keys (bearer token, source "mcp") are NOT internal members — the
    // gate excludes them from identity + company grounding. Board/user humans
    // (source "board") are internal members (see company, not identity).
    external: actor.source === "mcp",
  };
}

/**
 * In-SQL RBAC gate. Returns a list of Drizzle conditions the caller spreads into
 * its WHERE (they are AND-ed together) so an actor can never rank — nor leak —
 * memory it isn't entitled to. Admits EXACTLY the rows `canActorSee` in
 * memory-access.ts admits; that pure filter is the reference and stays a
 * post-fetch safety net over these conditions.
 *
 * `db` is needed to build the scope subqueries:
 *   - goal→project resolves through the `project_goals` junction (the `goals`
 *     table has NO projectId column; see `goalProjectMap` in mcp/tools/scope.ts).
 *   - task→project reads `issues.projectId` directly.
 */
export function memoryAccessConditions(db: Db, actor: MemoryActor): SQL[] {
  // Correction/forgetting: invalidated rows never surface (all actors).
  const conds: SQL[] = [isNull(memoryItems.invalidatedAt)];

  // A row is PRIVATE when it is agent-personal (agentId set) OR typed-owned by a
  // user/agent. Non-private is the negation; a null ownerType counts as non-private.
  const nonPrivate = and(
    isNull(memoryItems.agentId),
    or(isNull(memoryItems.ownerType), notInArray(memoryItems.ownerType, ["user", "agent"])),
  )!;

  // Founder sees every non-private, non-invalidated row — never others' private
  // (break-glass is a separate path). Matches canActorSee option (b).
  if (actor.kind === "founder") {
    conds.push(nonPrivate);
    return conds;
  }

  // Scoped actor (team_lead / team_member / commander / agent). `departmentIds`
  // carries every projects.id (dept- OR project-type) the actor can access, so a
  // row matches on its departmentId, projectId, its goal's project(s), or its task's project.
  const ids = actor.departmentIds;
  const scopeMatch: SQL = ids.length
    ? or(
        inArray(memoryItems.departmentId, ids),
        inArray(memoryItems.projectId, ids),
        inArray(
          memoryItems.goalId,
          db
            .select({ goalId: projectGoals.goalId })
            .from(projectGoals)
            .where(inArray(projectGoals.projectId, ids)),
        ),
        inArray(
          memoryItems.taskId,
          db.select({ id: issues.id }).from(issues).where(inArray(issues.projectId, ids)),
        ),
      )!
    : sql`false`;

  // Company-grounding tiers (mirror canActorSee in memory-access.ts):
  //   identity → agents + team_lead (+commander). NOT team_member humans / external keys.
  //   company  → every internal member. NOT external MCP keys.
  const seesIdentity =
    actor.kind === "agent" || actor.kind === "team_lead" || actor.kind === "commander";
  const isExternalKey = actor.kind === "team_member" && actor.external === true;
  const visibleParts: SQL[] = [scopeMatch];
  if (seesIdentity) visibleParts.push(eq(memoryItems.layer, "identity"));
  if (!isExternalKey) {
    visibleParts.push(eq(memoryItems.visibility, "company"));
    // Fully-unscoped, non-private memory (no dept/project/goal/task) is ambient
    // company-level knowledge — visible to every internal member (Decision #119).
    // Mirrors canActorSee in memory-access.ts. Discussion-extracted memory is
    // created this way (departmentId null), so agents must still retrieve it.
    // MUST exclude the identity layer: identity rows are also fully-unscoped, and
    // this is an OR-branch (unlike canActorSee's sequential check), so without the
    // guard a team_member would see identity here, re-opening Decision #118.
    visibleParts.push(
      and(
        isNull(memoryItems.departmentId),
        isNull(memoryItems.projectId),
        isNull(memoryItems.goalId),
        isNull(memoryItems.taskId),
        sql`${memoryItems.layer} IS DISTINCT FROM 'identity'`,
      )!,
    );
  }
  const visibleNonPrivate = and(nonPrivate, or(...visibleParts)!)!;

  if (actor.kind === "agent") {
    // Non-private-visible rows PLUS the agent's own personal memory.
    conds.push(or(visibleNonPrivate, eq(memoryItems.agentId, actor.agentId))!);
  } else {
    // Human/commander: non-private-visible rows PLUS their own user-owned private memory.
    conds.push(
      or(
        visibleNonPrivate,
        and(eq(memoryItems.ownerType, "user"), eq(memoryItems.ownerId, actor.userId))!,
      )!,
    );
  }

  return conds;
}
