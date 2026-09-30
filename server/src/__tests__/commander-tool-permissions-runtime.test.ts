import { describe, expect, it, vi } from "vitest";
import {
  resolveCommanderToolPolicy,
} from "../services/internal-agent/authorize-tool.js";
import {
  executeTool,
  filterAuthorizedToolsForContext,
} from "../services/internal-agent/tool-registry.js";
import { createActionTools } from "../services/internal-agent/tools/action-tools.js";
import type { AgentTool, ToolContext } from "../services/internal-agent/types.js";

function fakeTool(overrides: Partial<AgentTool> = {}): AgentTool {
  return {
    name: "fake_tool",
    description: "Fake tool",
    parameters: { type: "object", properties: {} },
    category: "query",
    requiredRole: "team_member",
    requiresConfirmation: false,
    execute: vi.fn(async () => ({ success: true, data: null, summary: "ok" })),
    ...overrides,
  };
}

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    companyId: "co-1",
    userId: "user-1",
    userRole: "team_lead",
    enabledCapabilities: ["system_actions", "discussion_processing", "memory_management"],
    db: {} as any,
    services: {} as any,
    actorType: "commander",
    runtimeApprovalsEnabled: true,
    commanderToolPermissions: {},
    ...overrides,
  };
}

describe("resolveCommanderToolPolicy", () => {
  it("blocks enabled=false even when base auth allows the tool", () => {
    const policy = resolveCommanderToolPolicy(fakeTool(), ctx({
      commanderToolPermissions: {
        fake_tool: {
          enabled: false,
          requireConfirmation: false,
          minimumRole: "team_member",
        },
      },
    }));

    expect(policy.allowed).toBe(false);
    expect(policy.error).toBe("TOOL_DISABLED");
  });

  it("forced requireConfirmation=true makes a safe query require approval", () => {
    const policy = resolveCommanderToolPolicy(fakeTool({
      requiresConfirmation: false,
    }), ctx({
      commanderToolPermissions: {
        fake_tool: {
          enabled: true,
          requireConfirmation: true,
          minimumRole: "team_member",
        },
      },
    }));

    expect(policy.allowed).toBe(true);
    expect(policy.requiresApproval).toBe(true);
  });

  it("minimumRole=founder blocks a team lead", () => {
    const policy = resolveCommanderToolPolicy(fakeTool(), ctx({
      userRole: "team_lead",
      commanderToolPermissions: {
        fake_tool: {
          enabled: true,
          requireConfirmation: false,
          minimumRole: "founder",
        },
      },
    }));

    expect(policy.allowed).toBe(false);
    expect(policy.error).toBe("FORBIDDEN_ROLE");
  });

  it("does not weaken a tool requiredRole with a lower override", () => {
    const policy = resolveCommanderToolPolicy(fakeTool({
      requiredRole: "founder",
    }), ctx({
      userRole: "team_member",
      commanderToolPermissions: {
        fake_tool: {
          enabled: true,
          requireConfirmation: false,
          minimumRole: "team_member",
        },
      },
    }));

    expect(policy.allowed).toBe(false);
    expect(policy.error).toBe("FORBIDDEN_ROLE");
  });

  it("uses defaults when an override is missing", () => {
    const policy = resolveCommanderToolPolicy(fakeTool(), ctx());

    expect(policy.allowed).toBe(true);
    expect(policy.enabled).toBe(true);
    expect(policy.minimumRole).toBe("team_member");
    expect(policy.requiresApproval).toBe(false);
  });

  it("runtimeApprovalsEnabled=false skips approval but not role gates", () => {
    const safePolicy = resolveCommanderToolPolicy(fakeTool({
      requiresConfirmation: true,
    }), ctx({ runtimeApprovalsEnabled: false }));
    const blockedPolicy = resolveCommanderToolPolicy(fakeTool({
      requiredRole: "founder",
      requiresConfirmation: true,
    }), ctx({ userRole: "team_member", runtimeApprovalsEnabled: false }));

    expect(safePolicy.allowed).toBe(true);
    expect(safePolicy.requiresApproval).toBe(false);
    expect(blockedPolicy.allowed).toBe(false);
    expect(blockedPolicy.error).toBe("FORBIDDEN_ROLE");
  });

  it("blocks team members from invoking update_task because it can change responsible human ownership", () => {
    const updateTask = createActionTools().find((tool) => tool.name === "update_task")!;

    const policy = resolveCommanderToolPolicy(updateTask, ctx({ userRole: "team_member" }));

    expect(policy.allowed).toBe(false);
    expect(policy.error).toBe("FORBIDDEN_ROLE");
  });
});

describe("executeTool Commander policy enforcement", () => {
  it("omits disabled Commander tools from advertised tool lists", () => {
    const visible = fakeTool({ name: "query_tasks" });
    const disabled = fakeTool({ name: "create_task" });

    const filtered = filterAuthorizedToolsForContext([visible, disabled], ctx({
      commanderToolPermissions: {
        create_task: {
          enabled: false,
          requireConfirmation: true,
          minimumRole: "team_member",
        },
      },
    }));

    expect(filtered.map((tool) => tool.name)).toEqual(["query_tasks"]);
  });

  it("blocks disabled Commander tools before execution", async () => {
    const tool = fakeTool();
    const result = await executeTool(tool, {}, ctx({
      commanderToolPermissions: {
        fake_tool: {
          enabled: false,
          requireConfirmation: false,
          minimumRole: "team_member",
        },
      },
    }));

    expect(result.success).toBe(false);
    expect(result.error).toBe("TOOL_DISABLED");
    expect(tool.execute).not.toHaveBeenCalled();
  });
});
