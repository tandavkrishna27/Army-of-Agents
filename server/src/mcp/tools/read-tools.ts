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
import { recordSecurityDenial } from "../../services/security-denial-audit.js";

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
 * Logs the read attempt regardless of outcome: a hit writes a `memory_retrievals`
 * row (rank=1), and a REFUSAL writes an attributable `security.denied.memory_read`
 * row via `recordSecurityDenial` (DE-19's audit clause — see `denyMemoryGet`).
 * The response is identical for every refusal; only the audit row tells them apart.
 */
async function handleMemoryGet(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = z.object({ id: z.string().uuid() }).parse(args);

  /**
   * DE-19, audit clause: "context retrieval and denials are recorded in the
   * retrieval audit". Retrieval was already recorded (`recordMemoryRetrievals`
   * below); the refusals were not, so a cross-tenant probe and a request that
   * never happened left identical durable state — nothing. `E0-F013` filed that.
   *
   * The record is written to `activity_log`, NOT to `memory_retrievals`: that
   * table's charter is "one row per item RETURNED", it bumps
   * `memory_items.validationCount`, and it feeds the Workspace MemorySection and
   * the company brain graph. Writing refusals into it would corrupt live
   * consumers — the same mistake as overloading `worker_lease_rejections`, one
   * step subtler.
   *
   * The response text is deliberately IDENTICAL for every reason. The refusal
   * stays non-disclosing to the caller; the distinction lives in the audit row.
   */
  const denyMemoryGet = async (reason: string, control: string): Promise<ToolResult> => {
    await recordSecurityDenial(ctx.db, {
      companyId: ctx.companyId,
      crossing: "DE-19",
      surface: "memory_read",
      reason,
      actorType: ctx.actor.agentId ? "agent" : "user",
      actorId: ctx.actor.agentId ?? ctx.actor.userId,
      entityType: "memory_item",
      entityId: parsed.id,
      control,
      details: {
        tool: "memory.get",
        actorSourceRaw: ctx.actor.source,
        agentId: ctx.actor.agentId ?? null,
        runId: ctx.actor.runId ?? null,
      },
    });
    return notFoundResult("Memory item not found");
  };

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
  // Split from the single `!item || status !== "approved"` guard so the two
  // reasons are DISTINGUISHABLE in the record. They were always distinct
  // branches of the control; collapsing them in the audit would reproduce the
  // count-only shape (DE-06/DE-29) this class exists to reject. The caller's
  // response is unchanged — both still return the same opaque message.
  if (!item) {
    // Absent, another company's, or outside the caller's RBAC scope. The gate is
    // in-SQL and deliberately non-disclosing, so these are not separable here —
    // and saying so is more honest than inventing a finer reason than the
    // control actually computes.
    return denyMemoryGet("not_visible", "server/src/mcp/tools/read-tools.ts:handleMemoryGet gated fetch");
  }
  if (item.status !== "approved") {
    return denyMemoryGet("not_approved", "server/src/mcp/tools/read-tools.ts:handleMemoryGet status gate");
  }

  const allowed = filterMemoryForActor([item], actor);
  if (allowed.length === 0) {
    // Defence in depth: the post-fetch actor filter mirrors the in-SQL gate, so
    // in a consistent tree this is unreachable. It is recorded with its own
    // reason precisely so that a DIVERGENCE between the two gates becomes
    // visible in the audit instead of silently passing as `not_visible`.
    return denyMemoryGet("actor_filter_denied", "server/src/mcp/tools/read-tools.ts:handleMemoryGet actor filter");
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
