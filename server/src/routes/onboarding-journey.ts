import { Router, type Request, type Response } from "express";
import type { Db } from "@armyofagents/db";
import {
  authUsers,
  companyMemberships,
  joinRequests,
  invites,
  companies,
  onboardingProgress,
} from "@armyofagents/db";
import { and, desc, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { PostAuthJourneyResult, PendingInvitation, OrganizationRole } from "@armyofagents/shared";
import { resolvePostAuthJourney } from "../services/post-auth-journey.js";
import { organizationAccessService, orgRoleCan } from "../services/organization-access.js";
import { accessibleCompanyIdsForActor } from "./authz.js";

const TEAM_INVITE_KEY = "teamInvite";

function roleFromInviteDefaults(defaults: Record<string, unknown> | null | undefined): string {
  const team = (defaults?.[TEAM_INVITE_KEY] ?? {}) as Record<string, unknown>;
  const role = team.role;
  return typeof role === "string" && role.length > 0 ? role : "team_member";
}

/**
 * Resolve the post-auth journey for a user (A5 + RB7/RB9, org-first per
 * Phase 2 Task 9).
 *
 * - `returning` if the user has any active Organization membership OR any
 *   active company membership, or if an instance admin can see an existing
 *   company through the global admin bypass. An org membership alone (zero
 *   company memberships yet — e.g. a fresh multi-tenant org owner) is enough.
 * - `invited` if the user has an open, non-rejected human join_request they made
 *   (or, only when their email is verified, one snapshotting their email), OR —
 *   tokenless entry — an OPEN company-join invite matching their verified email
 *   (the user signed in without ever clicking the invite link, so no
 *   join_request exists yet; finalize claims it).
 * - `founder` otherwise.
 *
 * Verified-email gating reads `authUsers.emailVerified` directly (the session
 * result does not expose it — RC4). Rejected/approved requests are excluded by
 * the `status = 'pending_approval'` filter (RB9). The full invite-token deep-link
 * handoff (RC3) is wired in Stage D; `deepLinkCompanyId` is accepted here.
 */
export async function getJourneyForUser(
  db: Db,
  args: {
    userId: string;
    /**
     * Company ids already authorized for this actor. In cloud_auth this is the
     * active company-membership ∩ active owning-Organization set built by
     * actorMiddleware. `undefined` is the canonical unscoped sentinel for a
     * self-hosted local/instance-admin actor. Keeping this required prevents
     * journey routing from drifting away from the authorization boundary again.
     */
    authorizedCompanyIds: readonly string[] | undefined;
    deepLinkCompanyId?: string | null;
    isInstanceAdmin?: boolean;
  },
): Promise<PostAuthJourneyResult> {
  const [user] = await db
    .select({ email: authUsers.email, emailVerified: authUsers.emailVerified })
    .from(authUsers)
    .where(eq(authUsers.id, args.userId))
    .limit(1);

  const email = user?.email ?? null;
  const emailVerified = Boolean(user?.emailVerified);

  const orgAccess = organizationAccessService(db);
  // Sequential (not Promise.all) — deliberately: this route isn't a hot path,
  // and a plain query builder thenable racing an async-function-wrapped
  // thenable inside Promise.all resolves in a JS-engine-dependent order (the
  // async wrapper schedules its PromiseResolveThenableJob a tick earlier),
  // which is exactly the kind of implicit ordering the seqDb test mock
  // (server/src/__tests__/onboarding-journey-route.test.ts) must NOT depend
  // on. Sequential awaits keep the call order simple and match every other
  // query in this function.
  const memberships = await db
    .select({ companyId: companyMemberships.companyId })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, args.userId),
        eq(companyMemberships.status, "active"),
      ),
    );
  const orgMembershipRows = await orgAccess.listOrgMemberships(args.userId);
  const organizationMemberships = orgMembershipRows.map((r) => r.organizationId);

  // Match the user's own pending human requests, plus (verified email only) any
  // pending human request snapshotting their verified email.
  const emailMatch =
    emailVerified && email
      ? sql`lower(${joinRequests.requestEmailSnapshot}) = lower(${email})`
      : sql`false`;

  const pendingRows = await db
    .select({
      inviteId: joinRequests.inviteId,
      companyId: joinRequests.companyId,
      companyName: companies.name,
      createdAt: joinRequests.createdAt,
      defaults: invites.defaultsPayload,
    })
    .from(joinRequests)
    .innerJoin(companies, eq(companies.id, joinRequests.companyId))
    .innerJoin(invites, eq(invites.id, joinRequests.inviteId))
    .where(
      and(
        eq(joinRequests.requestType, "human"),
        eq(joinRequests.status, "pending_approval"),
        or(eq(joinRequests.requestingUserId, args.userId), emailMatch),
      ),
    );

  const pendingInvitations: PendingInvitation[] = pendingRows.map((r) => ({
    companyId: r.companyId,
    companyName: r.companyName ?? "",
    inviteId: r.inviteId,
    role: roleFromInviteDefaults(r.defaults),
    createdAt: (r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt as string)).toISOString(),
    filed: true,
  }));

  // Tokenless invited entry: ALSO detect OPEN company-join invites matching the
  // caller's VERIFIED email — pre-accept, so no join_request exists yet. Expiry
  // MUST gate detection here (nothing was accepted yet), unlike filed requests
  // whose validity was established at token-accept.
  const openInviteRows =
    emailVerified && email
      ? await db
          .select({
            companyId: invites.companyId,
            companyName: companies.name,
            inviteId: invites.id,
            createdAt: invites.createdAt,
            defaults: invites.defaultsPayload,
          })
          .from(invites)
          .innerJoin(companies, eq(companies.id, invites.companyId))
          .where(
            and(
              isNull(invites.acceptedAt),
              isNull(invites.revokedAt),
              gt(invites.expiresAt, new Date()),
              eq(invites.inviteType, "company_join"),
              inArray(invites.allowedJoinTypes, ["human", "both"]),
              isNotNull(invites.companyId),
              // btrim: padded invite emails must match like the admit gate,
              // which trims both sides before comparing.
              sql`lower(btrim(${invites.defaultsPayload} -> 'teamInvite' ->> 'email')) = lower(btrim(${email}))`,
            ),
          )
          // Newest first — the merge below keeps the FIRST row per company, so
          // the surfaced invite matches the one finalize claims (it orders by
          // desc(createdAt) too; a re-invite may carry a new role).
          .orderBy(desc(invites.createdAt), invites.companyId)
      : [];

  // Merge open invites that don't already have a filed request (dedupe by
  // company — the filed join_request wins, and among open invites the newest
  // per company wins). For these entries `inviteId` is the INVITE id, not a
  // join_request id (PendingInvitation's field covers both).
  for (const r of openInviteRows) {
    if (!r.companyId) continue;
    if (pendingInvitations.some((p) => p.companyId === r.companyId)) continue;
    pendingInvitations.push({
      companyId: r.companyId,
      companyName: r.companyName ?? "",
      inviteId: r.inviteId,
      role: roleFromInviteDefaults(r.defaults),
      createdAt: (r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt as string)).toISOString(),
      filed: false,
    });
  }

  // Deterministic ordering when multiple invitations match.
  pendingInvitations.sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.companyId.localeCompare(b.companyId),
  );

  const membershipCompanyIds = memberships.map((membership) => membership.companyId);
  let returningCompanyIds = membershipCompanyIds;
  if (args.authorizedCompanyIds !== undefined) {
    const authorizedCompanyIds = new Set(args.authorizedCompanyIds);
    returningCompanyIds = membershipCompanyIds.filter((companyId) =>
      authorizedCompanyIds.has(companyId),
    );
  }
  if (returningCompanyIds.length === 0 && args.isInstanceAdmin) {
    const adminVisibleCompanies = await db
      .select({ companyId: companies.id })
      .from(companies)
      .limit(1);
    returningCompanyIds = adminVisibleCompanies.map((company) => company.companyId);
  }

  const result = resolvePostAuthJourney({
    organizationMemberships,
    memberships: returningCompanyIds,
    pendingInvitations,
    deepLinkCompanyId: args.deepLinkCompanyId ?? null,
  });

  // Resume signal: a returning founder whose OWN first-run tail is unfinished
  // (spine complete but persona/in-flight abandoned) should be routed back into
  // /onboarding to finish it, not stranded on a dashboard that no longer hosts
  // onboarding. onboarding_progress is (userId, companyId)-keyed, so this matches
  // ONLY a company the caller personally onboarded — never a team member's
  // company or the instance-admin visibility bypass (which sets returningCompanyIds
  // to a company the admin has no progress row for).
  if (result.journey === "returning" && returningCompanyIds.length > 0) {
    const [resume] = await db
      .select({ companyId: onboardingProgress.companyId })
      .from(onboardingProgress)
      // Join companies to exclude archived ones — an archived unfinished company
      // must NOT keep redirecting its founder back into onboarding.
      .innerJoin(companies, eq(companies.id, onboardingProgress.companyId))
      .where(
        and(
          eq(onboardingProgress.userId, args.userId),
          isNotNull(onboardingProgress.companyId),
          isNull(onboardingProgress.firstRunCompletedAt),
          inArray(onboardingProgress.companyId, returningCompanyIds),
          ne(companies.status, "archived"),
        ),
      )
      .limit(1);
    result.resumeFirstRunCompanyId = resume?.companyId ?? null;
  }

  // Empty-Lobby strand resume (Fix 3b): a `returning` founder who is an
  // OWNER/ADMIN of an org but holds ZERO company memberships created the org
  // step then never made a company (e.g. a reload minted/kept the org, then they
  // landed on an empty Lobby). Route them back into company creation UNDER that
  // org. Computed purely from rows already fetched above — NO extra query, NO
  // write (the ghost-org fix is client durability; no owner-dedup on
  // POST /organizations). Scoped to create-capable roles so a cross-invited
  // `member` (P5) — who anyway always holds a company membership, making
  // returningCompanyIds non-empty for them — never triggers it, and so we never
  // send a user to a create-company screen they'd 403 on. Mutually exclusive with
  // the resumeFirstRunCompanyId branch above (that requires returningCompanyIds
  // non-empty), so the query sequence is unchanged.
  if (result.journey === "returning" && returningCompanyIds.length === 0) {
    // Deterministic pick: `listOrgMemberships` has no ORDER BY, so when the user
    // owns MORE THAN ONE create-capable zero-company org, choose by a stable key
    // rather than array order — earliest membership `createdAt` first (a fresh
    // owner org's membership createdAt is effectively its org-creation time), then
    // the lexicographically smallest `organizationId` as the final tiebreak (robust
    // when createdAt ties or is absent). `.filter` returns a fresh array, so the
    // `.sort` never mutates `orgMembershipRows`.
    const creatable = orgMembershipRows
      .filter((row) => orgRoleCan(row.role as OrganizationRole, "company:create"))
      .sort((a, b) => {
        const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return at - bt || a.organizationId.localeCompare(b.organizationId);
      })[0];
    result.resumeCompanyCreationOrgId = creatable?.organizationId ?? null;
  }

  return result;
}

/** GET /api/onboarding/journey — board-scoped, self-only. */
export function onboardingJourneyRoutes(db: Db): Router {
  const router = Router();
  router.get("/onboarding/journey", async (req: Request, res: Response) => {
    const actor = req.actor;
    if (actor.type !== "board" || !actor.userId) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    const result = await getJourneyForUser(db, {
      userId: actor.userId,
      authorizedCompanyIds: accessibleCompanyIdsForActor(actor),
      isInstanceAdmin: actor.isInstanceAdmin === true,
    });
    res.json(result);
  });
  return router;
}
