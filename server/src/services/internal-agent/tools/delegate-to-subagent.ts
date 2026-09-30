import type { AgentTool } from "../types.js";

export const delegateToSubagentTool: AgentTool = {
  name: "delegate_to_subagent",
  description:
    "Delegate a task to a named AoA sub-agent by enqueuing a wakeup request. The sub-agent will be triggered asynchronously by the AoA dispatcher.",
  parameters: {
    type: "object",
    properties: {
      agentName: {
        type: "string",
        description:
          "The name of the AoA agent to delegate to (must be kind='aoa' in this company)",
      },
      instruction: {
        type: "string",
        description: "The instruction or task to delegate to the sub-agent",
      },
    },
    required: ["agentName", "instruction"],
  },
  category: "action",
  requiredRole: "founder",
  requiresConfirmation: true,
  execute: async (params: unknown, ctx) => {
    const { agentName, instruction } = (params ?? {}) as {
      agentName?: unknown;
      instruction?: unknown;
    };
    const agentNameStr = agentName as string;
    const instructionStr = instruction as string;

    const { agents, agentWakeupRequests } = await import("@armyofagents/db");
    const { and, eq } = await import("drizzle-orm");

    // Resolve target by name within company (kind='aoa' only)
    const [target] = await ctx.db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, ctx.companyId),
          eq(agents.kind, "aoa"),
          eq(agents.name, agentNameStr),
        ),
      );

    if (!target) {
      return {
        success: false,
        data: null,
        summary: `No AoA agent named '${agentNameStr}' found in this company`,
        error: "no such AoA agent",
      };
    }

    await ctx.db.insert(agentWakeupRequests).values({
      companyId: ctx.companyId,
      agentId: target.id,
      source: "aoa.delegate",
      reason: "commander_delegation",
      payload: { instruction: instructionStr },
      status: "queued",
    });

    return {
      success: true,
      data: { agentId: target.id },
      summary: `delegated`,
    };
  },
};
