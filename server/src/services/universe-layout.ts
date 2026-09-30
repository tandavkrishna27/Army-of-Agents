import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { universePanelCheckpoints, issues, artifacts, artifactVersions, internalAgentConversations, universeLayouts, universeLayoutOperations } from "@armyofagents/db";
import {
  checkpointPatchSchema, checkpointDataSchema, type CheckpointSnapshot,
  emptyUniverseLayoutDocument,
  layoutPatchSchema,
  universeLayoutDocumentSchema,
  UNIVERSE_LAYOUT_SCHEMA_VERSION,
  type LayoutAck,
  type UniverseLayoutDocument,
} from "@armyofagents/shared";
import { badRequest, conflict, notFound } from "../errors.js";
import { insertActivityLog, publishActivityLogged, type PersistedActivity } from "./activity-log.js";
import {
  applyLayoutOperations,
  applyLayoutWithOpenings,
  hashLayoutOperations,
  type UniverseScope,
} from "./universe-layout-document.js";

export type { UniverseScope } from "./universe-layout-document.js";
export {
  applyLayoutOp,
  applyLayoutOperations,
  hashLayoutOperations,
} from "./universe-layout-document.js";

export interface UniverseLayoutSnapshot {
  schemaVersion: number;
  revision: number;
  document: UniverseLayoutDocument;
}

// Personal layouts require the canonical owner, even for company administrators.
// A company access check alone does not grant access to another user's canvas.
async function requireConversationOwner(db: Pick<Db, "select">, scope: UniverseScope, lock = false) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(scope.companyId) || !uuid.test(scope.conversationId) || !scope.userId)
    throw notFound("Conversation not found");
  const query = db.select({ id: internalAgentConversations.id })
    .from(internalAgentConversations).where(and(
      eq(internalAgentConversations.companyId, scope.companyId),
      eq(internalAgentConversations.userId, scope.userId),
      eq(internalAgentConversations.id, scope.conversationId),
    ));
  // Hold ownership stable through the write transaction, including receipt replay.
  const [conversation] = await (lock ? query.for("share") : query);
  if (!conversation) throw notFound("Conversation not found");
}

type PanelRef = UniverseLayoutDocument["panels"][number]["ref"];
function canonicalPanelKey(scope: UniverseScope, ref: PanelRef) {
  return JSON.stringify([scope.companyId, scope.userId, scope.conversationId, ref.kind, ref.id, ref.version ?? null]);
}
async function referenceTitle(db: Pick<Db, "select">, scope: UniverseScope, ref: PanelRef) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (ref.companyId !== scope.companyId || !uuid.test(ref.id) || (ref.version !== undefined && !uuid.test(ref.version)))
    throw notFound("Panel reference not found");
  if (ref.kind === "task" && ref.version === undefined) {
    const [task] = await db.select({ title: issues.title }).from(issues)
      .where(and(eq(issues.companyId, scope.companyId), eq(issues.id, ref.id)));
    if (task) return task.title;
  } else if (ref.kind === "artifact") {
    const [artifact] = await db.select({ title: artifacts.title }).from(artifacts)
      .where(and(eq(artifacts.companyId, scope.companyId), eq(artifacts.id, ref.id)));
    if (artifact) {
      if (ref.version !== undefined) {
        const [version] = await db.select({ id: artifactVersions.id }).from(artifactVersions)
          .where(and(eq(artifactVersions.artifactId, ref.id), eq(artifactVersions.id, ref.version)));
        if (!version) throw notFound("Panel reference not found");
      }
      return artifact.title;
    }
  }
  // Browser references have no authoritative session resolver on this base.
  throw notFound("Panel reference not found");
}
async function authorizeDocument(db: Pick<Db, "select">, scope: UniverseScope, document: UniverseLayoutDocument) {
  const panels: UniverseLayoutDocument["panels"] = [];
  for (const panel of document.panels) {
    if (panel.key !== canonicalPanelKey(scope, panel.ref)) throw badRequest("Invalid canonical panel key");
    panels.push({ ...panel, title: await referenceTitle(db, scope, panel.ref) });
  }
  // Source renames must not make an otherwise valid saved layout unreadable.
  // Allocate display-title bytes from the remaining serialized snapshot budget.
  const encoder = new TextEncoder();
  let remaining = 262144 - encoder.encode(JSON.stringify({ ...document, panels: panels.map(p => ({...p, title: ""})) })).length;
  panels.forEach((panel, index) => {
    const budget = Math.max(0, Math.floor(remaining / (panels.length - index)));
    let title = "", used = 0;
    for (const char of panel.title) {
      const bytes = encoder.encode(JSON.stringify(char)).length - 2;
      if (used + bytes > budget || title.length + char.length > 1024) break;
      title += char; used += bytes;
    }
    panel.title = title; remaining -= used;
  });
  return universeLayoutDocumentSchema.parse({ ...document, panels });
}

function checkpointRef(scope: UniverseScope, key: string, sourceVersionId: string): PanelRef {
  if (key.length > 1024) throw badRequest("Invalid checkpoint key");
  let tuple: unknown;
  try { tuple = JSON.parse(key); } catch { throw badRequest("Invalid checkpoint key"); }
  if (!Array.isArray(tuple) || tuple.length !== 6 || tuple[0] !== scope.companyId || tuple[1] !== scope.userId || tuple[2] !== scope.conversationId || tuple[3] !== "artifact" || typeof tuple[4] !== "string" || tuple[5] !== sourceVersionId)
    throw badRequest("Checkpoint requires an exact owned artifact-version key");
  const ref: PanelRef = { companyId: scope.companyId, kind: "artifact", id: tuple[4], version: sourceVersionId };
  if (key !== canonicalPanelKey(scope, ref)) throw badRequest("Invalid canonical checkpoint key");
  return ref;
}
function checkpointWhere(scope: UniverseScope, key: string, version: string) {
  return and(eq(universePanelCheckpoints.companyId, scope.companyId), eq(universePanelCheckpoints.userId, scope.userId),
    eq(universePanelCheckpoints.conversationId, scope.conversationId), eq(universePanelCheckpoints.panelKey, key), eq(universePanelCheckpoints.sourceVersionId, version));
}

export function universeLayoutService(db: Db) {
  return {
    async getCheckpoint(scope: UniverseScope, key: string, sourceVersionId: string): Promise<CheckpointSnapshot | null> {
      await requireConversationOwner(db, scope);
      await referenceTitle(db, scope, checkpointRef(scope, key, sourceVersionId));
      const [row] = await db.select().from(universePanelCheckpoints).where(checkpointWhere(scope, key, sourceVersionId));
      if (!row) return null;
      if (row.schemaVersion !== 1) throw conflict("Unsupported checkpoint version");
      return { revision: row.revision, schemaVersion: 1, data: checkpointDataSchema.parse(row.data) };
    },
    async saveCheckpoint(scope: UniverseScope, key: string, input: unknown): Promise<CheckpointSnapshot> {
      const parsed = checkpointPatchSchema.safeParse(input);
      if (!parsed.success) throw badRequest("Invalid checkpoint payload");
      const patch = parsed.data;
      const ref = checkpointRef(scope, key, patch.sourceVersionId);
      let activity: PersistedActivity | undefined;
      const result = await db.transaction<CheckpointSnapshot>(async tx => {
        await requireConversationOwner(tx, scope, true);
        await referenceTitle(tx, scope, ref);
        await tx.insert(universePanelCheckpoints).values({ ...scope, panelKey: key, sourceVersionId: patch.sourceVersionId,
          schemaVersion: 1, revision: 0, data: { inputs: {}, selectedRows: [], filters: {} } }).onConflictDoNothing();
        const [row] = await tx.select().from(universePanelCheckpoints).where(checkpointWhere(scope, key, patch.sourceVersionId)).for("update");
        if (row.revision !== patch.expectedRevision) throw conflict("Stale checkpoint revision", { revision: row.revision });
        if (row.schemaVersion !== 1 || !Number.isSafeInteger(row.revision + 1)) throw conflict("Unsupported checkpoint revision/version");
        const revision = row.revision + 1;
        await tx.update(universePanelCheckpoints).set({ revision, data: patch.data, updatedAt: new Date() }).where(eq(universePanelCheckpoints.id, row.id));
        activity = await insertActivityLog(tx, { companyId: scope.companyId, actorType: "user", actorId: scope.userId,
          action: "universe.checkpoint.updated", entityType: "universe_checkpoint", entityId: row.id, details: { revision } });
        return { revision, schemaVersion: 1, data: patch.data };
      });
      if (activity) {
        try { publishActivityLogged(activity); }
        catch { console.warn("Universe checkpoint committed; activity notification failed", { checkpointId: activity.entityId }); }
      }
      return result;
    },
    async get(scope: UniverseScope): Promise<UniverseLayoutSnapshot> {
      await requireConversationOwner(db, scope);
      const [row] = await db
        .select({
          schemaVersion: universeLayouts.schemaVersion,
          revision: universeLayouts.revision,
          document: universeLayouts.document,
        })
        .from(universeLayouts)
        .where(
          and(
            eq(universeLayouts.companyId, scope.companyId),
            eq(universeLayouts.userId, scope.userId),
            eq(universeLayouts.conversationId, scope.conversationId),
          ),
        );
      if (!row)
        return {
          schemaVersion: UNIVERSE_LAYOUT_SCHEMA_VERSION,
          revision: 0,
          document: emptyUniverseLayoutDocument(),
        };
      return {
        schemaVersion: row.schemaVersion,
        revision: row.revision,
        document: await authorizeDocument(db, scope, row.document),
      };
    },

    /** The receipt is reached only through its authorized parent layout — an
     * operation id is never standalone authorization. */
    async getReceipt(
      scope: UniverseScope,
      operationId: string,
    ): Promise<LayoutAck | null> {
      await requireConversationOwner(db, scope);
      const [row] = await db
        .select({ acknowledgement: universeLayoutOperations.acknowledgement })
        .from(universeLayoutOperations)
        .innerJoin(
          universeLayouts,
          eq(universeLayoutOperations.layoutId, universeLayouts.id),
        )
        .where(
          and(
            eq(universeLayouts.companyId, scope.companyId),
            eq(universeLayouts.userId, scope.userId),
            eq(universeLayouts.conversationId, scope.conversationId),
            eq(universeLayoutOperations.operationId, operationId),
          ),
        );
      if (!row) return null;
      if (!row.acknowledgement) throw conflict("Legacy receipt requires snapshot reconciliation");
      return row.acknowledgement;
    },

    /** Apply a patch atomically: ensure/lock the owner row, dedupe by receipt
     * (same payload → original ack, changed payload → 409), require the expected
     * revision, apply the operations, bump the revision, and journal the receipt
     * — all in one transaction. A failed transaction leaves neither receipt nor
     * partial geometry. */
    async apply(scope: UniverseScope, patch: unknown): Promise<LayoutAck> {
      const parsed = layoutPatchSchema.parse(patch);
      const payloadHash = hashLayoutOperations(parsed.operations);
      let committedActivity: PersistedActivity | undefined;
      const ack = await db.transaction<LayoutAck>(async (tx) => {
        await requireConversationOwner(tx, scope, true);
        await tx
          .insert(universeLayouts)
          .values({
            companyId: scope.companyId,
            userId: scope.userId,
            conversationId: scope.conversationId,
            schemaVersion: UNIVERSE_LAYOUT_SCHEMA_VERSION,
            revision: 0,
            document: emptyUniverseLayoutDocument(),
          })
          .onConflictDoNothing();
        const [row] = await tx
          .select({
            id: universeLayouts.id,
            revision: universeLayouts.revision,
            document: universeLayouts.document,
          })
          .from(universeLayouts)
          .where(
            and(
              eq(universeLayouts.companyId, scope.companyId),
              eq(universeLayouts.userId, scope.userId),
              eq(universeLayouts.conversationId, scope.conversationId),
            ),
          )
          .for("update");
        const [receipt] = await tx
          .select({
            acknowledgement: universeLayoutOperations.acknowledgement,
            payloadHash: universeLayoutOperations.payloadHash,
            revision: universeLayoutOperations.acknowledgedRevision,
          })
          .from(universeLayoutOperations)
          .where(
            and(
              eq(universeLayoutOperations.layoutId, row.id),
              eq(universeLayoutOperations.operationId, parsed.operationId),
            ),
          );
        if (receipt) {
          if (receipt.payloadHash !== payloadHash)
            throw conflict("Operation id reused with a different payload");
          if (!receipt.acknowledgement) throw conflict("Legacy receipt requires snapshot reconciliation");
          return receipt.acknowledgement;
        }
        if (parsed.expectedRevision !== row.revision)
          throw conflict("Stale revision", { revision: row.revision });
        // Validate every open, including an open later closed in the same patch.
        for (const op of parsed.operations) {
          if (op.type !== "open") continue;
          const ref = { ...op.ref, companyId: scope.companyId };
          if (op.key !== canonicalPanelKey(scope, ref)) throw badRequest("Invalid canonical panel key");
          await referenceTitle(tx, scope, ref);
        }
        const applied = applyLayoutWithOpenings(row.document, parsed.operations, scope);
        const nextDocument = await authorizeDocument(tx, scope, applied.document);
        if (!Number.isSafeInteger(row.revision + 1)) throw conflict("Layout revision exhausted");
        const nextRevision = row.revision + 1;
        const acknowledgement: LayoutAck = { operationId: parsed.operationId, revision: nextRevision,
          schemaVersion: UNIVERSE_LAYOUT_SCHEMA_VERSION, nextOpenedOrdinal: nextDocument.nextOpenedOrdinal,
          opened: applied.opened };
        await tx
          .update(universeLayouts)
          .set({
            document: nextDocument,
            revision: nextRevision,
            updatedAt: new Date(),
          })
          .where(eq(universeLayouts.id, row.id));
        await tx.insert(universeLayoutOperations).values({
          layoutId: row.id,
          companyId: scope.companyId,
          operationId: parsed.operationId,
          payloadHash,
          acknowledgedRevision: nextRevision,
          acknowledgement,
        });
        committedActivity = await insertActivityLog(tx, {
          companyId: scope.companyId,
          actorType: "user",
          actorId: scope.userId,
          action: "universe.layout.updated",
          entityType: "universe_layout",
          entityId: row.id,
          details: { revision: nextRevision, operationCount: parsed.operations.length },
        });
        return acknowledgement;
      });
      if (committedActivity) {
        try { publishActivityLogged(committedActivity); }
        catch {
          // The durable audit and receipt already committed. A notification
          // failure must not make a successful mutation appear unsuccessful.
          console.warn("Universe layout committed; activity notification failed", { layoutId: committedActivity.entityId });
        }
      }
      return ack;
    },
  };
}
