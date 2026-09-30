import { describe, expect, it, vi } from "vitest";
import { createToolCallHandler } from "../services/internal-agent/mcp-bridge.js";
import type { AgentTool } from "../services/internal-agent/types.js";

function makeTool(name: string, requiresConfirmation: boolean): AgentTool {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {}, required: [] },
    category: "action",
    requiredRole: "team_member",
    requiresConfirmation,
    execute: async () => ({ success: true, data: { done: true }, summary: "done" }),
  };
}

const neverExecute = async () => ({ success: true, data: {}, summary: "" });

// Minimal valid ToolContext for testing the confirmation gate.
// userRole must be a recognised role string so the role enforcement gate
// (which runs before requiresConfirmation) does not block these calls.
// The tools created by makeTool() have category: "action", which requires the
// "system_actions" capability (see authorize-tool.ts CAPABILITY_TO_CATEGORY).
// Include it so the capability gate passes and requiresConfirmation is reached.
const baseCtx = {
  companyId: "co-1",
  userId: "user-1",
  userRole: "team_member",
  enabledCapabilities: ["system_actions"],
  actorType: "commander",
  runtimeApprovalsEnabled: true,
} as any;

describe("createToolCallHandler: requiresConfirmation gate", () => {
  it("executes tools with requiresConfirmation: false normally", async () => {
    const tool = makeTool("query_tasks", false);
    const executeSpy = vi.fn().mockResolvedValue({ success: true, data: { items: [] }, summary: "ok" });
    const handler = createToolCallHandler({
      tools: [tool],
      executeTool: executeSpy,
      toolContext: baseCtx,
    });
    const result = await handler("query_tasks", {});
    expect(result.isError).toBeFalsy();
    expect(executeSpy).toHaveBeenCalledOnce();
  });

  it("returns a durable CONFIRM marker for requiresConfirmation: true tools", async () => {
    const tool = makeTool("create_task", true);
    const executeSpy = vi.fn().mockResolvedValue({ success: true, data: {}, summary: "" });
    const createPending = vi.fn().mockResolvedValue({ id: "approval-1" });
    const handler = createToolCallHandler({
      tools: [tool],
      executeTool: executeSpy,
      toolContext: baseCtx,
      runtimeApprovals: {
        createPending,
        findTrustedExact: vi.fn().mockResolvedValue(null),
      },
    });

    const result = await handler("create_task", { title: "Test task" });

    expect(executeSpy).not.toHaveBeenCalled();
    expect(createPending).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "co-1",
      userId: "user-1",
      toolName: "create_task",
      params: { title: "Test task" },
    }));
    expect(result.content[0].text).toContain("CONFIRM:");
    expect(result.content[0].text).toContain("approval-1");
    expect(result.content[0].text).toContain("create_task");
    expect(result.isError).toBeFalsy();
  });

  it("includes params in the marker for display while persisting DB params as authority", async () => {
    const tool = makeTool("create_task", true);
    const createPending = vi.fn().mockResolvedValue({ id: "approval-2" });
    const handler = createToolCallHandler({
      tools: [tool],
      executeTool: neverExecute,
      toolContext: baseCtx,
      runtimeApprovals: {
        createPending,
        findTrustedExact: vi.fn().mockResolvedValue(null),
      },
    });
    const params = { title: "Sprint planning task", priority: "high" };

    const result = await handler("create_task", params);

    expect(result.content[0].text).toContain(JSON.stringify(params));
    expect(createPending).toHaveBeenCalledWith(expect.objectContaining({ params }));
  });

  it("forced confirmation setting creates a durable approval for a normally safe tool", async () => {
    const tool = makeTool("query_tasks", false);
    const executeSpy = vi.fn().mockResolvedValue({ success: true, data: {}, summary: "" });
    const createPending = vi.fn().mockResolvedValue({ id: "approval-3" });
    const handler = createToolCallHandler({
      tools: [tool],
      executeTool: executeSpy,
      toolContext: {
        ...baseCtx,
        commanderToolPermissions: {
          query_tasks: {
            enabled: true,
            requireConfirmation: true,
            minimumRole: "team_member",
          },
        },
      },
      runtimeApprovals: {
        createPending,
        findTrustedExact: vi.fn().mockResolvedValue(null),
      },
    });

    const result = await handler("query_tasks", {});

    expect(executeSpy).not.toHaveBeenCalled();
    expect(createPending).toHaveBeenCalledOnce();
    expect(result.content[0].text).toContain("approval-3");
  });

  it("executes without a marker when an exact trust rule exists", async () => {
    const tool = makeTool("create_task", true);
    const executeSpy = vi.fn().mockResolvedValue({ success: true, data: {}, summary: "trusted" });
    const createPending = vi.fn();
    const handler = createToolCallHandler({
      tools: [tool],
      executeTool: executeSpy,
      toolContext: baseCtx,
      runtimeApprovals: {
        createPending,
        findTrustedExact: vi.fn().mockResolvedValue({ id: "trust-1" }),
      },
    });

    const result = await handler("create_task", { title: "Trusted" });

    expect(createPending).not.toHaveBeenCalled();
    expect(executeSpy).toHaveBeenCalledOnce();
    expect(result.content[0].text).toContain("trusted");
  });
});
