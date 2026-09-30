import { z } from "zod";
import { logActivity } from "../../services/index.js";
import {
  type ToolContext,
  type ToolHandler,
  type ToolResult,
  forbiddenResult,
  notFoundResult,
  ok,
} from "./types.js";
import { canAccessProjectScopedEntity } from "./scope.js";

const DOCUMENT_TYPE = "document";

/**
 * Paperclip's `paperclipUpsertIssueDocument` wraps a keyed markdown body
 * on an issue. AoA's equivalent is a single artifact (type="document")
 * linked from `issues.artifactId`. See Decision annotation (2026-04-21).
 *
 * Immutability invariant (Decisions #43/#45): artifact versions are never
 * mutated. `restore` always creates a NEW version copied from the target.
 */

async function assertTaskAccess(ctx: ToolContext, taskId: string) {
  const task = await ctx.services.issuesSvc.getById(taskId);
  if (
    !task ||
    task.companyId !== ctx.companyId ||
    !canAccessProjectScopedEntity(ctx.scope, task.projectId)
  ) {
    return { task: null, error: notFoundResult("Task not found") as ToolResult };
  }
  return { task, error: null as null | ToolResult };
}

async function handleUpsertTaskDocument(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = z
    .object({
      taskId: z.string().min(1),
      title: z.string().trim().max(200).nullable().optional(),
      body: z.string().max(524288),
      changeSummary: z.string().trim().max(500).nullable().optional(),
      baseRevisionId: z.string().min(1).nullable().optional(),
    })
    .parse(args);

  const { task, error } = await assertTaskAccess(ctx, parsed.taskId);
  if (error) return error;

  const canUpdate = await ctx.services.permissionsSvc.canAccessEntity(
    ctx.companyId,
    ctx.actor.userId,
    "artifact",
    "update",
    { departmentId: task!.projectId ?? null },
  );
  if (!canUpdate) {
    return forbiddenResult("Insufficient permissions for artifact update");
  }

  const existing = task!.artifactId
    ? await ctx.services.artifactsSvc.getById(task!.artifactId)
    : null;

  if (existing && existing.type === DOCUMENT_TYPE) {
    const version = await ctx.services.artifactsSvc.addVersion(existing.id, {
      source: "mcp",
      sourceDetail: "mcp:upsert-task-document",
      changelog: parsed.changeSummary ?? null,
      parentVersionId: parsed.baseRevisionId ?? null,
      content: parsed.body,
      fileUrl: null,
    });
    await logActivity(ctx.db, {
      companyId: ctx.companyId,
      actorType: ctx.actorInfo.actorType,
      actorId: ctx.actorInfo.actorId,
      agentId: ctx.actorInfo.agentId,
      runId: ctx.actorInfo.runId,
      action: "artifact.version_added",
      entityType: "artifact",
      entityId: existing.id,
      details: {
        versionId: version.id,
        versionNumber: version.versionNumber,
        source: "mcp",
        via: "upsert-task-document",
        taskId: parsed.taskId,
      },
    });
    return ok({ artifactId: existing.id, version });
  }

  const created = await ctx.services.artifactsSvc.create(
    ctx.companyId,
    ctx.actor.userId,
    {
      title: parsed.title ?? task!.title ?? "Task document",
      type: DOCUMENT_TYPE,
      source: "mcp",
      sourceDetail: "mcp:upsert-task-document",
      changelog: parsed.changeSummary ?? null,
      content: parsed.body,
    },
  );
  await ctx.services.issuesSvc.update(parsed.taskId, {
    artifactId: created.id,
  } as any);
  const firstVersion = created.versions?.[0] ?? null;
  await logActivity(ctx.db, {
    companyId: ctx.companyId,
    actorType: ctx.actorInfo.actorType,
    actorId: ctx.actorInfo.actorId,
    agentId: ctx.actorInfo.agentId,
    runId: ctx.actorInfo.runId,
    action: "artifact.created",
    entityType: "artifact",
    entityId: created.id,
    details: {
      type: DOCUMENT_TYPE,
      source: "mcp",
      via: "upsert-task-document",
      taskId: parsed.taskId,
      versionId: firstVersion?.id ?? null,
    },
  });
  return ok({ artifactId: created.id, version: firstVersion });
}

async function handleListTaskDocuments(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = z.object({ taskId: z.string().min(1) }).parse(args);
  const { task, error } = await assertTaskAccess(ctx, parsed.taskId);
  if (error) return error;
  if (!task!.artifactId) return ok([]);
  const artifact = await ctx.services.artifactsSvc.getById(task!.artifactId);
  if (!artifact || artifact.type !== DOCUMENT_TYPE) return ok([]);
  return ok([artifact]);
}

async function handleGetTaskDocument(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = z.object({ taskId: z.string().min(1) }).parse(args);
  const { task, error } = await assertTaskAccess(ctx, parsed.taskId);
  if (error) return error;
  if (!task!.artifactId) return notFoundResult("Task document not found");
  const artifact = await ctx.services.artifactsSvc.getById(task!.artifactId);
  if (!artifact || artifact.type !== DOCUMENT_TYPE) {
    return notFoundResult("Task document not found");
  }
  const versions = artifact.versions ?? [];
  const latestVersion =
    versions.length === 0
      ? null
      : versions.reduce((max, v) => (v.versionNumber > max.versionNumber ? v : max), versions[0]);
  return ok({ artifact, latestVersion });
}

async function handleListTaskDocumentRevisions(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = z.object({ taskId: z.string().min(1) }).parse(args);
  const { task, error } = await assertTaskAccess(ctx, parsed.taskId);
  if (error) return error;
  if (!task!.artifactId) return ok([]);
  const artifact = await ctx.services.artifactsSvc.getById(task!.artifactId);
  if (!artifact || artifact.type !== DOCUMENT_TYPE) return ok([]);
  const versions = [...(artifact.versions ?? [])].sort(
    (a, b) => a.versionNumber - b.versionNumber,
  );
  return ok(versions);
}

async function handleRestoreTaskDocumentRevision(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = z
    .object({
      taskId: z.string().min(1),
      revisionId: z.string().min(1),
    })
    .parse(args);

  const { task, error } = await assertTaskAccess(ctx, parsed.taskId);
  if (error) return error;
  if (!task!.artifactId) return notFoundResult("Task document not found");
  const artifact = await ctx.services.artifactsSvc.getById(task!.artifactId);
  if (!artifact || artifact.type !== DOCUMENT_TYPE) {
    return notFoundResult("Task document not found");
  }
  const target = (artifact.versions ?? []).find((v) => v.id === parsed.revisionId);
  if (!target) return notFoundResult("Revision not found");

  const canUpdate = await ctx.services.permissionsSvc.canAccessEntity(
    ctx.companyId,
    ctx.actor.userId,
    "artifact",
    "update",
    { departmentId: task!.projectId ?? null },
  );
  if (!canUpdate) {
    return forbiddenResult("Insufficient permissions for artifact update");
  }

  // Immutability (Decisions #43/#45): create a NEW version with content
  // copied from the target. The target row is never modified.
  const newVersion = await ctx.services.artifactsSvc.addVersion(artifact.id, {
    source: "mcp",
    sourceDetail: `mcp:restore-revision:${target.versionNumber}`,
    changelog: `Restored from version ${target.versionNumber}`,
    parentVersionId: target.id,
    content: target.content ?? null,
    fileUrl: target.fileUrl ?? null,
  });
  await logActivity(ctx.db, {
    companyId: ctx.companyId,
    actorType: ctx.actorInfo.actorType,
    actorId: ctx.actorInfo.actorId,
    agentId: ctx.actorInfo.agentId,
    runId: ctx.actorInfo.runId,
    action: "artifact.version_added",
    entityType: "artifact",
    entityId: artifact.id,
    details: {
      versionId: newVersion.id,
      versionNumber: newVersion.versionNumber,
      source: "mcp",
      via: "restore-task-document-revision",
      restoredFromVersionId: target.id,
      taskId: parsed.taskId,
    },
  });
  return ok({
    artifactId: artifact.id,
    restoredFromVersionId: target.id,
    version: newVersion,
  });
}

export const documentToolHandlers: Record<string, ToolHandler> = {
  "upsert-task-document": handleUpsertTaskDocument,
  "list-task-documents": handleListTaskDocuments,
  "get-task-document": handleGetTaskDocument,
  "list-task-document-revisions": handleListTaskDocumentRevisions,
  "restore-task-document-revision": handleRestoreTaskDocumentRevision,
};
