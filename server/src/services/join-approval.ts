import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { joinRequests, companies } from "@armyofagents/db";
import {
  PERMISSION_KEYS,
  ROLE_RANK,
  type JoinRequestApprovalSource,
  type PermissionKey,
} from "@armyofagents/shared";
import { accessService } from "./access.js";
import {
  teamService,
  materializeCompanyProfileFromGlobal,
  parseInviteRoleMetadata,
} from "./team.js";
import { humanCapabilitiesService } from "./human-capabilities.js";
import { hubItemsService } from "./hub-items.js";
import { logActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";
import { organizationAccessService } from "./organization-access.js";

/**
 * Extract permission grants from an invite defaultsPayload (moved verbatim from
 * routes/access.ts — the founder approve route AND the invited finalize path
 * both need it).
 */
export function grantsFromDefaults(
  defaultsPayload: Record<string, unknown> | null | undefined,
  key: "human" | "agent",
): Array<{
  permissionKey: (typeof PERMISSION_KEYS)[number];
  scope: Record<string, unknown> | null;
}> {
  if (!defaultsPayload || typeof defaultsPayload !== "object") return [];
  const scoped = defaultsPayload[key];
  if (!scoped || typeof scoped !== "object") return [];
  const grants = (scoped as Record<string, unknown>).grants;
  if (!Array.isArray(grants)) return [];
  const validPermissionKeys = new Set<string>(PERMISSION_KEYS);
  const result: Array<{
    permissionKey: (typeof PERMISSION_KEYS)[number];
    scope: Record<string, unknown> | null;
  }> = [];
  for (const item of grants) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.permissionKey !== "string") continue;
    if (!validPermissionKeys.has(record.permissionKey)) continue;
    result.push({
      permissionKey: record.permissionKey as (typeof PERMISSION_KEYS)[number],
      scope:
        record.scope && typeof record.scope === "object" && !Array.isArray(record.scope)
          ? (record.scope as Record<string, unknown>)
          : null,
    });
  }
  return result;
}

/**
 * Permission grants that must NEVER be conferred without an explicit FOUNDER
 * decision — each hands the invitee governance authority (permission
 * delegation, join approval, or further invitation), i.e. the keys an attacker
 * would target to bootstrap control of the company.
 */
export const PRIVILEGED_AUTO_ADMIT_GRANT_KEYS = new Set<PermissionKey>([
  "users:manage_permissions",
  "joins:approve",
  "users:invite",
]);

/**
 * True when an invite would confer authority ABOVE an ordinary member/lead — a
 * role above `team_lead` (i.e. founder), or a privileged permission grant in
 * EITHER the `human` OR the `agent` grant vector.
 *
 * Both vectors are applied VERBATIM at approval time — `human.grants` on the
 * human-approve / auto-admit path, `agent.grants` on the agent-hire approve
 * path — so a governance key hidden in the agent vector is exactly as dangerous
 * as one in the human vector. The predicate unions them; the specific vector a
 * given sink actually applies is irrelevant to whether the invite is privileged.
 *
 * This is the SINGLE definition of "privileged" shared by all the P1
 * privilege-escalation seams so they can never diverge:
 *  - invite CREATION clamp (routes/access.ts POST /invites) — a non-founder
 *    cannot MINT such an invite (human OR agent grants);
 *  - the unattended email-match AUTO-ADMIT sink (routes/onboarding-join.ts
 *    finalize) — such an invite is NEVER auto-admitted (falls back to manual
 *    founder approval);
 *  - the manual APPROVE clamp (routes/access.ts approve) — a non-founder
 *    approver cannot APPLY such an invite, on the human OR the agent-hire branch.
 *
 * Ordinary team_member/team_lead + non-privileged-grant invites stay on the
 * fast path.
 */
export function inviteConfersPrivilegedAuthority(
  defaultsPayload: Record<string, unknown> | null,
): boolean {
  const requestedRole = parseInviteRoleMetadata(defaultsPayload)?.role ?? null;
  if (requestedRole && (ROLE_RANK[requestedRole] ?? 0) > ROLE_RANK.team_lead) {
    return true;
  }
  return [
    ...grantsFromDefaults(defaultsPayload, "human"),
    ...grantsFromDefaults(defaultsPayload, "agent"),
  ].some((grant) => PRIVILEGED_AUTO_ADMIT_GRANT_KEYS.has(grant.permissionKey));
}

/** Tx-scoped service instances the approval needs (injected for testability). */
export type HumanJoinApprovalServices = {
  access: Pick<ReturnType<typeof accessService>, "ensureMembership" | "setPrincipalGrants">;
  team: Pick<ReturnType<typeof teamService>, "applyInviteRole">;
  capabilities: Pick<ReturnType<typeof humanCapabilitiesService>, "ensureStandardDocuments">;
  /** Task 11 (Phase 2 security suite) — org-first tenancy: an invited human
   *  must land in the SAME Organization as the company they were invited
   *  into, never a different (or no) tenant. */
  orgAccess: Pick<ReturnType<typeof organizationAccessService>, "ensureOrgMembership">;
  /** One-line `companies.organizationId` lookup, scoped to the invited
   *  company only — the anti-tenant-hop guarantee for this seam. */
  resolveCompanyOrg: (companyId: string) => Promise<string | null>;
};

export function buildHumanJoinApprovalServices(txDb: Db): HumanJoinApprovalServices {
  return {
    access: accessService(txDb),
    team: teamService(txDb),
    capabilities: humanCapabilitiesService(txDb),
    orgAccess: organizationAccessService(txDb),
    resolveCompanyOrg: (companyId: string) =>
      txDb
        .select({ organizationId: companies.organizationId })
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0]?.organizationId ?? null),
  };
}

/** Founder/manual approval identity — preserves the route's original attribution semantics. */
export function founderApprovalIdentity(opts: { actorUserId: string | null; localImplicit: boolean }) {
  return {
    approvedByUserId: opts.actorUserId ?? (opts.localImplicit ? "local-board" : null),
    attributionUserId: opts.actorUserId ?? null,
    activityActor: { actorType: "user" as const, actorId: opts.actorUserId ?? "board" },
    approvalSource: "founder" as const,
  };
}

/** Auto-admit identity — the invitation carried the approval; never impersonates anyone. */
export function autoAdmitApprovalIdentity() {
  return {
    approvedByUserId: null,
    attributionUserId: null,
    activityActor: { actorType: "system" as const, actorId: "invite_email_match" },
    approvalSource: "invite_email_match" as const,
  };
}

export type ApproveHumanJoinRequestArgs = {
  companyId: string;
  requestId: string;
  requestingUserId: string;
  invite: { id: string; defaultsPayload: Record<string, unknown> | null };
  /** Written to join_requests.approved_by_user_id. null for auto-admit — the
   *  audit trail must never impersonate the founder. Founder route passes
   *  `req.actor.userId ?? (isLocalImplicit(req) ? "local-board" : null)`. */
  approvedByUserId: string | null;
  /** Attribution for grants/role/profile writes. Preserves the founder route's
   *  ORIGINAL semantics (`req.actor.userId ?? null` — no local-board fallback).
   *  null for auto-admit. */
  attributionUserId: string | null;
  /** Activity-log actor. Founder: { actorType: "user", actorId: req.actor.userId ?? "board" }.
   *  Auto-admit: { actorType: "system", actorId: "invite_email_match" } — never
   *  attribute the approval to the invitee. */
  activityActor: { actorType: "user" | "system"; actorId: string };
  approvalSource: JoinRequestApprovalSource;
};

/**
 * The single choke point for admitting an invited human — used by BOTH the
 * founder approve route and the invited auto-admit finalize. Must run inside a
 * transaction (pass the tx-scoped Db). Returns the approved row, or null when
 * the request was no longer pending (raced).
 */
export async function approveHumanJoinRequestTx(
  txDb: Db,
  services: HumanJoinApprovalServices,
  args: ApproveHumanJoinRequestArgs,
) {
  const approvedAt = new Date();
  const row = await txDb
    .update(joinRequests)
    .set({
      status: "approved",
      approvedByUserId: args.approvedByUserId,
      approvalSource: args.approvalSource,
      approvedAt,
      updatedAt: approvedAt,
    })
    .where(
      and(
        eq(joinRequests.companyId, args.companyId),
        eq(joinRequests.id, args.requestId),
        eq(joinRequests.status, "pending_approval"),
      ),
    )
    .returning()
    .then((rows) => rows[0] ?? null);
  if (!row) return null;

  await services.access.ensureMembership(args.companyId, "user", args.requestingUserId, "member", "active");

  // Task 11 (Phase 2 security suite) — invited-joins-correct-org: derive the
  // Organization from the INVITED COMPANY itself (never a caller-supplied or
  // ambient value), so the invitee always lands in the same tenant as the
  // company, and only that tenant. A company with no organizationId (should
  // not happen post-P1-backfill) is a no-op, not a fallback to any default.
  const organizationId = await services.resolveCompanyOrg(args.companyId);
  if (organizationId) {
    await services.orgAccess.ensureOrgMembership(organizationId, args.requestingUserId, "member");
  }

  const grants = grantsFromDefaults(args.invite.defaultsPayload, "human");
  await services.access.setPrincipalGrants(
    args.companyId,
    "user",
    args.requestingUserId,
    grants,
    args.attributionUserId,
  );
  await services.team.applyInviteRole(
    args.companyId,
    args.requestingUserId,
    args.invite.defaultsPayload,
    args.attributionUserId,
  );

  // Materialize the company Human Operating Profile from the GLOBAL profile +
  // seed the 6 standard capability-doc stubs. Best-effort: the nested
  // transaction (SAVEPOINT) confines even SQL-level seeding failures so they
  // can never fail or mask the approval; JS-level throws are caught the same
  // way. The injected services stay bound to the OUTER txDb — same session, so
  // the savepoint still scopes their statements; the nested callback exists
  // purely to create the savepoint.
  try {
    await txDb.transaction(async () => {
      // Shared choke point (also used by addMember + founder company-create):
      // copy the invitee's global profile into their company profile. Passing
      // txDb keeps the write inside this savepoint.
      await materializeCompanyProfileFromGlobal(
        txDb,
        args.companyId,
        args.requestingUserId,
        args.attributionUserId,
      );
      await services.capabilities.ensureStandardDocuments(
        args.companyId,
        args.requestingUserId,
        args.attributionUserId,
      );
    });
  } catch (err) {
    logger.warn(
      { err, companyId: args.companyId, userId: args.requestingUserId },
      "join approval: human profile seeding failed (non-fatal)",
    );
  }

  await hubItemsService(txDb).reconcile(args.companyId, {
    sourceType: "join_request",
    sourceId: args.requestId,
  });
  await logActivity(txDb, {
    companyId: args.companyId,
    actorType: args.activityActor.actorType,
    actorId: args.activityActor.actorId,
    action: "join.approved",
    entityType: "join_request",
    entityId: args.requestId,
    details: {
      requestType: "human",
      approvalSource: args.approvalSource,
      inviteId: args.invite.id,
    },
  });
  return row;
}
