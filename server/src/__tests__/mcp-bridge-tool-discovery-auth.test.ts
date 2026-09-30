import { describe, expect, it } from "vitest";
import {
  createToolCallHandler,
  filterAuthorizedToolsForContext,
} from "../services/internal-agent/mcp-bridge.js";
import { executeTool } from "../services/internal-agent/tool-registry.js";
import type { AgentTool, ToolContext } from "../services/internal-agent/types.js";

function makeTool(overrides: Partial<AgentTool>): AgentTool {
  return {
    name: "query_tasks",
    description: "A test tool",
    parameters: { type: "object", properties: {} },
    category: "query",
    requiresConfirmation: false,
    execute: async () => ({ success: true, data: null, summary: "ok" }),
    ...overrides,
  };
}

function makeCtx(overrides: Partial<ToolContext>): ToolContext {
  return {
    companyId: "c1",
    userId: "u1",
    userRole: "founder",
    enabledCapabilities: [],
    agentKind: undefined,
    toolAllowlist: [],
    actorType: "commander",
    db: {} as any,
    services: {} as any,
    ...overrides,
  };
}

describe("MCP bridge tool discovery authorization", () => {
  it("hides tools denied by AoA allowlist, role, or missing capability", () => {
    const visibleQuery = makeTool({ name: "query_tasks", category: "query" });
    const deniedByAllowlist = makeTool({ name: "delegate_to_subagent", category: "action" });
    const deniedByRole = makeTool({ name: "founder_action", category: "query", requiredRole: "founder" });
    const deniedByCapability = makeTool({ name: "create_task", category: "action" });

    const visible = filterAuthorizedToolsForContext(
      [visibleQuery, deniedByAllowlist, deniedByRole, deniedByCapability],
      makeCtx({
        userRole: "team_member",
        enabledCapabilities: [],
        agentKind: "aoa",
        toolAllowlist: ["query_tasks", "founder_action", "create_task"],
      }),
    );

    expect(visible.map((tool) => tool.name)).toEqual(["query_tasks"]);
  });

  it("still denies direct tools/call when a caller names a hidden tool", async () => {
    const hiddenTool = makeTool({
      name: "delegate_to_subagent",
      category: "action",
    });
    const ctx = makeCtx({
      userRole: "founder",
      enabledCapabilities: ["system_actions"],
      agentKind: "aoa",
      toolAllowlist: [],
    });
    const handler = createToolCallHandler({
      tools: [hiddenTool],
      executeTool,
      toolContext: ctx,
    });

    const result = await handler("delegate_to_subagent", {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("NOT_IN_ALLOWLIST");
  });

  it("denies hidden confirmation-gated tools before returning a confirmation marker", async () => {
    const hiddenTool = makeTool({
      name: "delegate_to_subagent",
      category: "action",
      requiresConfirmation: true,
    });
    const ctx = makeCtx({
      userRole: "founder",
      enabledCapabilities: ["system_actions"],
      agentKind: "aoa",
      toolAllowlist: [],
    });
    const handler = createToolCallHandler({
      tools: [hiddenTool],
      executeTool,
      toolContext: ctx,
    });

    const result = await handler("delegate_to_subagent", {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("NOT_IN_ALLOWLIST");
    expect(result.content[0].text).not.toContain("CONFIRM");
  });
});
