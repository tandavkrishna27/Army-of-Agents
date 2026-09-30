import { describe, expect, it } from "vitest";
import { createToolCallHandler } from "../services/internal-agent/mcp-bridge.js";
import { filterAuthorizedToolsForContext } from "../services/internal-agent/tool-registry.js";
import type { AgentTool, ToolContext } from "../services/internal-agent/types.js";

function makeTool(overrides: Partial<AgentTool>): AgentTool {
  return {
    name: "test_tool",
    description: "A test tool",
    parameters: { type: "object", properties: {} },
    category: "query",
    requiresConfirmation: false,
    execute: async () => ({ success: true, data: null, summary: "ok" }),
    ...overrides,
  };
}

function makeCtx(userRole: string): ToolContext {
  return {
    companyId: "c1",
    userId: "u1",
    userRole,
    enabledCapabilities: [],
    agentKind: undefined,
    toolAllowlist: [],
    db: {} as any,
    services: {} as any,
  };
}

describe("createToolCallHandler — requiredRole", () => {
  it("executes normally when no requiredRole set", async () => {
    const tool = makeTool({ name: "open_tool" });
    const handler = createToolCallHandler({
      tools: [tool],
      executeTool: async () => ({ success: true, data: null, summary: "done" }),
      toolContext: makeCtx("team_member"),
    });
    const result = await handler("open_tool", {});
    expect(result.isError).toBe(false);
  });

  it("blocks team_member from founder-only tool", async () => {
    const tool = makeTool({ name: "founder_tool", requiredRole: "founder" });
    const handler = createToolCallHandler({
      tools: [tool],
      executeTool: async () => ({ success: true, data: null, summary: "done" }),
      toolContext: makeCtx("team_member"),
    });
    const result = await handler("founder_tool", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("founder");
  });

  it("blocks team_member from team_lead-only tool", async () => {
    const tool = makeTool({ name: "lead_tool", requiredRole: "team_lead" });
    const handler = createToolCallHandler({
      tools: [tool],
      executeTool: async () => ({ success: true, data: null, summary: "done" }),
      toolContext: makeCtx("team_member"),
    });
    const result = await handler("lead_tool", {});
    expect(result.isError).toBe(true);
  });

  it("allows team_lead to use team_lead tool", async () => {
    const tool = makeTool({ name: "lead_tool", requiredRole: "team_lead" });
    const handler = createToolCallHandler({
      tools: [tool],
      executeTool: async () => ({ success: true, data: null, summary: "done" }),
      toolContext: makeCtx("team_lead"),
    });
    const result = await handler("lead_tool", {});
    expect(result.isError).toBe(false);
  });

  it("allows founder to use any role-gated tool", async () => {
    const tool = makeTool({ name: "founder_tool", requiredRole: "founder" });
    const handler = createToolCallHandler({
      tools: [tool],
      executeTool: async () => ({ success: true, data: null, summary: "done" }),
      toolContext: makeCtx("founder"),
    });
    const result = await handler("founder_tool", {});
    expect(result.isError).toBe(false);
  });

  it("treats unknown role as lowest level — blocked from team_lead tool", async () => {
    const tool = makeTool({ name: "lead_tool", requiredRole: "team_lead" });
    const handler = createToolCallHandler({
      tools: [tool],
      executeTool: async () => ({ success: true, data: null, summary: "done" }),
      toolContext: makeCtx("unknown_role"),
    });
    const result = await handler("lead_tool", {});
    expect(result.isError).toBe(true);
  });

  it("allows equal role (team_lead accessing team_lead-required tool)", async () => {
    const tool = makeTool({ name: "lead_tool_2", requiredRole: "team_lead" });
    const handler = createToolCallHandler({
      tools: [tool],
      executeTool: async () => ({ success: true, data: null, summary: "done" }),
      toolContext: makeCtx("team_lead"),
    });
    const result = await handler("lead_tool_2", {});
    expect(result.isError).toBe(false);
  });

  it("blocks capability-gated tools before returning confirmation markers", async () => {
    const tool = makeTool({
      name: "wake_agent",
      category: "action",
      requiresConfirmation: true,
    });
    const handler = createToolCallHandler({
      tools: [tool],
      executeTool: async () => ({ success: true, data: null, summary: "done" }),
      toolContext: makeCtx("founder"),
    });
    const result = await handler("wake_agent", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("requires capability");
    expect(result.content[0].text).not.toContain("CONFIRM");
  });

  it("filters tools/list visibility through role, capability, and AoA allowlist gates", () => {
    const tools = [
      makeTool({ name: "query_tasks", category: "query" }),
      makeTool({ name: "wake_agent", category: "action", requiredRole: "founder" }),
      makeTool({ name: "founder_report", category: "query", requiredRole: "founder" }),
    ];

    const visible = filterAuthorizedToolsForContext(tools, {
      userRole: "founder",
      enabledCapabilities: ["system_actions"],
      agentKind: "aoa",
      toolAllowlist: ["query_tasks", "wake_agent"],
    });

    expect(visible.map((tool) => tool.name)).toEqual(["query_tasks", "wake_agent"]);
  });
});
