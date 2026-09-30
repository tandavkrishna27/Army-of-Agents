import { z } from "zod";
import {
  APPROVAL_STATUSES,
  APPROVAL_TYPES,
  createApprovalSchema,
} from "@armyofagents/shared";
import { logActivity } from "../../services/index.js";
import { hubItemsService } from "../../services/hub-items.js";
import { buildApprovalHubEmit, emitHubItem } from "../../services/hub-source-producers.js";
import {
  type ToolContext,
  type ToolHandler,
  type ToolResult,
  err,
  forbiddenResult,
  notFoundResult,
  ok,
} from "./types.js";
import { canAccessProjectScopedEntity } from "./scope.js";

const OPEN_APPROVAL_HUB_STATUSES = new Set(["pending", "revision_requested"]);

/**
 * True when the approval has at least one linked task whose project is in
 * the scoped user's project set. Founders bypass.
 */
async function approvalHasScopedIssueLink(
  ctx: ToolContext,
  approvalId: string,
): Promise<boolean> {
  if (ctx.scope.kind === "founder") return true;
  if (ctx.scope.projectIds.size === 0) return false;
  const rows = await ctx.services.issueApprovalsSvc.listIssuesForApproval(approvalId);
  return rows.some((row) => canAccessProjectScopedEntity(ctx.scope, row.projectId));
}

async function canActorSeeApproval(
  ctx: ToolContext,
  approval: { id: string; companyId: string; type: string },
): Promise<boolean> {
  if (approval.companyId !== ctx.companyId) return false;
  if (ctx.scope.kind === "founder") return true;
  // `install_mcp_connector` is company-wide governance with NO task link. The
  // founder decision (2026-07-24, routes/approvals.ts `assertMayResolveApproval`)
  // grants it to founder + team_lead; a team_member may neither see nor resolve
  // it. Type-only would over-expose it to team_members (who also have non-founder
  // scope), so gate on ROLE. All other types keep the per-task project-scope rule.
  if (approval.type === "install_mcp_connector") {
    const role = await ctx.resolveRole(ctx.companyId, ctx.actor.userId);
    return role === "team_lead"; // founder already returned true above
  }
  return approvalHasScopedIssueLink(ctx, approval.id);
}

async function syncApprovalHubItem(
  ctx: ToolContext,
  approval: { id: string; companyId: string; status: string } & Parameters<typeof buildApprovalHubEmit>[0],
) {
  if (OPEN_APPROVAL_HUB_STATUSES.has(approval.status)) {
    await emitHubItem(ctx.db, buildApprovalHubEmit(approval));
    return;
  }
  await hubItemsService(ctx.db).reconcile(approval.companyId, { sourceType: "approval", sourceId: approval.id });
}

async function handleListApprovals(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = z
    .object({
      status: z.enum(APPROVAL_STATUSES).optional(),
      type: z.enum(APPROVAL_TYPES).optional(),
    })
    .parse(args);
  let rows = await ctx.services.approvalsSvc.list(ctx.companyId, parsed.status);
  if (parsed.type) {
    rows = rows.filter((row) => row.type === parsed.type);
  }
  if (ctx.scope.kind !== "founder") {
    // Per-row visibility via canActorSeeApproval so a company-wide
    // install_mcp_connector approval (no task link) is visible to a team_lead
    // — matching the get/decide paths and the REST contract — while a
    // team_member still sees only task-scoped approvals.
    const filtered: typeof rows = [];
    for (const row of rows) {
      if (await canActorSeeApproval(ctx, row)) {
        filtered.push(row);
      }
    }
    rows = filtered;
  }
  return ok(rows);
}

async function handleGetApproval(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = z.object({ approvalId: z.string().uuid() }).parse(args);
  const approval = await ctx.services.approvalsSvc.getById(parsed.approvalId);
  if (!approval || !(await canActorSeeApproval(ctx, approval))) {
    return notFoundResult("Approval not found");
  }
  return ok(approval);
}

async function handleGetApprovalTasks(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = z.object({ approvalId: z.string().uuid() }).parse(args);
  const approval = await ctx.services.approvalsSvc.getById(parsed.approvalId);
  if (!approval || !(await canActorSeeApproval(ctx, approval))) {
    return notFoundResult("Approval not found");
  }
  let rows = await ctx.services.issueApprovalsSvc.listIssuesForApproval(parsed.approvalId);
  if (ctx.scope.kind !== "founder") {
    rows = rows.filter((row) => canAccessProjectScopedEntity(ctx.scope, row.projectId));
  }
  return ok(rows);
}

async function handleListApprovalComments(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = z.object({ approvalId: z.string().uuid() }).parse(args);
  const approval = await ctx.services.approvalsSvc.getById(parsed.approvalId);
  if (!approval || !(await canActorSeeApproval(ctx, approval))) {
    return notFoundResult("Approval not found");
  }
  const comments = await ctx.services.approvalsSvc.listComments(parsed.approvalId);
  return ok(comments);
}

async function handleListTaskApprovals(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = z.object({ taskId: z.string().uuid() }).parse(args);
  const task = await ctx.services.issuesSvc.getById(parsed.taskId);
  if (
    !task ||
    task.companyId !== ctx.companyId ||
    !canAccessProjectScopedEntity(ctx.scope, task.projectId)
  ) {
    return notFoundResult("Task not found");
  }
  const rows = await ctx.services.issueApprovalsSvc.listApprovalsForIssue(parsed.taskId);
  return ok(rows);
}

async function handleCreateApproval(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = createApprovalSchema.parse(args);
  const role = await ctx.resolveRole(ctx.companyId, ctx.actor.userId);
  if (role !== "founder" && role !== "team_lead") {
    return forbiddenResult("Only founders and team leads can create approvals");
  }

  const linkIssueIds = parsed.issueIds ?? [];
  if (linkIssueIds.length > 0) {
    for (const issueId of linkIssueIds) {
      const issue = await ctx.services.issuesSvc.getById(issueId);
      if (!issue || issue.companyId !== ctx.companyId) {
        return notFoundResult("Task not found");
      }
      if (!canAccessProjectScopedEntity(ctx.scope, issue.projectId)) {
        return forbiddenResult("Task is outside your scope");
      }
    }
  } else if (role === "team_lead") {
    // Team leads must tie approvals to at least one task in their scope to
    // establish authorship + scope gating. Founders may create unscoped.
    return forbiddenResult(
      "Team leads must link at least one task from their scope when creating an approval",
    );
  }

  const created = await ctx.services.approvalsSvc.create(ctx.companyId, {
    type: parsed.type,
    requestedByAgentId: parsed.requestedByAgentId ?? null,
    requestedByUserId: ctx.actor.userId,
    payload: parsed.payload,
    status: "pending",
  });

  if (linkIssueIds.length > 0) {
    await ctx.services.issueApprovalsSvc.linkManyForApproval(created.id, linkIssueIds, {
      userId: ctx.actor.userId,
    });
  }

  await logActivity(ctx.db, {
    companyId: ctx.companyId,
    actorType: ctx.actorInfo.actorType,
    actorId: ctx.actorInfo.actorId,
    agentId: ctx.actorInfo.agentId,
    runId: ctx.actorInfo.runId,
    action: "approval.created",
    entityType: "approval",
    entityId: created.id,
    details: { type: created.type, linkedIssues: linkIssueIds.length, source: "mcp" },
  });
  return ok(created);
}

const approvalDecisionInputSchema = z.object({
  approvalId: z.string().uuid(),
  action: z.enum(["approve", "reject", "requestRevision", "resubmit"]),
  decisionNote: z.string().optional(),
  payloadJson: z.string().optional(),
});

async function handleApprovalDecision(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = approvalDecisionInputSchema.parse(args);
  const role = await ctx.resolveRole(ctx.companyId, ctx.actor.userId);
  if (role !== "founder" && role !== "team_lead") {
    return forbiddenResult("Only founders and team leads can decide approvals");
  }

  const approval = await ctx.services.approvalsSvc.getById(parsed.approvalId);
  if (!approval || approval.companyId !== ctx.companyId) {
    return notFoundResult("Approval not found");
  }
  // install_mcp_connector is company-wide (no task link): a team_lead resolves it
  // without a scoped task, matching REST `assertMayResolveApproval`. The
  // founder|team_lead gate above already excludes team_member. Every other type
  // keeps the "must own a task in scope" rule.
  if (
    role === "team_lead" &&
    approval.type !== "install_mcp_connector" &&
    !(await approvalHasScopedIssueLink(ctx, parsed.approvalId))
  ) {
    return forbiddenResult("Approval has no tasks in your scope");
  }

  let decisionPayload: Record<string, unknown> | undefined;
  if (parsed.action === "resubmit" && parsed.payloadJson) {
    try {
      const parsedJson = JSON.parse(parsed.payloadJson);
      if (typeof parsedJson !== "object" || parsedJson === null) {
        return err(400, -32602, "payloadJson must be a JSON object");
      }
      decisionPayload = parsedJson as Record<string, unknown>;
    } catch {
      return err(400, -32602, "payloadJson is not valid JSON");
    }
  }

  let updated;
  switch (parsed.action) {
    case "approve":
      updated = await ctx.services.approvalsSvc.approve(
        parsed.approvalId,
        approval.companyId,
        ctx.actor.userId,
        parsed.decisionNote ?? null,
      );
      break;
    case "reject":
      updated = await ctx.services.approvalsSvc.reject(
        parsed.approvalId,
        approval.companyId,
        ctx.actor.userId,
        parsed.decisionNote ?? null,
      );
      break;
    case "requestRevision":
      updated = await ctx.services.approvalsSvc.requestRevision(
        parsed.approvalId,
        approval.companyId,
        ctx.actor.userId,
        parsed.decisionNote ?? null,
      );
      break;
    case "resubmit":
      updated = await ctx.services.approvalsSvc.resubmit(parsed.approvalId, approval.companyId, decisionPayload);
      break;
  }
  if (!updated) {
    // Defense-in-depth: service returned null because companyId WHERE didn't
    // match. The route-level company check already passed, so this only
    // fires if an upstream race or guard regression slipped through.
    return notFoundResult("Approval not found");
  }

  await logActivity(ctx.db, {
    companyId: ctx.companyId,
    actorType: ctx.actorInfo.actorType,
    actorId: ctx.actorInfo.actorId,
    agentId: ctx.actorInfo.agentId,
    runId: ctx.actorInfo.runId,
    action: `approval.${parsed.action}`,
    entityType: "approval",
    entityId: parsed.approvalId,
    details: { action: parsed.action, source: "mcp" },
  });
  await syncApprovalHubItem(ctx, updated);

  return ok(updated);
}

async function handleAddApprovalComment(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = z
    .object({
      approvalId: z.string().uuid(),
      body: z.string().min(1),
    })
    .parse(args);
  const approval = await ctx.services.approvalsSvc.getById(parsed.approvalId);
  if (!approval || !(await canActorSeeApproval(ctx, approval))) {
    return notFoundResult("Approval not found");
  }
  const comment = await ctx.services.approvalsSvc.addComment(parsed.approvalId, parsed.body, {
    userId: ctx.actorInfo.actorType === "user" ? ctx.actorInfo.actorId : undefined,
    agentId: ctx.actorInfo.agentId ?? undefined,
  });
  await logActivity(ctx.db, {
    companyId: ctx.companyId,
    actorType: ctx.actorInfo.actorType,
    actorId: ctx.actorInfo.actorId,
    agentId: ctx.actorInfo.agentId,
    runId: ctx.actorInfo.runId,
    action: "approval.commented",
    entityType: "approval",
    entityId: parsed.approvalId,
    details: { commentId: comment.id, source: "mcp" },
  });
  return ok(comment);
}

async function handleLinkTaskApproval(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = z
    .object({
      taskId: z.string().uuid(),
      approvalId: z.string().uuid(),
    })
    .parse(args);
  const role = await ctx.resolveRole(ctx.companyId, ctx.actor.userId);
  if (role !== "founder" && role !== "team_lead") {
    return forbiddenResult("Only founders and team leads can link approvals to tasks");
  }

  const task = await ctx.services.issuesSvc.getById(parsed.taskId);
  if (!task || task.companyId !== ctx.companyId) {
    return notFoundResult("Task not found");
  }
  if (!canAccessProjectScopedEntity(ctx.scope, task.projectId)) {
    return forbiddenResult("Task is outside your scope");
  }
  const approval = await ctx.services.approvalsSvc.getById(parsed.approvalId);
  if (!approval || approval.companyId !== ctx.companyId) {
    return notFoundResult("Approval not found");
  }

  const link = await ctx.services.issueApprovalsSvc.link(parsed.taskId, parsed.approvalId, {
    userId: ctx.actor.userId,
  });
  await logActivity(ctx.db, {
    companyId: ctx.companyId,
    actorType: ctx.actorInfo.actorType,
    actorId: ctx.actorInfo.actorId,
    agentId: ctx.actorInfo.agentId,
    runId: ctx.actorInfo.runId,
    action: "approval.linked",
    entityType: "approval",
    entityId: parsed.approvalId,
    details: { taskId: parsed.taskId, source: "mcp" },
  });
  return ok(link ?? { issueId: parsed.taskId, approvalId: parsed.approvalId });
}

async function handleUnlinkTaskApproval(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = z
    .object({
      taskId: z.string().uuid(),
      approvalId: z.string().uuid(),
    })
    .parse(args);
  const role = await ctx.resolveRole(ctx.companyId, ctx.actor.userId);
  if (role !== "founder" && role !== "team_lead") {
    return forbiddenResult("Only founders and team leads can unlink approvals from tasks");
  }

  const task = await ctx.services.issuesSvc.getById(parsed.taskId);
  if (!task || task.companyId !== ctx.companyId) {
    return notFoundResult("Task not found");
  }
  if (!canAccessProjectScopedEntity(ctx.scope, task.projectId)) {
    return forbiddenResult("Task is outside your scope");
  }
  const approval = await ctx.services.approvalsSvc.getById(parsed.approvalId);
  if (!approval || approval.companyId !== ctx.companyId) {
    return notFoundResult("Approval not found");
  }

  await ctx.services.issueApprovalsSvc.unlink(parsed.taskId, parsed.approvalId);
  await logActivity(ctx.db, {
    companyId: ctx.companyId,
    actorType: ctx.actorInfo.actorType,
    actorId: ctx.actorInfo.actorId,
    agentId: ctx.actorInfo.agentId,
    runId: ctx.actorInfo.runId,
    action: "approval.unlinked",
    entityType: "approval",
    entityId: parsed.approvalId,
    details: { taskId: parsed.taskId, source: "mcp" },
  });
  return ok({ ok: true });
}

export const approvalToolHandlers: Record<string, ToolHandler> = {
  "list-approvals": handleListApprovals,
  "get-approval": handleGetApproval,
  "get-approval-tasks": handleGetApprovalTasks,
  "list-approval-comments": handleListApprovalComments,
  "list-task-approvals": handleListTaskApprovals,
  "create-approval": handleCreateApproval,
  "approval-decision": handleApprovalDecision,
  "add-approval-comment": handleAddApprovalComment,
  "link-task-approval": handleLinkTaskApproval,
  "unlink-task-approval": handleUnlinkTaskApproval,
};
