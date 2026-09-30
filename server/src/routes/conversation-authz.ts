// server/src/routes/conversation-authz.ts
import type { Request } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { internalAgentConversations } from "@armyofagents/db";
import { permissionService } from "../services/permissions.js";
import { getActorInfo } from "./authz.js";
import { notFound } from "../errors.js";
import type { UserRole } from "@armyofagents/shared";

/**
 * Board-gated effective role for a Commander actor. Founder-equivalence is
 * conferred ONLY to interactive board sessions (local_implicit / instance
 * admin / founder role); MCP & agent BEARER TOKENS are always "team_member" —
 * a founder-created MCP key replays the founder's userId, which must NOT grant
 * founder reach to a token. Single-sources the rule used by loadOwnedConversation
 * and the internal-agent chat/confirm/list routes.
 *
 * NB: isInstanceAdmin is only ever set on type:"board" actors (auth.ts —
 * loopback/session/board_key); MCP/agent tokens never carry it, so the
 * board gate cannot silently demote an instance admin. If the actor shape
 * changes, re-examine this gate.
 */
export async function resolveActorRole(
  db: Db,
  req: Request,
  companyId: string,
): Promise<UserRole> {
  const isBoard = req.actor.type === "board";
  if (isBoard && (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin === true)) {
    return "founder";
  }
  if (!isBoard) {
    // MCP / agent tokens are NEVER founder-equivalent — a founder-created MCP
    // key replays the founder's userId (auth.ts → getActorInfo), which would
    // otherwise resolve to "founder" via getEffectiveRole and grant founder
    // reach. Owner-scope them instead, limiting bearer-token blast radius.
    // Interactive founder access is via board sessions only.
    return "team_member";
  }
  // Board session — look up the actor's actual role.
  const actor = getActorInfo(req);
  const role = await permissionService(db).getEffectiveRole(companyId, actor.actorId);
  return (role as UserRole) ?? "team_member";
}

/**
 * Resolve a Commander conversation the actor is allowed to read, enforcing
 * ownership in the WHERE clause (not a separate 403) so non-owners can't
 * distinguish "exists" from "forbidden". Founder-equivalents bypass the userId
 * scope ONLY via an interactive board session (local_implicit / instance admin /
 * founder role on a type:"board" actor); MCP and agent tokens are always
 * owner-scoped (see only their own userId's conversations), even when the token
 * was created by a founder. Throws 404 on mismatch.
 *
 * Single-sourced authz: shared by internal-agent.ts (archive/pin/rename/delete/
 * messages) and memory-retrievals.ts (the conversation retrieval-audit endpoint).
 * Role derivation is via resolveActorRole — do not inline the board-gate here.
 */
export async function loadOwnedConversation(
  db: Db,
  req: Request,
  companyId: string,
  convId: string,
) {
  const actor = getActorInfo(req);
  const isFounderRole = (await resolveActorRole(db, req, companyId)) === "founder";

  const convConditions = [
    eq(internalAgentConversations.id, convId),
    eq(internalAgentConversations.companyId, companyId),
  ];
  if (!isFounderRole) {
    convConditions.push(eq(internalAgentConversations.userId, actor.actorId));
  }

  const [existing] = await db
    .select()
    .from(internalAgentConversations)
    .where(and(...convConditions));

  if (!existing) throw notFound("Conversation not found");
  return existing;
}
