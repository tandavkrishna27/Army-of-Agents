import { describe, expect, it, vi } from "vitest";
import { createToolCallHandler } from "../services/internal-agent/mcp-bridge.js";
import type { AgentTool } from "../services/internal-agent/types.js";

function makeTool(name: string): AgentTool {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {}, required: [] },
    category: "query",
    requiredRole: "team_member",
    requiresConfirmation: false,
    execute: async () => ({ success: true, data: { done: true }, summary: "done" }),
  };
}

describe("P2.0: ToolContext extension (agentId, effectiveAutonomy)", () => {
  it("passes agentId and effectiveAutonomy through toolContext to tool.execute", async () => {
    const tool = makeTool("test_agent_context");
    const executeSpy = vi.fn().mockResolvedValue({ success: true, data: {}, summary: "ok" });

    const toolContext = {
      userRole: "team_member",
      enabledCapabilities: [],
      agentId: "agent-123",
      effectiveAutonomy: 2,
    } as any;

    const handler = createToolCallHandler({
      tools: [tool],
      executeTool: executeSpy,
      toolContext,
    });

    await handler("test_agent_context", {});

    expect(executeSpy).toHaveBeenCalledOnce();
    const callArgs = executeSpy.mock.calls[0];
    const contextArg = callArgs[2]; // 3rd argument is ctx

    expect(contextArg.agentId).toBe("agent-123");
    expect(contextArg.effectiveAutonomy).toBe(2);
  });

  it("passes undefined agentId and null effectiveAutonomy when not present in toolContext", async () => {
    const tool = makeTool("test_agent_context");
    const executeSpy = vi.fn().mockResolvedValue({ success: true, data: {}, summary: "ok" });

    const toolContext = {
      userRole: "team_member",
      enabledCapabilities: [],
    } as any;

    const handler = createToolCallHandler({
      tools: [tool],
      executeTool: executeSpy,
      toolContext,
    });

    await handler("test_agent_context", {});

    expect(executeSpy).toHaveBeenCalledOnce();
    const callArgs = executeSpy.mock.calls[0];
    const contextArg = callArgs[2]; // 3rd argument is ctx

    expect(contextArg.agentId).toBeUndefined();
    expect(contextArg.effectiveAutonomy).toBeUndefined();
  });
});
