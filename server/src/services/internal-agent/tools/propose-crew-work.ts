// server/src/services/internal-agent/tools/propose-crew-work.ts
//
// Task 2.4 — `propose_crew_work` (action tool, Adjutant-only via allowlist D2).
//
// The single chokepoint through which the Adjutant turns a converged discussion
// into crew work. Resolves thread autonomy (from ctx.effectiveAutonomy, which
// the runner already computed from thread.autonomyLevel ?? company.autonomyLevel)
// and routes through crewTaskService.proposeWork — the unified D11 gate.
//
// Role → agentId resolution: crew agents are identified by `agents.name` (unique
// per company). The mapping is: assigneeRole (e.g. "engineer") → agent name
// (e.g. "Engineer"). Unknown roles resolve to undefined → task created
// unassigned. lookup is company-scoped (kind='aoa').

import type { AgentTool } from "../types.js";
import { buildScopeDraftIdempotencyKey } from "./thread-action-keys.js";
import { resolveRoleToAgentId } from "./crew-role-map.js";

// ── Tool definition ──────────────────────────────────────────────────────────

export const proposeCrewWorkTool: AgentTool = {
  name: "propose_crew_work",
  description:
    "Propose crew work for this thread. Resolves the effective autonomy (thread or company level) and routes through the unified D11 chokepoint. At autonomy L1 the scope card is written and awaits human approval; at L2 the card is written and immediately auto-approved, dispatching the assigned agents.",
  parameters: {
    type: "object",
    properties: {
      threadId: {
        type: "string",
        description: "The thread (discussion) ID for which work is being proposed",
      },
      summary: {
        type: "string",
        description: "Plain-text summary of the proposed work scope",
      },
      proposedTasks: {
        type: "array",
        description:
          "Ordered list of tasks to propose. Each task must have a title and may optionally carry an assigneeRole (e.g. 'engineer', 'scout', 'planner') to assign it to the matching crew agent.",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "Task title" },
            assigneeRole: {
              type: "string",
              description:
                "Crew role to assign the task to (engineer, scout, planner, navigator, memory_keeper, adjutant). Omit to leave unassigned.",
            },
          },
          required: ["title"],
        },
      },
    },
    required: ["threadId", "summary", "proposedTasks"],
  },
  category: "action",
  requiredRole: "team_member",
  requiresConfirmation: false,

  async execute(params, ctx) {
    const { threadId, summary, proposedTasks } = (params ?? {}) as {
      threadId?: string;
      summary?: string;
      proposedTasks?: Array<{ title?: string; assigneeRole?: string }>;
    };

    // ── Param validation ─────────────────────────────────────────────────────
    if (!threadId || typeof threadId !== "string" || threadId.trim().length === 0) {
      return {
        success: false,
        data: null,
        summary: "threadId is required",
        error: "INVALID_PARAMS",
      };
    }
    if (!summary || typeof summary !== "string" || summary.trim().length === 0) {
      return {
        success: false,
        data: null,
        summary: "summary is required",
        error: "INVALID_PARAMS",
      };
    }
    if (!Array.isArray(proposedTasks) || proposedTasks.length === 0) {
      return {
        success: false,
        data: null,
        summary: "proposedTasks must be a non-empty array",
        error: "INVALID_PARAMS",
      };
    }
    for (const task of proposedTasks) {
      if (!task.title || typeof task.title !== "string" || task.title.trim().length === 0) {
        return {
          success: false,
          data: null,
          summary: "Each proposed task must have a non-empty title",
          error: "INVALID_PARAMS",
        };
      }
    }

    // ── Resolve effectiveAutonomy ────────────────────────────────────────────
    // ctx.effectiveAutonomy is populated by the runner (controller-adjutant-runner
    // and dispatcher both compute thread.autonomyLevel ?? company.autonomyLevel
    // before calling runAoaAgent, which sets it in mcpParams). Prefer this value;
    // fall back to 0 (fail-closed) when absent so the gate never silently opens.
    if (ctx.discussionRunMode === "controller_action_gate") {
      if (!ctx.runId) {
        return {
          success: false,
          data: null,
          summary: "Cannot queue scope draft without a run id",
          error: "MISSING_RUN_ID",
        };
      }

      const { threadAgentActionService } = await import("../../thread-agent-actions.js");
      const action = await threadAgentActionService(ctx.db).proposeThreadAction({
        companyId: ctx.companyId,
        threadId,
        runId: ctx.runId,
        agentId: ctx.agentId ?? null,
        actionType: "create_scope_draft",
        payload: {
          summary,
          proposedTasks: proposedTasks.map((task) => ({
            title: task.title as string,
            ...(task.assigneeRole ? { assigneeRole: task.assigneeRole } : {}),
          })),
        },
        idempotencyKey: buildScopeDraftIdempotencyKey({
          threadId,
          agentId: ctx.agentId,
          summary,
          proposedTasks,
          // Turn anchor: latest human entry seq at run start (null → content-only). #198.
          turnAnchor:
            ctx.threadFreshness?.latestHumanSeq != null
              ? String(ctx.threadFreshness.latestHumanSeq)
              : null,
        }),
        freshness: ctx.threadFreshness ?? {},
      }) as { id?: string };

      return {
        success: true,
        data: { actionId: action.id, queued: true },
        summary: "Queued versioned scope draft for freshness-checked commit",
      };
    }

    const effectiveAutonomy: number =
      typeof ctx.effectiveAutonomy === "number" ? ctx.effectiveAutonomy : 0;

    // ── Resolve assigneeRole → assigneeAgentId for each task ─────────────────
    // Unknown roles or missing roles leave assigneeAgentId undefined (unassigned).
    const resolvedTasks: Array<{ title: string; assigneeAgentId?: string }> = [];
    for (const task of proposedTasks) {
      const assigneeAgentId =
        task.assigneeRole
          ? await resolveRoleToAgentId(ctx.db as any, ctx.companyId, task.assigneeRole)
          : undefined;

      resolvedTasks.push({
        title: task.title as string,
        ...(assigneeAgentId !== undefined ? { assigneeAgentId } : {}),
      });
    }

    // ── Call the unified chokepoint ──────────────────────────────────────────
    // Dynamic import defers the crew-task-service → heartbeat → execution-workspaces
    // → git → execFile chain until execute() is actually called. This keeps the
    // tool module-load light so test suites that partially mock node:child_process
    // don't fail at collection time.
    try {
      const { crewTaskService } = await import("../../crew-task-service.js");
      const result = await crewTaskService(ctx.db).proposeWork({
        threadId,
        companyId: ctx.companyId,
        autonomy: effectiveAutonomy,
        summary,
        proposedTasks: resolvedTasks,
        createdBy: { agentId: ctx.agentId ?? null },
      });

      if (result.existing) {
        return {
          success: true,
          data: {
            proposalId: result.proposalId,
            autoApproved: false,
            createdIssueIds: undefined,
            existing: true,
          },
          summary: `Scope proposal already pending (returned existing proposal ${result.proposalId})`,
        };
      }

      if (result.autoApproved) {
        const n = result.createdIssueIds?.length ?? 0;
        return {
          success: true,
          data: {
            proposalId: result.proposalId,
            autoApproved: true,
            createdIssueIds: result.createdIssueIds,
          },
          summary: `Proposed ${n} task${n !== 1 ? "s" : ""} (auto-approved at autonomy L${effectiveAutonomy})`,
        };
      }

      if (result.blockedReason) {
        return {
          success: true,
          data: {
            proposalId: result.proposalId,
            autoApproved: false,
            createdIssueIds: undefined,
            blockedReason: result.blockedReason,
          },
          summary: `Posted scope proposal for ${proposedTasks.length} task${proposedTasks.length !== 1 ? "s" : ""} — dispatch blocked (${result.blockedReason}), awaiting human approval`,
        };
      }

      return {
        success: true,
        data: {
          proposalId: result.proposalId,
          autoApproved: false,
          createdIssueIds: undefined,
        },
        summary: `Posted scope proposal for ${proposedTasks.length} task${proposedTasks.length !== 1 ? "s" : ""} — awaiting human approval`,
      };
    } catch (err: any) {
      return {
        success: false,
        data: null,
        summary: `Failed to propose crew work: ${err?.message ?? "unknown error"}`,
        error: err?.message?.includes("COMPANY_MISMATCH")
          ? "COMPANY_MISMATCH"
          : "PROPOSE_FAILED",
      };
    }
  },
};
