import type { AgentTool } from "../types.js";
import type { ThreadPhase } from "@armyofagents/shared";
import { buildAdvancePhaseIdempotencyKey } from "./thread-action-keys.js";

export function createAdvancePhaseTool(): AgentTool {
  return {
    name: "advance_phase",
    description: "Advance a thread to the next phase. Requires autonomy level ≥ 2.",
    parameters: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "The discussion/thread ID" },
        toPhase: {
          type: "string",
          description: "Target phase: discuss | scope | assign | done",
        },
      },
      required: ["threadId", "toPhase"],
    },
    category: "action",
    requiredRole: "team_member",
    requiresConfirmation: false,
    execute: async (params: unknown, ctx) => {
      const { threadId, toPhase } = (params ?? {}) as Record<string, unknown>;

      // Autonomy gate — fail-closed: absent or < 2 → reject
      if ((ctx.effectiveAutonomy ?? 0) < 2) {
        return {
          success: false,
          data: null,
          summary: "advance_phase requires autonomy level ≥ 2",
          error: "AUTONOMY_INSUFFICIENT",
        };
      }

      if (ctx.discussionRunMode === "controller_action_gate") {
        if (!ctx.runId) {
          return {
            success: false,
            data: null,
            summary: "Cannot queue phase advance without a run id",
            error: "MISSING_RUN_ID",
          };
        }

        const { threadAgentActionService } = await import("../../thread-agent-actions.js");
        const action = await threadAgentActionService(ctx.db).proposeThreadAction({
          companyId: ctx.companyId,
          threadId: threadId as string,
          runId: ctx.runId,
          agentId: ctx.agentId ?? null,
          actionType: "advance_phase",
          payload: {
            toPhase: toPhase as string,
            effectiveAutonomy: ctx.effectiveAutonomy ?? 0,
          },
          idempotencyKey: buildAdvancePhaseIdempotencyKey({
            threadId: threadId as string,
            agentId: ctx.agentId,
            toPhase: toPhase as string,
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
          summary: "Queued phase advance for freshness-checked commit",
        };
      }

      const actor = {
        userId: ctx.agentId ?? "aoa-agent",
        role: "team_member" as const,
        isHuman: false,
      };

      await ctx.services.threads.advancePhase(
        ctx.companyId,
        threadId as string,
        toPhase as ThreadPhase,
        actor,
      );

      return {
        success: true,
        data: { phase: toPhase },
        summary: `Thread advanced to phase: ${toPhase}`,
      };
    },
  };
}
