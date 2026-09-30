/**
 * Shared activity formatting helpers.
 *
 * Extracted from ActivityRow.tsx so that cockpit cards (CockpitTeammatesActivityCard)
 * can reuse the same verb map and entity-link logic without duplicating them.
 */

import { deriveProjectUrlKey } from "@armyofagents/shared";

export const ACTION_VERBS: Record<string, string> = {
  "issue.created": "created",
  "issue.updated": "updated",
  "issue.checked_out": "checked out",
  "issue.released": "released",
  "issue.comment_added": "commented on",
  "issue.attachment_added": "attached file to",
  "issue.attachment_removed": "removed attachment from",
  "issue.commented": "commented on",
  "issue.deleted": "deleted",
  "issue.read_marked": "marked as read",
  "issue.approval_linked": "linked approval to",
  "issue.approval_unlinked": "unlinked approval from",
  "issue.checkout_lock_adopted": "adopted checkout lock on",
  "agent.created": "created",
  "agent.updated": "updated",
  "agent.paused": "paused",
  "agent.resumed": "resumed",
  "agent.terminated": "terminated",
  "agent.key_created": "created API key for",
  "agent.budget_updated": "updated budget for",
  "agent.runtime_session_reset": "reset session for",
  "heartbeat.invoked": "invoked heartbeat for",
  "heartbeat.cancelled": "cancelled heartbeat for",
  "approval.created": "requested approval",
  "approval.approved": "approved",
  "approval.rejected": "rejected",
  "project.created": "created",
  "project.updated": "updated",
  "project.deleted": "deleted",
  "goal.created": "created",
  "goal.updated": "updated",
  "goal.deleted": "deleted",
  "cost.reported": "reported cost for",
  "cost.recorded": "recorded cost for",
  "company.created": "created company",
  "company.updated": "updated company",
  "company.archived": "archived",
  "company.budget_updated": "updated budget for",
};

/**
 * Returns a human-readable verb for a known activity action string.
 * Falls back to a normalized version of the action string for unknown actions.
 */
export function activityVerb(action: string): string {
  return ACTION_VERBS[action] ?? action.replace(/[._]/g, " ").replace(/\bissue\b/g, "task");
}

/**
 * Returns a relative URL for a known entity type + id pair, or null for unknown types.
 * Mirrors the entityLink function in ActivityRow.tsx (now the single source of truth).
 *
 * The optional `name` parameter is used for issue slugs and project URL keys.
 */
export function entityLink(
  entityType: string,
  entityId: string,
  name?: string | null,
): string | null {
  switch (entityType) {
    case "issue": return `/issues/${name ?? entityId}`;
    case "agent": return `/agents/${entityId}`;
    case "project": return `/projects/${deriveProjectUrlKey(name, entityId)}`;
    case "goal": return `/goals/${entityId}`;
    case "approval": return `/approvals/${entityId}`;
    default: return null;
  }
}
