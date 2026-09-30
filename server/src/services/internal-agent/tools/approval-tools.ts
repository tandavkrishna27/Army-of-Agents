// server/src/services/internal-agent/tools/approval-tools.ts
//
// B2 port — Approval-family oversight tools for Commander. Wraps the same
// approvalService + issueApprovalService the MCP surface uses, re-expressed
// over Commander's ToolContext (userRole + companyId; no team_lead authorization project set).
//
// SECURITY: every approval service method looks up by primary key WITHOUT a
// company filter, so each tool enforces row.companyId === ctx.companyId itself
// and returns NOT_FOUND on mismatch (never confirms a foreign approval exists).
//
// RBAC (R1): reads AND the decision all gate at founder (requiredRole).
// The MCP surface's per-project team_lead scoping is intentionally NOT
// replicated: Commander's ToolContext has no team_lead authorization project
// SET (contextScope.projectId is a UI hint, not an authz boundary), so
// company-wide lead visibility would widen authority. team_lead parity is R2
// behind a project-scope resolver — see plan §"RBAC divergence". Category:
// reads=query (no capability gate), decision=action (system_actions-gated +
// write ergonomics).
import { APPROVAL_STATUSES, APPROVAL_TYPES } from "@armyofagents/shared";
import { logActivity } from "../../activity-log.js";
import { hubItemsService } from "../../hub-items.js";
import { buildApprovalHubEmit, emitHubItem } from "../../hub-source-producers.js";
import type { AgentTool, ToolContext, ToolResult } from "../types.js";

const OPEN_HUB_STATUSES = new Set(["pending", "revision_requested"]);
const VALID_STATUS = new Set<string>(APPROVAL_STATUSES);
const VALID_TYPE = new Set<string>(APPROVAL_TYPES);

async function loadOwnedApproval(ctx: ToolContext, approvalId: string) {
  const row = await ctx.services.approvals.getById(approvalId);
  if (!row || (row as { companyId?: string }).companyId !== ctx.companyId) return null;
  return row as { id: string; companyId: string; status: string } & Record<string, unknown>;
}

async function syncApprovalHubItem(ctx: ToolContext, approval: { id: string; companyId: string; status: string }) {
  if (OPEN_HUB_STATUSES.has(approval.status)) {
    await emitHubItem(ctx.db, buildApprovalHubEmit(approval as any));
    return;
  }
  await hubItemsService(ctx.db).reconcile(approval.companyId, { sourceType: "approval", sourceId: approval.id });
}

const listApprovals: AgentTool = {
  name: "list_approvals",
  description:
    "List the company's approval requests (governance decisions awaiting a call), newest first. Optional filters: status (pending|approved|rejected|revision_requested|…), type. Use when asked what needs approval / what is waiting on the founder.",
  parameters: {
    type: "object",
    properties: {
      status: { type: "string", description: "Filter by approval status" },
      type: { type: "string", description: "Filter by approval type" },
    },
  },
  category: "query",
  requiredRole: "founder", // R1: founder-only — Commander has no team_lead authorization project set (see RBAC divergence). team_lead parity is R2.
  requiresConfirmation: false,
  async execute(params, ctx): Promise<ToolResult> {
    const { status, type } = (params ?? {}) as { status?: string; type?: string };
    const statusFilter = typeof status === "string" && VALID_STATUS.has(status) ? status : undefined;
    let rows = await ctx.services.approvals.list(ctx.companyId, statusFilter);
    if (typeof type === "string" && VALID_TYPE.has(type)) {
      rows = (Array.isArray(rows) ? rows : []).filter((r: any) => r.type === type);
    }
    const list = Array.isArray(rows) ? rows : [];
    return { success: true, data: list, summary: `Found ${list.length} approval${list.length === 1 ? "" : "s"}` };
  },
};

const getApproval: AgentTool = {
  name: "get_approval",
  description:
    "Read one approval by id: its type, status, payload, and requester. Use to inspect a specific pending decision before acting on it.",
  parameters: { type: "object", properties: { approvalId: { type: "string" } }, required: ["approvalId"] },
  category: "query",
  requiredRole: "founder", // R1: founder-only — Commander has no team_lead authorization project set (see RBAC divergence). team_lead parity is R2.
  requiresConfirmation: false,
  async execute(params, ctx): Promise<ToolResult> {
    const { approvalId } = (params ?? {}) as { approvalId?: string };
    if (!approvalId) return { success: false, data: null, summary: "approvalId is required", error: "INVALID_PARAMS" };
    const row = await loadOwnedApproval(ctx, approvalId);
    if (!row) return { success: false, data: null, summary: "Approval not found", error: "NOT_FOUND" };
    return { success: true, data: row, summary: `Approval ${row.id}: ${row.status}` };
  },
};

const getApprovalTasks: AgentTool = {
  name: "get_approval_tasks",
  description: "List the tasks an approval is gating (what unblocks if it is approved).",
  parameters: { type: "object", properties: { approvalId: { type: "string" } }, required: ["approvalId"] },
  category: "query",
  requiredRole: "founder", // R1: founder-only — Commander has no team_lead authorization project set (see RBAC divergence). team_lead parity is R2.
  requiresConfirmation: false,
  async execute(params, ctx): Promise<ToolResult> {
    const { approvalId } = (params ?? {}) as { approvalId?: string };
    if (!approvalId) return { success: false, data: null, summary: "approvalId is required", error: "INVALID_PARAMS" };
    const row = await loadOwnedApproval(ctx, approvalId);
    if (!row) return { success: false, data: null, summary: "Approval not found", error: "NOT_FOUND" };
    const rows = await ctx.services.issueApprovals.listIssuesForApproval(approvalId);
    const list = Array.isArray(rows) ? rows : [];
    return { success: true, data: list, summary: `${list.length} task${list.length === 1 ? "" : "s"} linked` };
  },
};

const listApprovalComments: AgentTool = {
  name: "list_approval_comments",
  description: "List the discussion/comments on an approval (context for the decision).",
  parameters: { type: "object", properties: { approvalId: { type: "string" } }, required: ["approvalId"] },
  category: "query",
  requiredRole: "founder", // R1: founder-only — Commander has no team_lead authorization project set (see RBAC divergence). team_lead parity is R2.
  requiresConfirmation: false,
  async execute(params, ctx): Promise<ToolResult> {
    const { approvalId } = (params ?? {}) as { approvalId?: string };
    if (!approvalId) return { success: false, data: null, summary: "approvalId is required", error: "INVALID_PARAMS" };
    const row = await loadOwnedApproval(ctx, approvalId);
    if (!row) return { success: false, data: null, summary: "Approval not found", error: "NOT_FOUND" };
    const comments = await ctx.services.approvals.listComments(approvalId);
    const list = Array.isArray(comments) ? comments : [];
    return { success: true, data: list, summary: `${list.length} comment${list.length === 1 ? "" : "s"}` };
  },
};

const approvalDecision: AgentTool = {
  name: "approval_decision",
  description:
    "Decide an approval: approve, reject, request revision, or resubmit. Founder-only, and always confirmed before it runs (irreversible governance action).",
  parameters: {
    type: "object",
    properties: {
      approvalId: { type: "string" },
      action: { type: "string", enum: ["approve", "reject", "requestRevision", "resubmit"] },
      decisionNote: { type: "string" },
    },
    required: ["approvalId", "action"],
  },
  category: "action",
  requiredRole: "founder",
  requiresConfirmation: true,
  async execute(params, ctx): Promise<ToolResult> {
    const { approvalId, action, decisionNote } = (params ?? {}) as {
      approvalId?: string; action?: string; decisionNote?: string;
    };
    if (!approvalId || !action) {
      return { success: false, data: null, summary: "approvalId and action are required", error: "INVALID_PARAMS" };
    }
    const approval = await loadOwnedApproval(ctx, approvalId);
    if (!approval) return { success: false, data: null, summary: "Approval not found", error: "NOT_FOUND" };
    const note = decisionNote ?? null;
    let updated: any;
    switch (action) {
      case "approve": updated = await ctx.services.approvals.approve(approvalId, ctx.companyId, ctx.userId, note); break;
      case "reject": updated = await ctx.services.approvals.reject(approvalId, ctx.companyId, ctx.userId, note); break;
      case "requestRevision": updated = await ctx.services.approvals.requestRevision(approvalId, ctx.companyId, ctx.userId, note); break;
      case "resubmit": updated = await ctx.services.approvals.resubmit(approvalId, ctx.companyId); break;
      default: return { success: false, data: null, summary: `Unknown action '${action}'`, error: "INVALID_PARAMS" };
    }
    if (!updated) return { success: false, data: null, summary: "Approval not found", error: "NOT_FOUND" };
    await logActivity(ctx.db, {
      companyId: ctx.companyId, actorType: "user", actorId: ctx.userId,
      action: `approval.${action}`, entityType: "approval", entityId: approvalId,
      details: { action, source: "commander" },
    });
    await syncApprovalHubItem(ctx, updated);
    return { success: true, data: updated, summary: `Approval ${action} → ${updated.status}` };
  },
};

export const approvalTools: AgentTool[] = [
  listApprovals, getApproval, getApprovalTasks, listApprovalComments, approvalDecision,
];
