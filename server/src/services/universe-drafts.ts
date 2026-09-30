import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  agentRuntimeDecisions,
  approvals,
  assets,
  internalAgentConversations,
  issues,
  universeDrafts,
  workQuestions,
} from "@armyofagents/db";
import {
  universeDraftPatchSchema,
  type UniverseDraftPayload,
  type PendingDraftAttempt,
  type UniverseDraft,
  type UniverseDraftDestination,
} from "@armyofagents/shared";
import { badRequest, conflict, notFound } from "../errors.js";
import type { UniverseScope } from "./universe-layout-document.js";

export type { UniverseScope } from "./universe-layout-document.js";

const emptyDraft = (): UniverseDraft => ({
  revision: 0,
  text: "",
  attachmentAssetIds: [],
});

function legacyPayload(destination: UniverseDraftDestination, text: string, attachmentAssetIds: string[]): UniverseDraftPayload | undefined {
  return destination.kind === "commander" || destination.kind === "task"
    ? { kind: destination.kind, text, attachmentAssetIds }
    : undefined;
}

export function universeDraftsService(db: Db) {
  const scopeWhere = (
    scope: UniverseScope,
    destination: UniverseDraftDestination,
  ) =>
    and(
      eq(universeDrafts.companyId, scope.companyId),
      eq(universeDrafts.userId, scope.userId),
      eq(universeDrafts.conversationId, scope.conversationId),
      eq(universeDrafts.destinationKind, destination.kind),
      eq(universeDrafts.destinationId, destination.id),
    );

  return {
    async assertDestinationAccess(
      scope: UniverseScope,
      destination: UniverseDraftDestination,
    ): Promise<void> {
      const conversation = await db
        .select({ id: internalAgentConversations.id })
        .from(internalAgentConversations)
        .where(and(
          eq(internalAgentConversations.id, scope.conversationId),
          eq(internalAgentConversations.companyId, scope.companyId),
          eq(internalAgentConversations.userId, scope.userId),
        ))
        .limit(1);
      if (!conversation[0]) throw notFound("Universe draft destination not found");

      if (destination.kind === "commander") {
        if (destination.id !== scope.conversationId)
          throw notFound("Universe draft destination not found");
        return;
      }

      const rows = destination.kind === "task"
        ? await db.select({ id: issues.id }).from(issues).where(and(eq(issues.id, destination.id), eq(issues.companyId, scope.companyId))).limit(1)
        : destination.kind === "question"
          ? await db.select({ id: workQuestions.id }).from(workQuestions).where(and(
              eq(workQuestions.id, destination.id),
              eq(workQuestions.companyId, scope.companyId),
              eq(workQuestions.currentRecipientUserId, scope.userId),
            )).limit(1)
          : destination.kind === "runtime_decision"
            ? await db.select({ id: agentRuntimeDecisions.id }).from(agentRuntimeDecisions).where(and(
                eq(agentRuntimeDecisions.id, destination.id),
                eq(agentRuntimeDecisions.companyId, scope.companyId),
              )).limit(1)
            : await db.select({ id: approvals.id }).from(approvals).where(and(
                eq(approvals.id, destination.id),
                eq(approvals.companyId, scope.companyId),
              )).limit(1);
      if (!rows[0]) throw notFound("Universe draft destination not found");
    },

    async get(
      scope: UniverseScope,
      destination: UniverseDraftDestination,
    ): Promise<UniverseDraft> {
      const [row] = await db
        .select({
          revision: universeDrafts.revision,
          text: universeDrafts.text,
          attachmentAssetIds: universeDrafts.attachmentAssetIds,
          payload: universeDrafts.payload,
          pendingAttempt: universeDrafts.pendingAttempt,
        })
        .from(universeDrafts)
        .where(scopeWhere(scope, destination));
      if (!row) return emptyDraft();
      return {
        revision: row.revision,
        text: row.text,
        attachmentAssetIds: row.attachmentAssetIds,
        payload: (row.payload as UniverseDraftPayload | null) ?? legacyPayload(destination, row.text, row.attachmentAssetIds),
        pendingAttempt: (row.pendingAttempt as PendingDraftAttempt | null) ?? null,
      };
    },

    /** Compare-and-set on `expectedRevision`. A stale revision is a 409 carrying
     * the current server revision; the client retains its local draft (both
     * versions are kept — the server never concatenates). Clearing after a
     * durable send is just a patch to empty text/attachments. */
    async patch(
      scope: UniverseScope,
      destination: UniverseDraftDestination,
      patch: unknown,
    ): Promise<UniverseDraft> {
      const parsed = universeDraftPatchSchema.parse(patch);
      const payload = "payload" in parsed
        ? parsed.payload
        : legacyPayload(destination, parsed.text, parsed.attachmentAssetIds);
      if (!payload || payload.kind !== destination.kind)
        throw badRequest("Draft payload does not match its destination");
      const text = payload.kind === "commander" || payload.kind === "task" ? payload.text : "";
      const attachmentAssetIds = payload.kind === "commander" || payload.kind === "task" ? payload.attachmentAssetIds : [];
      if (attachmentAssetIds.length > 0) {
        const authorizedAssets = await db
          .select({ id: assets.id })
          .from(assets)
          .where(and(
            eq(assets.companyId, scope.companyId),
            eq(assets.composerValidated, true),
            inArray(assets.id, attachmentAssetIds),
          ));
        if (new Set(authorizedAssets.map(row => row.id)).size !== new Set(attachmentAssetIds).size)
          throw badRequest("One or more draft attachments are unavailable");
      }
      return db.transaction(async (tx) => {
        await tx
          .insert(universeDrafts)
          .values({
            companyId: scope.companyId,
            userId: scope.userId,
            conversationId: scope.conversationId,
            destinationKind: destination.kind,
            destinationId: destination.id,
            revision: 0,
            text: "",
            attachmentAssetIds: [],
          })
          .onConflictDoNothing();
        const [row] = await tx
          .select({
            id: universeDrafts.id,
            revision: universeDrafts.revision,
            pendingAttempt: universeDrafts.pendingAttempt,
          })
          .from(universeDrafts)
          .where(scopeWhere(scope, destination))
          .for("update");
        if (parsed.expectedRevision !== row.revision)
          throw conflict("Stale draft revision", { revision: row.revision });
        const nextRevision = row.revision + 1;
        const pendingAttempt = "pendingAttempt" in parsed
          ? parsed.pendingAttempt ?? null
          : (row.pendingAttempt as PendingDraftAttempt | null) ?? null;
        const [updated] = await tx
          .update(universeDrafts)
          .set({
            text,
            attachmentAssetIds,
            payload,
            pendingAttempt,
            revision: nextRevision,
            updatedAt: new Date(),
          })
          .where(eq(universeDrafts.id, row.id))
          .returning({
            revision: universeDrafts.revision,
            text: universeDrafts.text,
            attachmentAssetIds: universeDrafts.attachmentAssetIds,
            payload: universeDrafts.payload,
            pendingAttempt: universeDrafts.pendingAttempt,
          });
        return {
          revision: updated.revision,
          text: updated.text,
          attachmentAssetIds: updated.attachmentAssetIds,
          payload: updated.payload as UniverseDraftPayload,
          pendingAttempt: (updated.pendingAttempt as PendingDraftAttempt | null) ?? null,
        };
      });
    },
  };
}
