import { askHumanForActiveRun } from "../../../mcp/tools/ask-founder-tool.js";
import type { AgentTool, ToolResult } from "../types.js";

export const askHumanTool: AgentTool = {
  name: "ask_human",
  description:
    "Ask the responsible human a durable task question. The same question appears in Commander, Inbox, Task Work, Workspace, and the source Discussion. The run waits briefly, then parks cleanly and continues once answered.",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "The concrete decision or information needed" },
      context: { type: "string", description: "Why the answer is needed and what is blocked" },
      options: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            value: { type: "string" },
            description: { type: "string" },
            rationale: { type: "string" },
          },
          required: ["label", "value"],
        },
      },
    },
    required: ["question"],
  },
  category: "coordination",
  requiredRole: "team_member",
  requiresConfirmation: false,
  async execute(params, ctx): Promise<ToolResult> {
    if (
      ctx.actorType !== "agent"
      || (ctx.agentKind !== "org" && ctx.agentKind !== "aoa")
      || !ctx.agentId
      || !ctx.runId
    ) {
      return {
        success: false,
        data: null,
        summary: "ask_human requires an active organization-agent task run",
        error: "FORBIDDEN",
      };
    }
    try {
      const data = await askHumanForActiveRun(
        {
          db: ctx.db,
          companyId: ctx.companyId,
          agentId: ctx.agentId,
          runId: ctx.runId,
          originatingRunKind: ctx.agentKind === "aoa" ? "internal_agent" : "heartbeat",
          producerInvocationId: ctx.producerInvocationId ?? undefined,
          humanQuestionCapabilities: ctx.humanQuestionCapabilities,
        },
        (params ?? {}) as Record<string, unknown>,
      );
      return {
        success: true,
        data,
        summary: data.answered ? "Human answered the work question" : "Work parked while waiting for a human answer",
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        summary: error instanceof Error ? error.message : "Unable to ask the human question",
        error: "ASK_HUMAN_FAILED",
      };
    }
  },
};

export const askFounderCompatibilityTool: AgentTool = {
  ...askHumanTool,
  name: "ask_founder",
  description: "Compatibility alias for ask_human. Recipient routing still follows the task's responsible human and reviewer.",
};
