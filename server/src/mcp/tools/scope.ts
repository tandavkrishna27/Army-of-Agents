import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { agentProjects, issues, projectGoals, userRoles } from "@armyofagents/db";
import { forbidden } from "../../errors.js";
import type { McpUserScope } from "./types.js";

/**
 * Resolve the MCP visibility scope for a caller.
 *
 * B-H1: founder escalation is board-gated. Only a board actor may resolve to
 * founder scope. Agent IDs are never looked up as users, and MCP/Commander
 * callers remain empty-scoped unless a specific tool performs a narrower
 * owner-authority check.
 *
 *   - "board"  → query user_roles; zero rows OR a founder row → founder;
 *                else scoped to the caller's role projects.
 *   - "agent"  → NEVER founder. Scoped to the agent's `agent_projects`.
 *   - other    → ("mcp" / "commander" / unknown) least privilege: scoped, no
 *                projects. These callers carry their own tool-level gating.
 */
export async function resolveUserScope(
  db: Db,
  companyId: string,
  actor: { source: string; userId: string },
): Promise<McpUserScope> {
  const { source, userId } = actor;

  if (source === "board") {
    const roles = await db
      .select()
      .from(userRoles)
      .where(and(eq(userRoles.companyId, companyId), eq(userRoles.userId, userId)));

    if (roles.length === 0 || roles.some((role) => role.role === "founder")) {
      return { kind: "founder", userId };
    }

    const projectIds = new Set(
      roles.map((role) => role.projectId).filter((id): id is string => Boolean(id)),
    );
    return { kind: "scoped", userId, projectIds };
  }

  if (source === "agent") {
    const rows = await db
      .select({ projectId: agentProjects.projectId })
      .from(agentProjects)
      .where(
        and(eq(agentProjects.companyId, companyId), eq(agentProjects.agentId, userId)),
      );
    const projectIds = new Set(
      rows.map((row) => row.projectId).filter((id): id is string => Boolean(id)),
    );
    return { kind: "scoped", userId, projectIds };
  }

  // mcp / commander / unknown — least privilege.
  return { kind: "scoped", userId, projectIds: new Set<string>() };
}

/**
 * Resolve only the artifact-version scope of an authenticated MCP key owner.
 * Unlike the generic MCP scope, this helper may honor a real founder role for
 * this one explicitly allowlisted operation. Missing roles fail closed.
 */
export async function resolveMcpOwnerArtifactScope(
  db: Db,
  companyId: string,
  userId: string,
): Promise<McpUserScope> {
  const roles = await db
    .select()
    .from(userRoles)
    .where(and(eq(userRoles.companyId, companyId), eq(userRoles.userId, userId)));

  if (roles.some((role) => role.role === "founder")) {
    return { kind: "founder", userId };
  }

  const projectIds = new Set(
    roles.map((role) => role.projectId).filter((id): id is string => Boolean(id)),
  );
  return { kind: "scoped", userId, projectIds };
}

export async function resolveUserRole(
  db: Db,
  companyId: string,
  userId: string,
): Promise<string> {
  const roles = await db
    .select()
    .from(userRoles)
    .where(and(eq(userRoles.companyId, companyId), eq(userRoles.userId, userId)));
  if (roles.length === 0) return "team_member";
  if (roles.some((role) => role.role === "founder")) return "founder";
  if (roles.some((role) => role.role === "team_lead")) return "team_lead";
  return "team_member";
}

export async function resolveScopedAgentIdsDefault(
  db: Db,
  companyId: string,
  scope: McpUserScope,
): Promise<Set<string> | null> {
  if (scope.kind === "founder") return null;
  if (scope.projectIds.size === 0) return new Set();
  const rows = await db
    .select({ agentId: agentProjects.agentId })
    .from(agentProjects)
    .where(
      and(
        eq(agentProjects.companyId, companyId),
        inArray(agentProjects.projectId, [...scope.projectIds]),
      ),
    );
  return new Set(rows.map((row) => row.agentId));
}

export function canAccessProjectScopedEntity(
  scope: McpUserScope,
  projectId: string | null | undefined,
) {
  if (scope.kind === "founder") return true;
  return Boolean(projectId && scope.projectIds.has(projectId));
}

export function assertScopedProjectAccess(
  scope: McpUserScope,
  projectId: string | null | undefined,
  label: string,
) {
  if (scope.kind === "founder") return;
  if (!projectId) return;
  if (!scope.projectIds.has(projectId)) {
    throw forbidden(`${label} is outside your scope`);
  }
}

export async function goalProjectMap(db: Db, goalIds: string[]) {
  if (goalIds.length === 0) return new Map<string, string[]>();
  const rows = await db
    .select({
      goalId: projectGoals.goalId,
      projectId: projectGoals.projectId,
    })
    .from(projectGoals)
    .where(inArray(projectGoals.goalId, goalIds));
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const current = map.get(row.goalId) ?? [];
    current.push(row.projectId);
    map.set(row.goalId, current);
  }
  return map;
}

export async function artifactProjectMap(db: Db, artifactIds: string[]) {
  if (artifactIds.length === 0) return new Map<string, string | null>();
  const rows = await db
    .select({
      artifactId: issues.artifactId,
      projectId: issues.projectId,
    })
    .from(issues)
    .where(inArray(issues.artifactId, artifactIds));
  const map = new Map<string, string | null>();
  for (const row of rows) {
    if (row.artifactId) {
      map.set(row.artifactId, row.projectId ?? null);
    }
  }
  return map;
}

export async function filterGoalsForScope(
  db: Db,
  scope: McpUserScope,
  rows: Array<Record<string, any>>,
) {
  if (scope.kind === "founder") return rows;
  const projectMap = await goalProjectMap(
    db,
    rows.map((row) => row.id),
  );
  return rows.filter((row) =>
    (projectMap.get(row.id) ?? []).some((projectId) => scope.projectIds.has(projectId)),
  );
}

export async function filterArtifactsForScope(
  db: Db,
  scope: McpUserScope,
  rows: Array<Record<string, any>>,
) {
  if (scope.kind === "founder") return rows;
  const projectMap = await artifactProjectMap(
    db,
    rows.map((row) => row.id),
  );
  return rows.filter((row) =>
    canAccessProjectScopedEntity(scope, projectMap.get(row.id) ?? null),
  );
}

export async function assertScopedGoalAccess(
  db: Db,
  scope: McpUserScope,
  goalId: string | null | undefined,
) {
  if (!goalId || scope.kind === "founder") return;
  const projects = (await goalProjectMap(db, [goalId])).get(goalId) ?? [];
  if (projects.length === 0 || !projects.some((projectId) => scope.projectIds.has(projectId))) {
    throw forbidden("Goal is outside your scope");
  }
}
