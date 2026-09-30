import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { assets } from "@armyofagents/db";
import {
  ISSUE_STATUSES,
  MEMORY_ITEM_LAYERS,
  mcpArtifactVersionSchema,
  mcpArtifactVersionShape,
  mcpDebriefSchema,
} from "@armyofagents/shared";
import { logActivity } from "../../services/index.js";
import { enqueueInboxItem } from "../../services/inbox-producer.js";
import { writeMemoryAndIndex } from "../../services/memory-write.js";
import {
  type ToolContext,
  type ToolHandler,
  type ToolResult,
  forbiddenResult,
  notFoundResult,
  ok,
} from "./types.js";
import {
  artifactProjectMap,
  assertScopedGoalAccess,
  assertScopedProjectAccess,
  canAccessProjectScopedEntity,
  filterArtifactsForScope,
  resolveMcpOwnerArtifactScope,
} from "./scope.js";

function hasOwn(value: object, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

async function canAssignTasks(ctx: ToolContext) {
  if (ctx.actor.source === "agent" && ctx.actor.agentId) {
    return ctx.services.accessSvc.hasPermission(
      ctx.companyId,
      "agent",
      ctx.actor.agentId,
      "tasks:assign",
    );
  }
  if (ctx.actor.source === "board" && ctx.scope.kind === "founder") {
    return true;
  }
  return ctx.services.accessSvc.canUser(ctx.companyId, ctx.actor.userId, "tasks:assign");
}

async function requireTaskAssignPermission(ctx: ToolContext) {
  if (await canAssignTasks(ctx)) return null;
  return forbiddenResult("Missing permission: tasks:assign");
}

async function handleDebriefPush(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = mcpDebriefSchema.parse(args);
  assertScopedProjectAccess(ctx.scope, parsed.departmentId ?? null, "Department");
  assertScopedProjectAccess(ctx.scope, parsed.projectId ?? null, "Project");
  const debrief = await ctx.services.debriefsSvc.create(ctx.companyId, {
    title: parsed.title ?? null,
    inputType: "mcp",
    rawContent: parsed.content,
    departmentId: parsed.departmentId ?? null,
    projectId: parsed.projectId ?? null,
    sourceInfo: parsed.source ?? null,
    createdBy: ctx.actorInfo.actorId,
  });
  await logActivity(ctx.db, {
    companyId: ctx.companyId,
    actorType: ctx.actorInfo.actorType,
    actorId: ctx.actorInfo.actorId,
    agentId: ctx.actorInfo.agentId,
    runId: ctx.actorInfo.runId,
    action: "debrief.created",
    entityType: "debrief",
    entityId: debrief.id,
    details: { title: debrief.title, inputType: "mcp" },
  });
  void ctx.services.extractionSvc.extractFromDebrief(ctx.companyId, debrief.id).catch(() => {});

  // Decision #14 — dual-write to thread_inbox_items (best-effort).
  // A failure here must never break the legacy debrief consumers: the debrief
  // row is already committed above, so we silently swallow any error.
  enqueueInboxItem(ctx.db, {
    companyId: ctx.companyId,
    originMedium: "mcp",
    originSource: ctx.actorInfo.actorId,
    rawContent: parsed.content,
  }).catch((err: unknown) => {
    console.error("[debrief-push] inbox enqueue failed (best-effort):", err);
  });

  return ok({ debriefId: debrief.id, status: "processing" });
}

async function handleSuggestMemory(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = z
    .object({
      title: z.string().min(1),
      content: z.string().min(1),
      category: z.string().min(1),
      tags: z.array(z.string()).optional(),
      departmentId: z.string().uuid().nullable().optional(),
      projectId: z.string().uuid().nullable().optional(),
      layer: z.string().nullable().optional(),
      priority: z.number().int().optional(),
      goalId: z.string().uuid().nullable().optional(),
      taskId: z.string().uuid().nullable().optional(),
    })
    .parse(args);

  assertScopedProjectAccess(ctx.scope, parsed.departmentId ?? null, "Department");
  assertScopedProjectAccess(ctx.scope, parsed.projectId ?? null, "Project");
  await assertScopedGoalAccess(ctx.db, ctx.scope, parsed.goalId ?? null);

  let linkedTask: Awaited<ReturnType<typeof ctx.services.issuesSvc.getById>> | null = null;
  if (parsed.taskId) {
    linkedTask = await ctx.services.issuesSvc.getById(parsed.taskId);
    if (!linkedTask || linkedTask.companyId !== ctx.companyId) {
      return notFoundResult("Task not found");
    }
    assertScopedProjectAccess(ctx.scope, linkedTask.projectId, "Task");
  }

  const memoryDepartmentId =
    parsed.departmentId ?? parsed.projectId ?? linkedTask?.projectId ?? null;
  const canCreateMemory = await ctx.services.permissionsSvc.canAccessMemory(
    ctx.companyId,
    ctx.actor.userId,
    "create",
    {
      layer: parsed.layer ?? null,
      departmentId: memoryDepartmentId,
      visibility: "scoped",
    },
  );
  if (!canCreateMemory) {
    return forbiddenResult("Insufficient permissions for memory create");
  }

  const item = await ctx.services.memorySvc.create(ctx.companyId, {
    ...parsed,
    source: "mcp",
    createdBy: ctx.actor.userId,
    status: "pending",
    visibility: "scoped",
    priority: parsed.priority ?? 0,
    tags: parsed.tags ?? null,
    departmentId: parsed.departmentId ?? null,
    projectId: parsed.projectId ?? null,
    layer: parsed.layer ?? null,
    goalId: parsed.goalId ?? null,
    taskId: parsed.taskId ?? null,
  });
  await logActivity(ctx.db, {
    companyId: ctx.companyId,
    actorType: "user",
    actorId: ctx.actor.userId,
    action: "memory.created",
    entityType: "memory_item",
    entityId: item.id,
    details: { title: item.title, source: item.source, status: item.status },
  });
  return ok({ id: item.id, status: item.status });
}

async function handleUpdateTaskStatus(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = z
    .object({ taskId: z.string(), status: z.enum(ISSUE_STATUSES) })
    .parse(args);
  const issue = await ctx.services.issuesSvc.getById(parsed.taskId);
  if (
    !issue ||
    issue.companyId !== ctx.companyId ||
    !canAccessProjectScopedEntity(ctx.scope, issue.projectId)
  ) {
    return notFoundResult("Task not found");
  }
  const canUpdateTask = await ctx.services.permissionsSvc.canAccessEntity(
    ctx.companyId,
    ctx.actor.userId,
    "task",
    "update",
    {
      departmentId: issue.projectId ?? null,
      assigneeUserId: issue.assigneeUserId ?? null,
    },
  );
  if (!canUpdateTask) {
    return forbiddenResult("Insufficient permissions for task update");
  }
  const updated = await ctx.services.issuesSvc.update(
    parsed.taskId,
    { status: parsed.status },
    { actorType: "user", expectedUpdatedAt: issue.updatedAt },
  );
  await logActivity(ctx.db, {
    companyId: ctx.companyId,
    actorType: "user",
    actorId: ctx.actor.userId,
    action: "issue.updated",
    entityType: "issue",
    entityId: parsed.taskId,
    details: { status: parsed.status, source: "mcp" },
  });
  return ok(updated);
}

async function handleCreateTask(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = z
    .object({
      title: z.string().min(1),
      description: z.string().nullable().optional(),
      projectId: z.string().min(1).nullable().optional(),
      goalId: z.string().min(1).nullable().optional(),
      parentId: z.string().min(1).nullable().optional(),
      status: z.enum(ISSUE_STATUSES).optional(),
      priority: z.string().optional(),
      assigneeAgentId: z.string().min(1).nullable().optional(),
      assigneeUserId: z.string().min(1).nullable().optional(),
      responsibleUserId: z.string().min(1).nullable().optional(),
      labelIds: z.array(z.string().min(1)).optional(),
    })
    .parse(args);

  if (parsed.projectId) {
    const project = await ctx.services.projectsSvc.getById(parsed.projectId);
    if (!project || project.companyId !== ctx.companyId) {
      return notFoundResult("Project not found");
    }
    assertScopedProjectAccess(ctx.scope, parsed.projectId, "Project");
  }
  const canCreate = await ctx.services.permissionsSvc.canAccessEntity(
    ctx.companyId,
    ctx.actor.userId,
    "task",
    "create",
    { departmentId: parsed.projectId ?? null },
  );
  if (!canCreate) {
    return forbiddenResult("Insufficient permissions for task create");
  }
  if (hasOwn(parsed, "responsibleUserId")) {
    const assignDenied = await requireTaskAssignPermission(ctx);
    if (assignDenied) return assignDenied;
  }
  const created = await ctx.services.issuesSvc.create(ctx.companyId, {
    ...parsed,
    createdByUserId: ctx.actorInfo.actorType === "user" ? ctx.actorInfo.actorId : null,
    createdByAgentId: ctx.actorInfo.agentId ?? null,
    responsibleFallbackUserId: ctx.actorInfo.actorType === "user" ? ctx.actorInfo.actorId : null,
  } as any);
  await logActivity(ctx.db, {
    companyId: ctx.companyId,
    actorType: ctx.actorInfo.actorType,
    actorId: ctx.actorInfo.actorId,
    agentId: ctx.actorInfo.agentId,
    runId: ctx.actorInfo.runId,
    action: "issue.created",
    entityType: "issue",
    entityId: created.id,
    details: { title: created.title, source: "mcp" },
  });
  return ok(created);
}

async function handleUpdateTask(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = z
    .object({
      taskId: z.string().min(1),
      title: z.string().min(1).optional(),
      description: z.string().nullable().optional(),
      projectId: z.string().min(1).nullable().optional(),
      goalId: z.string().min(1).nullable().optional(),
      status: z.enum(ISSUE_STATUSES).optional(),
      priority: z.string().optional(),
      assigneeAgentId: z.string().min(1).nullable().optional(),
      assigneeUserId: z.string().min(1).nullable().optional(),
      responsibleUserId: z.string().min(1).nullable().optional(),
      labelIds: z.array(z.string().min(1)).optional(),
    })
    .parse(args);

  const existing = await ctx.services.issuesSvc.getById(parsed.taskId);
  if (
    !existing ||
    existing.companyId !== ctx.companyId ||
    !canAccessProjectScopedEntity(ctx.scope, existing.projectId)
  ) {
    return notFoundResult("Task not found");
  }
  if (parsed.projectId) {
    const project = await ctx.services.projectsSvc.getById(parsed.projectId);
    if (!project || project.companyId !== ctx.companyId) {
      return notFoundResult("Project not found");
    }
    assertScopedProjectAccess(ctx.scope, parsed.projectId, "Project");
  }
  const canUpdate = await ctx.services.permissionsSvc.canAccessEntity(
    ctx.companyId,
    ctx.actor.userId,
    "task",
    "update",
    {
      departmentId: existing.projectId ?? null,
      assigneeUserId: existing.assigneeUserId ?? null,
    },
  );
  if (!canUpdate) {
    return forbiddenResult("Insufficient permissions for task update");
  }
  if (hasOwn(parsed, "responsibleUserId")) {
    const assignDenied = await requireTaskAssignPermission(ctx);
    if (assignDenied) return assignDenied;
  }
  const { taskId, ...patch } = parsed;
  const updated = await ctx.services.issuesSvc.update(
    taskId,
    patch as any,
    { actorType: "user", expectedUpdatedAt: existing.updatedAt },
  );
  await logActivity(ctx.db, {
    companyId: ctx.companyId,
    actorType: "user",
    actorId: ctx.actor.userId,
    action: "issue.updated",
    entityType: "issue",
    entityId: taskId,
    details: { fields: Object.keys(patch), source: "mcp" },
  });
  return ok(updated);
}

async function handleAddTaskComment(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = z
    .object({
      taskId: z.string().min(1),
      body: z.string().min(1),
    })
    .parse(args);

  const task = await ctx.services.issuesSvc.getById(parsed.taskId);
  if (
    !task ||
    task.companyId !== ctx.companyId ||
    !canAccessProjectScopedEntity(ctx.scope, task.projectId)
  ) {
    return notFoundResult("Task not found");
  }
  const comment = await ctx.services.issuesSvc.addComment(parsed.taskId, parsed.body, {
    userId: ctx.actorInfo.actorType === "user" ? ctx.actorInfo.actorId : undefined,
    agentId: ctx.actorInfo.agentId ?? undefined,
  });
  await logActivity(ctx.db, {
    companyId: ctx.companyId,
    actorType: ctx.actorInfo.actorType,
    actorId: ctx.actorInfo.actorId,
    agentId: ctx.actorInfo.agentId,
    runId: ctx.actorInfo.runId,
    action: "issue.commented",
    entityType: "issue",
    entityId: parsed.taskId,
    details: { commentId: comment.id, source: "mcp" },
  });
  return ok(comment);
}

export async function handleAttachArtifactVersion(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = z
    .object({
      artifactId: z.string().uuid(),
      sourceDetail: mcpArtifactVersionShape.sourceDetail,
      changelog: mcpArtifactVersionShape.changelog,
      parentVersionId: mcpArtifactVersionShape.parentVersionId,
      content: mcpArtifactVersionShape.content,
      fileUrl: mcpArtifactVersionShape.fileUrl,
      storageKind: mcpArtifactVersionShape.storageKind,
      assetId: mcpArtifactVersionShape.assetId,
      filename: mcpArtifactVersionShape.filename,
      contentType: mcpArtifactVersionShape.contentType,
      extension: mcpArtifactVersionShape.extension,
      byteSize: mcpArtifactVersionShape.byteSize,
      sha256: mcpArtifactVersionShape.sha256,
    })
    .parse(args);

  const artifact = await ctx.services.artifactsSvc.getById(parsed.artifactId);
  // Tenant isolation: getById is not company-scoped and founder scope is a
  // pass-through in filterArtifactsForScope — an artifact owned by another
  // company must never be writable through this tool. The companyId check is
  // the real guard.
  let filtered: Array<Record<string, unknown>> = [];
  if (artifact && artifact.companyId === ctx.companyId) {
    const artifactScope =
      ctx.actor.source === "mcp"
        ? await resolveMcpOwnerArtifactScope(ctx.db, ctx.companyId, ctx.actor.userId)
        : ctx.scope;
    filtered = await filterArtifactsForScope(ctx.db, artifactScope, [artifact]);
  }
  if (filtered.length === 0) {
    return notFoundResult("Artifact not found");
  }
  const linkedProjectId =
    (await artifactProjectMap(ctx.db, [parsed.artifactId])).get(parsed.artifactId) ?? null;
  const canUpdateArtifact = await ctx.services.permissionsSvc.canAccessEntity(
    ctx.companyId,
    ctx.actor.userId,
    "artifact",
    "update",
    { departmentId: linkedProjectId },
  );
  if (!canUpdateArtifact) {
    return forbiddenResult("Insufficient permissions for artifact update");
  }

  // Defense-in-depth (P1): for asset-backed versions, verify the asset is
  // owned by THIS company at the protocol boundary before forwarding. The
  // service-level assertAssetOwned guard (Task 3) is the universal check; this
  // is a redundant company-scoped lookup so a cross-tenant assetId is rejected
  // with a clean 404 here.
  if (parsed.storageKind === "asset") {
    if (!parsed.assetId) return notFoundResult("assetId required for asset-backed version");
    const asset = await ctx.db
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.id, parsed.assetId), eq(assets.companyId, ctx.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!asset) return notFoundResult("Asset not found");
  }

  const version = await ctx.services.artifactsSvc.addVersion(parsed.artifactId, {
    source: "mcp",
    sourceDetail: parsed.sourceDetail,
    changelog: parsed.changelog ?? null,
    parentVersionId: parsed.parentVersionId ?? null,
    content: parsed.content ?? null,
    fileUrl: parsed.fileUrl ?? null,
    storageKind: parsed.storageKind ?? "inline",
    assetId: parsed.assetId ?? null,
    filename: parsed.filename ?? null,
    contentType: parsed.contentType ?? null,
    extension: parsed.extension ?? null,
    byteSize: parsed.byteSize ?? null,
    sha256: parsed.sha256 ?? null,
  });
  await logActivity(ctx.db, {
    companyId: ctx.companyId,
    actorType: "user",
    actorId: ctx.actor.userId,
    action: "artifact.version_added",
    entityType: "artifact",
    entityId: parsed.artifactId,
    details: {
      versionId: version.id,
      versionNumber: version.versionNumber,
      source: "mcp",
    },
  });
  return ok(version);
}

/**
 * Worker-facing memory.retain.
 *
 * Two distinct paths based on caller + scope:
 *
 *   PATH 1 — agent-personal scope (auto-approved)
 *     Conditions: actor.source === "agent" AND scopeToSelf === true
 *                 AND actor.agentId is set
 *     Behavior: creates the item, then immediately approves it. The
 *               item's agentId column is set to the caller's agentId,
 *               which scopes it to the agent's personal "notebook" —
 *               only this agent (plus founder/team_lead in scope) sees
 *               it on subsequent reads. No founder review required.
 *               This is the agent equivalent of jotting in a private
 *               diary. Critical Rule #6 is preserved because the agent
 *               can only auto-approve INTO ITS OWN BUCKET.
 *
 *   PATH 2 — org/department/project scope (pending)
 *     Conditions: any other call shape
 *     Behavior: identical to suggest-memory — creates a pending item
 *               that requires founder approval. RBAC scope check
 *               applies.
 *
 * Critical Rule #6 footnote: agents cannot write to identity / domain
 * memory directly. Auto-approve is gated on (a) the personal-scope
 * boolean and (b) actor being an agent. Founders calling memory.retain
 * (e.g., from the board) always go through the pending path because
 * they have richer authoring tools at /companies/:cid/memory.
 */
async function handleMemoryRetain(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = z
    .object({
      title: z.string().min(1),
      content: z.string().min(1),
      category: z.string().min(1),
      layer: z.enum(MEMORY_ITEM_LAYERS),
      sourceContext: z.string().min(1),
      tags: z.array(z.string()).optional(),
      departmentId: z.string().uuid().nullable().optional(),
      projectId: z.string().uuid().nullable().optional(),
      goalId: z.string().uuid().nullable().optional(),
      taskId: z.string().uuid().nullable().optional(),
      scopeToSelf: z.boolean().optional(),
    })
    .parse(args);

  const callerAgentId = ctx.actor.agentId ?? null;
  const isAgentActor = ctx.actor.source === "agent";
  // SECURITY (Critical Rule #6 / Decisions #15, #52): an agent may only
  // auto-approve its OWN working-memory bucket. identity/domain/active_context
  // are founder/lead-gated layers and must NEVER be agent-self-approved —
  // otherwise a compromised/prompt-injected worker agent could plant permanent,
  // company-wide, founder-attributed "Key Knowledge" that is injected into every
  // other agent's run context (a stored cross-agent prompt-injection primitive).
  // A scopeToSelf retain targeting a governed layer falls through to the RBAC +
  // founder-approval (pending) path below.
  const isPersonalScope =
    parsed.scopeToSelf === true &&
    isAgentActor &&
    callerAgentId !== null &&
    parsed.layer === "working";

  // SECURITY (A-M2): validate that every caller-supplied linked entity
  // belongs to THIS company before persisting. This guard runs for BOTH the
  // personal/working-scope and org/department/project paths — it must never be
  // skipped by the isPersonalScope branch, otherwise a worker agent could plant
  // a working-memory item cross-linked to another tenant's task/goal/project.
  // departmentId is a row in the projects table, so it is validated the same
  // way as projectId via projectsSvc.getById. (Sibling handleSuggestMemory does
  // the same companyId check for taskId.)
  if (parsed.taskId) {
    const task = await ctx.services.issuesSvc.getById(parsed.taskId);
    if (!task || task.companyId !== ctx.companyId) {
      return notFoundResult("Task not found");
    }
  }
  if (parsed.goalId) {
    const goal = await ctx.services.goalsSvc.getById(parsed.goalId);
    if (!goal || goal.companyId !== ctx.companyId) {
      return notFoundResult("Goal not found");
    }
  }
  if (parsed.projectId) {
    const project = await ctx.services.projectsSvc.getById(parsed.projectId);
    if (!project || project.companyId !== ctx.companyId) {
      return notFoundResult("Project not found");
    }
  }
  if (parsed.departmentId) {
    const department = await ctx.services.projectsSvc.getById(parsed.departmentId);
    if (!department || department.companyId !== ctx.companyId) {
      return notFoundResult("Department not found");
    }
  }

  // Org/department/project scope path — re-check RBAC even though the
  // route already gates company access; the founder's permissionsSvc
  // can deny per-layer or per-department writes.
  if (!isPersonalScope) {
    assertScopedProjectAccess(ctx.scope, parsed.departmentId ?? null, "Department");
    assertScopedProjectAccess(ctx.scope, parsed.projectId ?? null, "Project");
    await assertScopedGoalAccess(ctx.db, ctx.scope, parsed.goalId ?? null);

    const memoryDepartmentId =
      parsed.departmentId ?? parsed.projectId ?? null;
    const canCreateMemory = await ctx.services.permissionsSvc.canAccessMemory(
      ctx.companyId,
      ctx.actor.userId,
      "create",
      {
        layer: parsed.layer,
        departmentId: memoryDepartmentId,
        visibility: "scoped",
      },
    );
    if (!canCreateMemory) {
      return forbiddenResult("Insufficient permissions for memory create");
    }
  }

  // memorySvc.create() forces source=agent → status=pending. We use
  // that path for both routes, then immediately approve when
  // isPersonalScope (preserving the rule that agents create pending
  // items, but allowing the agent to flip its own personal bucket to
  // approved as a follow-up step).
  const item = await ctx.services.memorySvc.create(ctx.companyId, {
    title: parsed.title,
    content: parsed.content,
    category: parsed.category,
    layer: parsed.layer,
    source: isAgentActor ? "agent" : "mcp",
    sourceContext: parsed.sourceContext,
    createdBy: ctx.actor.userId,
    visibility: "scoped",
    priority: 0,
    tags: parsed.tags ?? null,
    departmentId: parsed.departmentId ?? null,
    projectId: parsed.projectId ?? null,
    goalId: parsed.goalId ?? null,
    taskId: parsed.taskId ?? null,
    agentId: isPersonalScope ? callerAgentId : null,
  });

  let finalStatus = item.status;
  if (isPersonalScope && item.status === "pending") {
    const approved = await ctx.services.memorySvc.approve(ctx.companyId, item.id);
    if (approved) finalStatus = approved.status;
  }

  await logActivity(ctx.db, {
    companyId: ctx.companyId,
    actorType: isAgentActor ? "agent" : "user",
    actorId: ctx.actor.userId,
    agentId: isAgentActor ? callerAgentId : null,
    runId: ctx.actor.runId ?? null,
    action: "memory.created",
    entityType: "memory_item",
    entityId: item.id,
    details: {
      title: item.title,
      source: item.source,
      status: finalStatus,
      scopeToSelf: isPersonalScope,
      layer: parsed.layer,
    },
  });

  return ok({ id: item.id, status: finalStatus, agentId: item.agentId });
}

/**
 * Task 9 W3 — memory.write.
 *
 * Board/MCP/commander-only write path that creates a memory item via the shared
 * `writeMemoryAndIndex` service, guaranteeing RAG embedding coverage. Unlike
 * `memory.retain`, this tool:
 *
 *   - Always creates with status='pending' (no auto-approve path) — the founder
 *     must review every item written through this tool (Critical Rule #6 /
 *     Decisions #15, #52).
 *   - Accepts a superset of `suggest-memory`'s fields plus `sourceContext`
 *     (required — the caller must explain where the memory came from).
 *   - Sets source='mcp' for bearer-token callers and source='agent' for agent
 *     actors, so the Knowledge Base UI can distinguish origins.
 *
 * Actor gating: board + mcp + commander. Worker agents (source='agent') are NOT
 * excluded from calling this tool via the HTTP endpoint (memory.retain is the
 * canonical agent path, but memory.write is intentionally all-actors since a
 * commander or MCP script may want the richer `sourceContext` field). The
 * isPersonalScope auto-approve of memory.retain is NOT present here — every
 * write through this tool goes to pending regardless of scopeToSelf.
 */
async function handleMemoryWrite(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = z
    .object({
      title: z.string().min(1),
      content: z.string().min(1),
      category: z.string().min(1),
      layer: z.enum(MEMORY_ITEM_LAYERS),
      sourceContext: z.string().min(1),
      tags: z.array(z.string()).optional(),
      departmentId: z.string().uuid().nullable().optional(),
      projectId: z.string().uuid().nullable().optional(),
      goalId: z.string().uuid().nullable().optional(),
      taskId: z.string().uuid().nullable().optional(),
    })
    .parse(args);

  assertScopedProjectAccess(ctx.scope, parsed.departmentId ?? null, "Department");
  assertScopedProjectAccess(ctx.scope, parsed.projectId ?? null, "Project");
  await assertScopedGoalAccess(ctx.db, ctx.scope, parsed.goalId ?? null);

  // Validate linked entities belong to this company (A-M2 / tenant isolation).
  if (parsed.taskId) {
    const task = await ctx.services.issuesSvc.getById(parsed.taskId);
    if (!task || task.companyId !== ctx.companyId) {
      return notFoundResult("Task not found");
    }
    assertScopedProjectAccess(ctx.scope, task.projectId, "Task");
  }
  if (parsed.goalId) {
    const goal = await ctx.services.goalsSvc.getById(parsed.goalId);
    if (!goal || goal.companyId !== ctx.companyId) {
      return notFoundResult("Goal not found");
    }
  }
  if (parsed.projectId) {
    const project = await ctx.services.projectsSvc.getById(parsed.projectId);
    if (!project || project.companyId !== ctx.companyId) {
      return notFoundResult("Project not found");
    }
  }
  if (parsed.departmentId) {
    const department = await ctx.services.projectsSvc.getById(parsed.departmentId);
    if (!department || department.companyId !== ctx.companyId) {
      return notFoundResult("Department not found");
    }
  }

  const isAgentActor = ctx.actor.source === "agent";
  // Agent actors are explicitly allowed by toolAllowedActors and their writes are
  // ALWAYS stored as pending (founder approval is the safety gate). For an agent,
  // `ctx.actor.userId` is the agent id — it has no user roles, so canAccessMemory
  // would always return false and 403 the advertised tool (P2, Codex). Skip the
  // user-RBAC create check for agents; human/MCP actors still go through it.
  if (!isAgentActor) {
    const memoryDepartmentId = parsed.departmentId ?? parsed.projectId ?? null;
    const canCreateMemory = await ctx.services.permissionsSvc.canAccessMemory(
      ctx.companyId,
      ctx.actor.userId,
      "create",
      {
        layer: parsed.layer,
        departmentId: memoryDepartmentId,
        visibility: "scoped",
      },
    );
    if (!canCreateMemory) {
      return forbiddenResult("Insufficient permissions for memory create");
    }
  }

  const item = await writeMemoryAndIndex(ctx.db, ctx.companyId, {
    title: parsed.title,
    content: parsed.content,
    category: parsed.category,
    layer: parsed.layer,
    source: isAgentActor ? "agent" : "mcp",
    sourceContext: parsed.sourceContext,
    createdBy: ctx.actor.userId,
    status: "pending",
    visibility: "scoped",
    priority: 0,
    tags: parsed.tags ?? null,
    departmentId: parsed.departmentId ?? null,
    projectId: parsed.projectId ?? null,
    goalId: parsed.goalId ?? null,
    taskId: parsed.taskId ?? null,
  });

  await logActivity(ctx.db, {
    companyId: ctx.companyId,
    actorType: isAgentActor ? "agent" : "user",
    actorId: ctx.actor.userId,
    agentId: isAgentActor ? (ctx.actor.agentId ?? null) : null,
    runId: ctx.actor.runId ?? null,
    action: "memory.created",
    entityType: "memory_item",
    entityId: item.id,
    details: {
      title: item.title,
      source: item.source,
      status: item.status,
      layer: parsed.layer,
      via: "memory.write",
    },
  });

  return ok({ id: item.id, status: item.status });
}

export const writeToolHandlers: Record<string, ToolHandler> = {
  "debrief-push": handleDebriefPush,
  "suggest-memory": handleSuggestMemory,
  "update-task-status": handleUpdateTaskStatus,
  "create-task": handleCreateTask,
  "update-task": handleUpdateTask,
  "add-task-comment": handleAddTaskComment,
  "attach-artifact-version": handleAttachArtifactVersion,
  // Worker-facing memory tools.
  "memory.retain": handleMemoryRetain,
  // Task 9 W3 — write+RAG-index (status always pending, Critical Rule #6)
  "memory.write": handleMemoryWrite,
};
