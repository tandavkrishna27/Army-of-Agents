import { Router, type Request, type Response } from "express";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { authUsers, invites, joinRequests } from "@armyofagents/db";
import { parseInviteRoleMetadata } from "../services/team.js";
import { claimInviteAndFileJoinRequest } from "../services/invite-claim.js";
import {
  approveHumanJoinRequestTx,
  autoAdmitApprovalIdentity,
  buildHumanJoinApprovalServices,
  inviteConfersPrivilegedAuthority,
} from "../services/join-approval.js";

/** Mirrors routes/access.ts requestIp (not exported there). */
function requestIp(req: Request) {
  const forwarded = req.header("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.ip || "unknown";
}

/**
 * Invited auto-admit (spec §8): the invitation carries the approval. Fired by
 * the InvitedJoinTerminal after the profile step. Self-scoped: only finalizes
 * the CALLER's own pending human join_request. Admits iff the caller's VERIFIED
 * email matches the invited email (case-insensitive), computed fresh here —
 * else the request stays pending for founder approval. Invite validity was
 * established AT ACCEPT (payload-aware TTL — email-bound human invites live
 * 7 days, others 10 minutes; consumed on accept) — expiresAt is NOT
 * re-checked; only a defensive revokedAt check remains.
 *
 * Tokenless entry: when NO join_request exists (the user signed in without
 * ever clicking the invite link), an OPEN invite matching the caller's
 * VERIFIED email is claimed atomically (accept + file) and the finalize
 * continues with the fresh request. Unlike the filed path, expiry gates the
 * tokenless claim — nothing was accepted yet. This claim requires
 * `body.acceptOpenInvite === true` (the server-side consent assertion mirroring
 * the terminal's "Join {company}" click) — without it, the endpoint behaves as
 * if no open invite existed at all.
 *
 * Rejected-then-reinvited: when the NEWEST request is rejected but an OPEN
 * matching invite exists, that invite is necessarily a fresh re-invite (the
 * rejected request's invite was consumed at accept) — claim it and continue,
 * instead of reporting the stale rejection forever. Same `acceptOpenInvite`
 * gate applies.
 */
export function onboardingJoinRoutes(db: Db): Router {
  const router = Router();

  router.post("/onboarding/join/finalize", async (req: Request, res: Response) => {
    const actor = req.actor;
    if (actor.type !== "board" || !actor.userId) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const companyId = typeof body.companyId === "string" ? body.companyId : "";
    if (!companyId) {
      res.status(400).json({ error: "companyId is required" });
      return;
    }
    // Server-side consent assertion for the open-invite CLAIM branch below —
    // mirrors the terminal's "Join {company}" click. Token-accepted requests
    // carried consent at link-click (the filed path, unaffected by this flag);
    // the tokenless/re-invite claim has no such moment, so the client gate
    // alone isn't a security boundary — a future non-UI caller of finalize
    // must not be able to silently inherit tokenless auto-admit.
    const acceptOpenInvite = body.acceptOpenInvite === true;

    let request: { id: string; inviteId: string; status: string } | null = await db
      .select()
      .from(joinRequests)
      .where(
        and(
          eq(joinRequests.companyId, companyId),
          eq(joinRequests.requestType, "human"),
          eq(joinRequests.requestingUserId, actor.userId),
        ),
      )
      .orderBy(desc(joinRequests.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!request || request.status === "rejected") {
      if (!acceptOpenInvite) {
        // No server-side consent assertion for the claim — behave exactly as
        // if no open invite existed. Do NOT leak whether a matching invite
        // exists (that would let an unconsented caller probe invite state).
        if (request) {
          res.json({ admitted: false, status: "rejected" });
          return;
        }
        res.status(404).json({ error: "no join request or open invitation for this company" });
        return;
      }
      // Tokenless invited entry (no join_request — the token-accept path never
      // ran) OR rejected-then-reinvited (the newest request is a dead rejection;
      // any OPEN matching invite is necessarily a fresh re-invite, since the
      // rejected request's invite was consumed at accept). Look for an OPEN
      // invite matching the caller's VERIFIED email; if one exists, claim it
      // atomically (accept + file) and continue into the normal finalize with
      // the fresh request. Expiry gates THIS lookup at claim time — nothing was
      // accepted yet.
      const caller = await db
        .select({ email: authUsers.email, emailVerified: authUsers.emailVerified })
        .from(authUsers)
        .where(eq(authUsers.id, actor.userId))
        .then((rows) => rows[0] ?? null);
      const callerEmail = caller?.email ?? null;
      const openInvite =
        caller?.emailVerified && callerEmail
          ? await db
              .select()
              .from(invites)
              .where(
                and(
                  eq(invites.companyId, companyId),
                  isNull(invites.acceptedAt),
                  isNull(invites.revokedAt),
                  gt(invites.expiresAt, new Date()),
                  eq(invites.inviteType, "company_join"),
                  inArray(invites.allowedJoinTypes, ["human", "both"]),
                  // btrim: padded invite emails must match like the admit gate,
                  // which trims both sides before comparing.
                  sql`lower(btrim(${invites.defaultsPayload} -> 'teamInvite' ->> 'email')) = lower(btrim(${callerEmail}))`,
                ),
              )
              .orderBy(desc(invites.createdAt)) // newest invite wins (a re-invite may carry a new role)
              .limit(1)
              .then((rows) => rows[0] ?? null)
          : null;
      if (!openInvite) {
        if (request) {
          // Rejected and no fresh invite — the rejection stands.
          res.json({ admitted: false, status: "rejected" });
          return;
        }
        res.status(404).json({ error: "no join request or open invitation for this company" });
        return;
      }
      const claimed = await claimInviteAndFileJoinRequest(db, {
        inviteId: openInvite.id,
        companyId,
        userId: actor.userId,
        email: callerEmail,
        requestIp: requestIp(req),
      });
      request = { id: claimed.id, inviteId: openInvite.id, status: claimed.status };
    }
    if (request.status === "approved") {
      res.json({ admitted: true, status: "approved" });
      return;
    }
    if (request.status === "rejected") {
      res.json({ admitted: false, status: "rejected" });
      return;
    }

    const invite = await db
      .select()
      .from(invites)
      .where(eq(invites.id, request.inviteId))
      .then((rows) => rows[0] ?? null);
    // Validity was established AT ACCEPT (accept enforces the payload-aware
    // invite TTL — 7 days for email-bound human invites, 10 minutes otherwise —
    // and consumes the invite). Do NOT re-check expiresAt here — the clock keeps
    // ticking through sign-in + the profile form and would degrade nearly every
    // real auto-admit to pending (spec §9). Keep only a defensive revokedAt check.
    if (!invite || invite.revokedAt) {
      res.json({ admitted: false, status: "invite_invalid" });
      return;
    }

    const user = await db
      .select({ email: authUsers.email, emailVerified: authUsers.emailVerified })
      .from(authUsers)
      .where(eq(authUsers.id, actor.userId))
      .then((rows) => rows[0] ?? null);
    const invitedEmail =
      parseInviteRoleMetadata(invite.defaultsPayload as Record<string, unknown> | null)?.email ?? null;
    const matched = Boolean(
      user?.emailVerified &&
        typeof user.email === "string" &&
        invitedEmail &&
        user.email.trim().toLowerCase() === invitedEmail.trim().toLowerCase(),
    );
    if (!matched) {
      res.json({ admitted: false, status: "pending" });
      return;
    }

    // Defense in depth (P1, Codex round-5): the verified-email match above is
    // the ONLY auto-admit gate, and the invite's role + grants are applied
    // verbatim by approveHumanJoinRequestTx. NEVER let an unattended match
    // confer founder-tier authority — even if a malicious or over-broad invite
    // row already exists (minted before the creation-time clamp, or via a future
    // bypass). Privileged invites fall back to manual founder approval: leave
    // the request pending. Ordinary team_member/team_lead invites and
    // non-privileged grants keep the (live-validated) fast-path auto-admit.
    if (
      inviteConfersPrivilegedAuthority(
        invite.defaultsPayload as Record<string, unknown> | null,
      )
    ) {
      res.json({ admitted: false, status: "pending" });
      return;
    }

    const approved = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      return approveHumanJoinRequestTx(txDb, buildHumanJoinApprovalServices(txDb), {
        companyId,
        requestId: request.id,
        requestingUserId: actor.userId as string,
        invite: {
          id: invite.id,
          defaultsPayload: invite.defaultsPayload as Record<string, unknown> | null,
        },
        // The preset factory keeps the three-identity contract unmisusable
        // (never impersonates the founder or the invitee).
        ...autoAdmitApprovalIdentity(),
      });
    });
    res.json(approved ? { admitted: true, status: "approved" } : { admitted: false, status: "pending" });
  });

  return router;
}
