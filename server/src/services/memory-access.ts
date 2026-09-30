/**
 * RBAC memory-access filter (enterprise memory model, P0).
 * Pure, dependency-free. Wired into ORG + CREW run paths in P1 as a
 * pre-ranking gate so an actor never sees — nor can rank/leak — memory it
 * isn't entitled to. The db-backed actor resolvers + SQL conditions live in
 * a separate memory-access-sql.ts (P1) to keep this module drizzle-free.
 * See docs/aoa/plans/2026-07-30-memory-enterprise-overview.md.
 */
export type MemoryActor =
  | { kind: "founder" }
  | { kind: "team_lead"; userId: string; departmentIds: string[] }
  // `external: true` marks an external MCP-key caller (bearer token, source "mcp") —
  // NOT an internal member. It is excluded from identity + company grounding. Board/
  // user humans (source "board") leave it unset (internal member: sees company).
  | { kind: "team_member"; userId: string; departmentIds: string[]; external?: boolean }
  | { kind: "commander"; userId: string; departmentIds: string[] }
  | { kind: "agent"; agentId: string; departmentIds: string[] };

export interface AccessibleMemoryRow {
  layer: string | null;
  visibility: string;
  departmentId: string | null;
  projectId: string | null;
  goalId?: string | null;
  taskId?: string | null;
  ownerType?: string | null;
  ownerId?: string | null;
  agentId: string | null;
  invalidatedAt?: Date | null;
}

function isPrivate(item: AccessibleMemoryRow): boolean {
  return item.ownerType === "user" || item.ownerType === "agent" || item.agentId != null;
}

/** True iff `actor` is entitled to see `item` in normal retrieval. */
export function canActorSee(item: AccessibleMemoryRow, actor: MemoryActor): boolean {
  // Correction/forgetting: invalidated items never surface (history stays in the row).
  if (item.invalidatedAt != null) return false;

  if (isPrivate(item)) {
    if (actor.kind === "agent") return item.agentId === actor.agentId;
    if (actor.kind === "founder") return false; // others' private hidden in the normal path (break-glass is separate)
    return item.ownerType === "user" && item.ownerId === actor.userId;
  }

  // Non-private. Company-grounding tiers (reconciled with memory-policy.ts + CLAUDE.md;
  // see docs/architecture/decisions.md):
  //   identity → agents (grounding) + founder/team_lead (+commander). NOT team_member
  //              humans, NOT external MCP keys.
  //   company  → every internal member (incl. team_member humans). NOT external MCP keys.
  const isExternalKey = actor.kind === "team_member" && actor.external === true;
  if (item.layer === "identity") {
    return (
      actor.kind === "agent" ||
      actor.kind === "founder" ||
      actor.kind === "team_lead" ||
      actor.kind === "commander"
    );
  }
  if (item.visibility === "company") return !isExternalKey; // all internal members
  if (actor.kind === "founder") return true; // founder sees all non-private
  // Scoped: `departmentIds` carries every projects.id (dept- or project-type) the
  // actor can access, so match a row's departmentId OR projectId against it.
  const ids = actor.departmentIds;
  if (item.departmentId != null && ids.includes(item.departmentId)) return true;
  if (item.projectId != null && ids.includes(item.projectId)) return true;
  if (item.departmentId == null && item.projectId == null) {
    // Goal-/task-only-scoped rows can't be resolved to a project without a DB join.
    // As a post-fetch safety net over the SQL gate (memoryAccessConditions), which
    // already admits only accessible goal/task rows, pass them through rather than
    // strip what the query legitimately returned.
    if (item.goalId != null || item.taskId != null) return true;
    // Fully-unscoped, non-private memory (no dept/project/goal/task) is ambient
    // company-level knowledge — visible to every internal member, NOT external MCP
    // keys (Decision #119). Discussion-extracted memory is created this way.
    return !isExternalKey;
  }
  return false;
}

export function filterMemoryForActor<T extends AccessibleMemoryRow>(
  items: T[],
  actor: MemoryActor,
): T[] {
  return items.filter((it) => canActorSee(it, actor));
}
