/**
 * cockpit-scope — Phase 3b multi-human scoping helper.
 *
 * Resolves the authenticated board actor to a cockpit scope, then exposes
 * per-card predicates the cockpitService uses when building its queries.
 *
 * Owner-bypass: local_implicit / isInstanceAdmin → treated as founder
 * (mirrors internal-agent.ts:101-134 — same pattern for consistency).
 *
 * NOTE: Discussions scoping is NOT hand-rolled here. The cockpitService
 * passes the canonical threadService.list Actor (using scope.role/userId)
 * which handles participant + dept-role visibility internally (Codex #3).
 */

import type { Db } from "@armyofagents/db";
import { permissionService } from "./permissions.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CockpitScope {
  userId: string;
  role: "founder" | "team_lead" | "team_member";
  isFounder: boolean;
  /** Empty for founders and members. Populated for team leads. */
  leadDepartmentIds: string[];
}

/** Minimal actor shape the route provides. Mirrors what getActorInfo returns for
 *  a board session, plus the owner-bypass fields from req.actor. */
export interface ActorLike {
  actorId: string;
  source?: string;
  isInstanceAdmin?: boolean;
}

/** Filter descriptor returned by reviewFilterFor. The cockpitService translates
 *  this to the concrete issueService.list filter args. */
export type ReviewFilter =
  | Record<string, never>       // founder: no restriction
  | { projectIds: string[] }    // team_lead: dept-scoped
  | { assigneeUserId: string }; // team_member: own-assigned only

// ── Resolver ──────────────────────────────────────────────────────────────────

/**
 * Resolve the requester to a CockpitScope.
 *
 * Owner-bypass: local_implicit / isInstanceAdmin → founder scope.
 * Otherwise, resolves via permissionService against the DB.
 */
export async function resolveCockpitScope(
  db: Db,
  companyId: string,
  actor: ActorLike,
): Promise<CockpitScope> {
  const bypass =
    actor.source === "local_implicit" || actor.isInstanceAdmin === true;

  const perm = permissionService(db);

  const role: CockpitScope["role"] = bypass
    ? "founder"
    : await perm.getEffectiveRole(companyId, actor.actorId);

  const isFounder = role === "founder";

  // Only query departments for team leads — founders are company-wide,
  // members have no lead departments.
  const leadDepartmentIds =
    role === "team_lead"
      ? await perm.getTeamLeadDepartments(companyId, actor.actorId)
      : [];

  return { userId: actor.actorId, role, isFounder, leadDepartmentIds };
}

// ── Per-card predicates ───────────────────────────────────────────────────────

/**
 * Review = agent work awaiting a human verdict.
 *
 * - founder     → no restriction (all in_review tasks)
 * - team_lead   → restricted to their departments (department-scoped)
 * - team_member → restricted to their own assigned in-review tasks
 *
 * The cockpitService loops per dept for team_leads (bounded N = dept count)
 * to work around issueService.list accepting only ONE projectId at a time.
 */
export function reviewFilterFor(s: CockpitScope): ReviewFilter {
  if (s.isFounder) return {};
  if (s.leadDepartmentIds.length > 0) return { projectIds: s.leadDepartmentIds };
  // team_lead with no departments AND team_member both fall back to own work.
  return { assigneeUserId: s.userId };
}
