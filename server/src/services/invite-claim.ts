import type { Db } from "@armyofagents/db";
import { invites, joinRequests } from "@armyofagents/db";
import { and, eq, isNull } from "drizzle-orm";
import { conflict } from "../errors.js";
import { buildJoinRequestHubEmit, emitHubItem } from "./hub-source-producers.js";

/**
 * Atomically claim an OPEN human company-join invite and file a
 * `pending_approval` join_request for the acting user (tokenless invited
 * entry — the user signed in without ever clicking their invite link, so the
 * token-accept path never ran). Self-contained rather than extracted from the
 * routes/access.ts token-accept transaction, so that critical merged path is
 * untouched; both file the same join_request shape.
 *
 * Concurrency: the guarded invite-accept UPDATE verifies it actually consumed
 * the invite (RETURNING non-empty) — a revoke/accept committing between the
 * route's SELECT and this transaction would otherwise file a junk pending
 * request for an invite nobody can approve from; the tx aborts with a conflict
 * instead (the caller's next poll re-resolves). As a second line of defense,
 * `join_requests.invite_id` is UNIQUE, so an insert race hits the constraint —
 * we `onConflictDoNothing` and re-select the winner, then validate it is a
 * HUMAN request owned by THIS user (never return an agent's or another
 * principal's row). The Hub item is emitted ONLY for a fresh insert (a
 * re-selected winner was already announced by whoever won the race).
 */
export async function claimInviteAndFileJoinRequest(
  db: Db,
  args: {
    inviteId: string;
    companyId: string;
    userId: string;
    email: string | null;
    requestIp: string | null;
  },
): Promise<{ id: string; status: string }> {
  return db.transaction(async (tx) => {
    // Mark the invite accepted (guarded) — and VERIFY the guard matched. Zero
    // rows means the invite was revoked or consumed after the route selected
    // it; abort before filing a junk request against it.
    const claimedInvite = await tx
      .update(invites)
      .set({ acceptedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(invites.id, args.inviteId), isNull(invites.acceptedAt), isNull(invites.revokedAt)))
      .returning({ id: invites.id });
    if (claimedInvite.length === 0) {
      throw conflict("invitation is no longer open");
    }

    const inserted = await tx
      .insert(joinRequests)
      .values({
        inviteId: args.inviteId,
        companyId: args.companyId,
        requestType: "human",
        status: "pending_approval",
        requestIp: args.requestIp ?? "", // column is NOT NULL
        requestingUserId: args.userId,
        requestEmailSnapshot: args.email,
        agentName: null,
        adapterType: null,
        capabilities: null,
        agentDefaultsPayload: null,
        claimSecretHash: null,
        claimSecretExpiresAt: null,
      })
      .onConflictDoNothing()
      .returning();

    let row = inserted[0];
    const fresh = Boolean(row);

    if (!row) {
      // Lost the race — re-select the winning row.
      const rows = await tx
        .select()
        .from(joinRequests)
        .where(eq(joinRequests.inviteId, args.inviteId));
      row = rows[0];
    }
    if (!row) throw conflict("invite claim failed");

    // Never return another principal's or an agent's row.
    if (row.requestType !== "human" || row.requestingUserId !== args.userId) {
      throw conflict("invitation already claimed by another principal");
    }

    if (fresh) {
      await emitHubItem(tx as unknown as Db, buildJoinRequestHubEmit(row));
    }
    return { id: row.id, status: row.status };
  });
}
