import type { PostAuthJourneyResult, PendingInvitation } from "@armyofagents/shared";

export type JourneyInput = {
  /**
   * Organization ids the user actively belongs to (org-first — Phase 2 Task
   * 9). Optional: callers that only reason in terms of company memberships
   * (e.g. self-hosted single-tenant call sites/tests that predate the
   * Organization tenant layer) may omit it; an absent/empty list behaves
   * exactly as before this field was introduced.
   */
  organizationMemberships?: string[];
  /** companyIds the user is already an active member of. */
  memberships: string[];
  /**
   * Open invitations the user is eligible to accept — ALREADY filtered by the
   * caller to: not-revoked/expired, verified-email-matched, and NOT rejected
   * (rejected join_requests must never route to `invited` — RB7/RB9).
   */
  pendingInvitations: PendingInvitation[];
  /** The company a deep-linked /invite/:token resolved to, if any. */
  deepLinkCompanyId?: string | null;
};

/**
 * Pure post-auth journey resolver (RB7/RB9, org-first per Phase 2 Task 9).
 * Precedence:
 *   organization membership OR company membership → returning (invitations
 *     still surfaced, never auto-routed). An org membership alone — zero
 *     company memberships, e.g. a fresh multi-tenant org owner who hasn't
 *     created a Company yet — is enough to be "returning", not "founder".
 *   else open invitation → invited (deep-linked company preferred, else first)
 *   else founder
 * The invite token is never returned (revC RC3); it lives in a server-side
 * handoff consumed at accept time.
 */
export function resolvePostAuthJourney(input: JourneyInput): PostAuthJourneyResult {
  const hasOrgMembership = (input.organizationMemberships?.length ?? 0) > 0;
  if (hasOrgMembership || input.memberships.length > 0) {
    return {
      journey: "returning",
      targetCompanyId: input.memberships[0] ?? null,
      pendingInvitations: input.pendingInvitations,
      inviteToken: null,
    };
  }

  if (input.pendingInvitations.length > 0) {
    const target =
      input.deepLinkCompanyId &&
      input.pendingInvitations.some((i) => i.companyId === input.deepLinkCompanyId)
        ? input.deepLinkCompanyId
        : input.pendingInvitations[0].companyId;
    return {
      journey: "invited",
      targetCompanyId: target,
      pendingInvitations: input.pendingInvitations,
      inviteToken: null,
    };
  }

  return { journey: "founder", targetCompanyId: null, pendingInvitations: [], inviteToken: null };
}
