import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  artifacts,
  artifactVersions,
  internalAgentConversations,
  internalAgentMessages,
  issues,
} from "@armyofagents/db";
import {
  universeContextSchema,
  type ResolvedUniverseContext,
  type ResolvedUniverseReference,
  type UniverseContext,
  type UniverseReference,
} from "@armyofagents/shared";
import { forbidden } from "../../errors.js";

export async function resolveUniverseContext(
  db: Db,
  input: { companyId: string; userId: string; conversationId: string; context: UniverseContext },
): Promise<ResolvedUniverseContext> {
  const context = universeContextSchema.parse(input.context);
  if (context.conversationId !== input.conversationId) throw forbidden("Universe context conversation mismatch");

  const [conversation] = await db.select({
    id: internalAgentConversations.id,
    userId: internalAgentConversations.userId,
    sharedWithCompany: internalAgentConversations.sharedWithCompany,
  }).from(internalAgentConversations).where(and(
    eq(internalAgentConversations.id, input.conversationId),
    eq(internalAgentConversations.companyId, input.companyId),
  ));
  if (!conversation || (conversation.userId !== input.userId && !conversation.sharedWithCompany)) {
    throw forbidden("Universe conversation is unavailable");
  }

  const references = [context.selected, ...context.visible].filter((value): value is UniverseReference => value !== null);
  const taskIds = [...new Set(references.filter((r) => r.kind === "task").map((r) => r.id))];
  const artifactIds = [...new Set(references.filter((r) => r.kind === "artifact").map((r) => r.id))];
  const versionIds = [...new Set(references.flatMap((r) => r.kind === "artifact" && r.versionId ? [r.versionId] : []))];
  const messageIds = [...new Set(references.filter((r) => r.kind === "message").map((r) => r.id))];

  const [taskRows, artifactRows, versionRows, messageRows] = await Promise.all([
    taskIds.length ? db.select({ id: issues.id, title: issues.title }).from(issues).where(and(eq(issues.companyId, input.companyId), inArray(issues.id, taskIds))) : [],
    artifactIds.length ? db.select({ id: artifacts.id, title: artifacts.title, currentVersionId: artifacts.currentVersionId }).from(artifacts).where(and(eq(artifacts.companyId, input.companyId), inArray(artifacts.id, artifactIds))) : [],
    versionIds.length ? db.select({ id: artifactVersions.id, artifactId: artifactVersions.artifactId }).from(artifactVersions).where(inArray(artifactVersions.id, versionIds)) : [],
    messageIds.length ? db.select({ id: internalAgentMessages.id, content: internalAgentMessages.content }).from(internalAgentMessages).where(and(eq(internalAgentMessages.conversationId, input.conversationId), inArray(internalAgentMessages.id, messageIds))) : [],
  ]);
  const taskMap = new Map(taskRows.map((row) => [row.id, row]));
  const artifactMap = new Map(artifactRows.map((row) => [row.id, row]));
  const versionMap = new Map(versionRows.map((row) => [row.id, row]));
  const messageMap = new Map(messageRows.map((row) => [row.id, row]));

  const resolve = (reference: UniverseReference): ResolvedUniverseReference => {
    if (reference.kind === "task") {
      const row = taskMap.get(reference.id);
      return row ? { reference, disposition: "available", label: row.title.slice(0, 240) } : { reference, disposition: "unavailable" };
    }
    if (reference.kind === "message") {
      const row = messageMap.get(reference.id);
      return row ? { reference, disposition: "available", label: (row.content ?? "Message").slice(0, 240) } : { reference, disposition: "unavailable" };
    }
    const artifact = artifactMap.get(reference.id);
    if (!artifact) return { reference, disposition: "unavailable" };
    if (reference.versionId && versionMap.get(reference.versionId)?.artifactId !== artifact.id) {
      return { reference, disposition: "unavailable" };
    }
    const superseded = Boolean(reference.versionId && artifact.currentVersionId && reference.versionId !== artifact.currentVersionId);
    return {
      reference,
      disposition: superseded ? "superseded" : "available",
      label: artifact.title.slice(0, 240),
      ...(superseded && artifact.currentVersionId ? { currentVersionId: artifact.currentVersionId } : {}),
    };
  };

  return {
    schemaVersion: 1,
    conversationId: context.conversationId,
    selected: context.selected ? resolve(context.selected) : null,
    visible: context.visible.map(resolve),
    viewport: context.viewport,
  };
}
