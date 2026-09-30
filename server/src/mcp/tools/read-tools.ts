import { z } from "zod";
import { MEMORY_ITEM_LAYERS } from "@armyofagents/shared";
import {
  type ToolContext,
  type ToolHandler,
  type ToolResult,
  notFoundResult,
  ok,
} from "./types.js";
import { assertScopedProjectAccess, canAccessProjectScopedEntity } from "./scope.js";
import { companyBrainGraphService } from "../../services/company-brain-graph.js";
import { expandRetrievalWithCompanyGraph } from "../../services/company-brain/retrieval-expansion.js";
import { recordMemoryRetrievals } from "../../services/memory-retrieval-audit.js";
import { actorForMcp, memoryAccessConditions } from "../../services/memory-access-sql.js";
import { filterMemoryForActor } from "../../services/memory-access.js";

async function handleMe(ctx: ToolContext): Promise<ToolResult> {
  const role = await ctx.resolveRole(ctx.companyId, ctx.actor.userId);
  return ok({
    userId: ctx.actor.userId,
    companyId: ctx.companyId,
    role,
  });
}

async function handleListAgents(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = z.object({ status: z.string().optional() }).parse(args);
  const allowedIds = await ctx.resolveScopedAgentIds(ctx.companyId, ctx.scope);
  let rows = await ctx.services.agentsSvc.list(ctx.companyId, { includeTerminated: true });
  if (allowedIds !== null) {
    rows = rows.filter((row) => allowedIds.has(row.id));
  }
  if (parsed.status) {
    rows = rows.filter((row) => row.status === parsed.status);
  }
  return ok(rows);
}

async function handleGetAgent(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = z.object({ agentId: z.string().min(1) }).parse(args);
  const agent = await ctx.services.agentsSvc.getById(parsed.agentId);
  if (!agent || agent.companyId !== ctx.companyId) {
    return notFoundResult("Agent not found");
  }
  const allowedIds = await ctx.resolveScopedAgentIds(ctx.companyId, ctx.scope);
  if (allowedIds !== null && !allowedIds.has(agent.id)) {
    return notFoundResult("Agent not found");
  }
  return ok(agent);
}

async function handleListProjects(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = z
    .object({ type: z.enum(["department", "project"]).optional() })
    .parse(args);
  let rows = await ctx.services.projectsSvc.list(
    ctx.companyId,
    parsed.type ? { type: parsed.type } : undefined,
  );
  if (ctx.scope.kind === "scoped") {
    const scopedIds = ctx.scope.projectIds;
    rows = rows.filter((row) => scopedIds.has(row.id));
  }
  return ok(rows);
}

async function handleGetProject(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = z.object({ projectId: z.string().min(1) }).parse(args);
  const project = await ctx.services.projectsSvc.getById(parsed.projectId);
  if (!project || project.companyId !== ctx.companyId) {
    return notFoundResult("Project not found");
  }
  if (!canAccessProjectScopedEntity(ctx.scope, project.id)) {
    return notFoundResult("Project not found");
  }
  return ok(project);
}

async function handleListTasks(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = z
    .object({
      status: z.string().optional(),
      projectId: z.string().optional(),
      assigneeAgentId: z.string().optional(),
      assigneeUserId: z.string().optional(),
      responsibleUserId: z.string().optional(),
      touchedByUserId: z.string().optional(),
      unreadForUserId: z.string().optional(),
      labelId: z.string().optional(),
      q: z.string().optional(),
    })
    .parse(args);
  if (parsed.projectId) {
    assertScopedProjectAccess(ctx.scope, parsed.projectId, "Project");
  }
  const rows = await ctx.services.issuesSvc.list(ctx.companyId, parsed);
  const filtered = rows.filter((row) => canAccessProjectScopedEntity(ctx.scope, row.projectId));
  return ok(filtered);
}

async function handleGetHeartbeatContext(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = z.object({ taskId: z.string().min(1) }).parse(args);
  const task = await ctx.services.issuesSvc.getById(parsed.taskId);
  if (
    !task ||
    task.companyId !== ctx.companyId ||
    !canAccessProjectScopedEntity(ctx.scope, task.projectId)
  ) {
    return notFoundResult("Task not found");
  }
  const comments = await ctx.services.issuesSvc.listComments(parsed.taskId);
  const recentComments = comments.slice(0, 10);
  return ok({ task, recentComments });
}

async function handleListTaskComments(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = z.object({ taskId: z.string().min(1) }).parse(args);
  const task = await ctx.services.issuesSvc.getById(parsed.taskId);
  if (
    !task ||
    task.companyId !== ctx.companyId ||
    !canAccessProjectScopedEntity(ctx.scope, task.projectId)
  ) {
    return notFoundResult("Task not found");
  }
  const comments = await ctx.services.issuesSvc.listComments(parsed.taskId);
  return ok(comments);
}

async function handleGetTaskComment(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = z.object({ commentId: z.string().min(1) }).parse(args);
  const comment = await ctx.services.issuesSvc.getComment(parsed.commentId);
  if (!comment || comment.companyId !== ctx.companyId) {
    return notFoundResult("Comment not found");
  }
  const task = await ctx.services.issuesSvc.getById(comment.issueId);
  if (
    !task ||
    task.companyId !== ctx.companyId ||
    !canAccessProjectScopedEntity(ctx.scope, task.projectId)
  ) {
    return notFoundResult("Comment not found");
  }
  return ok(comment);
}

/**
 * Worker-facing memory search.
 *
 * Runs memorySvc.searchMultiPath (semantic + keyword + temporal +
 * RRF + trust weighting) with the caller's `memoryAccessConditions` AND-ed
 * into the fetch (in-SQL, pre-ranking), then `filterMemoryForActor` as the
 * post-fetch safety net — the converged enterprise-memory RBAC gate
 * (P1-T5). Each shown item is logged to
 * memory_retrievals (triggeredBy: "agent_search" for agent actors,
 * "auto" otherwise — only agent_search wakes the workspace UI today
 * but the audit row is preserved either way).
 *
 * Returned items include rrfScore, finalScore, similarity, and
 * per-pathway ranks so callers can debug retrieval quality.
 */
async function handleMemorySearch(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = z
    .object({
      query: z.string().min(1),
      layer: z.enum(MEMORY_ITEM_LAYERS).optional(),
      category: z.string().optional(),
      departmentId: z.string().uuid().optional(),
      projectId: z.string().uuid().optional(),
      limit: z.number().int().positive().max(50).optional(),
    })
    .parse(args);

  // Resolve the RBAC actor from the MCP caller (agent → agent_projects, human →
  // user_roles) and build the in-SQL access gate. The gate is applied to the
  // fetch so an unreadable row is never returned nor ranked.
  const actor = await actorForMcp(ctx.db, ctx.companyId, {
    source: ctx.actor.source,
    userId: ctx.actor.userId,
    agentId: ctx.actor.agentId,
  }, ctx.scope);
  const accessConditions = memoryAccessConditions(ctx.db, actor);

  const results = await ctx.services.memorySvc.searchMultiPath(ctx.companyId, parsed.query, {
    layer: parsed.layer,
    category: parsed.category,
    departmentId: parsed.departmentId,
    projectId: parsed.projectId,
    limit: parsed.limit ?? 10,
    accessConditions,
  });

  // Post-fetch safety net mirroring the SQL gate — items the caller can't see
  // drop out before being returned, but their audit rows are still emitted with
  // shownToAgent=false so "queried but not shown" is debuggable.
  const allowed = filterMemoryForActor(results, actor);
  const allowedIds = new Set(allowed.map((row) => row.id));

  void recordMemoryRetrievals(ctx.db, {
    companyId: ctx.companyId,
    agentId: ctx.actor.agentId ?? null,
    runId: ctx.actor.runId ?? null,
    triggeredBy: ctx.actor.source === "agent" ? "agent_search" : "agent_search",
    query: parsed.query,
    items: results.map((item, idx) => ({
      id: item.id,
      rank: idx + 1,
      similarityScore: item.similarity,
      shownToAgent: allowedIds.has(item.id),
    })),
  });

  const graphSvc = companyBrainGraphService(ctx.db);
  const graphActor =
    (ctx.actor.source === "agent" || ctx.actor.source === "commander") && ctx.actor.agentId
      ? { type: "agent" as const, principalId: ctx.actor.agentId }
      : { type: "user" as const, principalId: ctx.actor.userId };
  const expanded = await expandRetrievalWithCompanyGraph({
    companyId: ctx.companyId,
    seeds: allowed,
    loadNeighbors: (memoryItemId) =>
      graphSvc.getMemoryItemNeighbors(ctx.companyId, memoryItemId, graphActor),
    // Graph neighbors are fetched by id, so the SQL gate must ride along on the
    // fetch — a naive post-fetch-only filter would leak goal/task-scoped neighbors.
    loadMemoryItem: (memoryItemId) =>
      ctx.services.memorySvc.getById(ctx.companyId, memoryItemId, accessConditions),
    filterMemoryItems: async (items) => filterMemoryForActor(items, actor),
  });

  return ok({ items: expanded.items, graphContext: expanded.graphContext });
}

/**
 * Worker-facing memory get.
 *
 * Fetches one approved memory item by id. Returns 404 when:
 *   - the item doesn't exist
 *   - the item belongs to another company
 *   - the item's status is not "approved"
 *   - the item is outside the caller's RBAC scope
 *
 * Logs the read attempt regardless of outcome (rank=1 for hits, no
 * audit row when item not found — there's nothing to record).
 */
async function handleMemoryGet(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = z.object({ id: z.string().uuid() }).parse(args);

  // RBAC gate (P1-T5): resolve the actor, then apply the access conditions to the
  // by-id fetch so goal/task scope is resolved in-SQL — an out-of-scope item comes
  // back null (a pure post-fetch filter would pass goal/task-only rows through).
  const actor = await actorForMcp(ctx.db, ctx.companyId, {
    source: ctx.actor.source,
    userId: ctx.actor.userId,
    agentId: ctx.actor.agentId,
  }, ctx.scope);
  const accessConditions = memoryAccessConditions(ctx.db, actor);

  const item = await ctx.services.memorySvc.getById(ctx.companyId, parsed.id, accessConditions);
  if (!item || item.status !== "approved") {
    return notFoundResult("Memory item not found");
  }

  const allowed = filterMemoryForActor([item], actor);
  if (allowed.length === 0) {
    return notFoundResult("Memory item not found");
  }

  void recordMemoryRetrievals(ctx.db, {
    companyId: ctx.companyId,
    agentId: ctx.actor.agentId ?? null,
    runId: ctx.actor.runId ?? null,
    triggeredBy: "agent_get",
    items: [{ id: item.id, rank: 1, shownToAgent: true }],
  });

  return ok(allowed[0]);
}

export const readToolHandlers: Record<string, ToolHandler> = {
  "me": handleMe,
  "list-agents": handleListAgents,
  "get-agent": handleGetAgent,
  "list-projects": handleListProjects,
  "get-project": handleGetProject,
  "list-tasks": handleListTasks,
  "get-heartbeat-context": handleGetHeartbeatContext,
  "list-task-comments": handleListTaskComments,
  "get-task-comment": handleGetTaskComment,
  // Worker-facing memory tools.
  "memory.search": handleMemorySearch,
  "memory.get": handleMemoryGet,
};
