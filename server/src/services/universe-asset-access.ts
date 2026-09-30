import { and, eq } from "drizzle-orm";
import {
  discussions,
  internalAgentConversations,
  threadParticipants,
  universeIntakes,
  type Db,
} from "@armyofagents/db";
import { forbidden, notFound } from "../errors.js";

type AssetActor = {
  type: "none" | "board" | "agent" | "mcp" | "commander";
  userId?: string;
  agentId?: string;
};

/**
 * Universe originals inherit the live visibility of the destination they were
 * published into. Company membership alone is deliberately insufficient for a
 * private Commander conversation or private discussion.
 */
export async function assertUniverseAssetAccess(
  db: Db,
  assetId: string,
  actor: AssetActor,
): Promise<void> {
  const intake = await db.select({ destination: universeIntakes.destination })
    .from(universeIntakes)
    .where(and(eq(universeIntakes.assetId, assetId), eq(universeIntakes.state, "published")))
    .then((rows) => rows[0] ?? null);
  if (!intake) return; // Legacy/non-Universe assets retain their existing contract.

  const destination = intake.destination;
  if (destination.kind === "canvas" || destination.kind === "commander_attachment") {
    const userId = actor.userId;
    if (!userId) throw forbidden("Private Universe asset access denied");
    const conversation = await db.select({ id: internalAgentConversations.id })
      .from(internalAgentConversations)
      .where(and(
        eq(internalAgentConversations.id, destination.conversationId),
        eq(internalAgentConversations.userId, userId),
      ))
      .then((rows) => rows[0] ?? null);
    if (!conversation) throw notFound("Asset not found");
    return;
  }

  const discussion = await db.select({
    visibility: discussions.visibility,
    ownerUserId: discussions.ownerUserId,
  }).from(discussions)
    .where(eq(discussions.id, destination.discussionId))
    .then((rows) => rows[0] ?? null);
  if (!discussion) throw notFound("Asset not found");
  if (discussion.visibility !== "private") return;

  const principalType = actor.type === "agent" ? "agent" : "user";
  const principalId = actor.type === "agent" ? actor.agentId : actor.userId;
  if (!principalId) throw forbidden("Private Universe asset access denied");
  if (principalType === "user" && discussion.ownerUserId === principalId) return;
  const participant = await db.select({ id: threadParticipants.id })
    .from(threadParticipants)
    .where(and(
      eq(threadParticipants.threadId, destination.discussionId),
      eq(threadParticipants.principalType, principalType),
      eq(threadParticipants.principalId, principalId),
    ))
    .then((rows) => rows[0] ?? null);
  if (!participant) throw notFound("Asset not found");
}
