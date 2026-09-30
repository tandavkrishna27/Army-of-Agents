// W7.5e — Task 1 (SC7): a GOVERNED Commander tool call over the broker returns
// the non-blocking ⚡CONFIRM marker and does NOT execute the tool.
//
// This is a HANDLER-LEVEL proof of the BROKER behavior. The broker's tools/call
// route (`mcp/server.ts:745-768`) builds `createToolCallHandler({ tools:
// brokerRegistry, executeTool, toolContext: brokerCtx })` where `brokerCtx`
// comes from `resolveCommanderBrokerToolContext(...)` (actorType:"commander")
// and calls `handleBrokerToolCall(name, args, ...)`. So exercising the SAME
// `createToolCallHandler` with the SAME commander `ToolContext` shape IS the
// broker path — the marker gate is achieved by REUSE, not reimplementation.
// (SC7 / INDEX: "do NOT reimplement it").
import { describe, it, expect, vi } from "vitest";
import { createToolCallHandler } from "../services/internal-agent/mcp-bridge.js";
import type { AgentTool, ToolContext } from "../services/internal-agent/types.js";

// A governed tool: `requiresConfirmation: true` → resolveCommanderToolPolicy
// sets requiresApproval=true for the commander actor → the marker path.
const governedTool: AgentTool = {
  name: "create_task",
  description: "Create a task",
  parameters: { type: "object", properties: {} },
  category: "action", // gated on the `system_actions` capability (granted below)
  requiresConfirmation: true,
  execute: vi.fn(async () => ({ success: true, data: {}, summary: "created" })),
};

// Mirrors the shape resolveCommanderBrokerToolContext returns over the broker:
// actorType:"commander", agentKind undefined (no allowlist gate), full commander
// policy fields. `system_actions` is enabled so the base gate admits the
// action-category tool and control reaches the runtime-approval branch.
function commanderCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    companyId: "c1",
    userId: "u1",
    userRole: "founder",
    enabledCapabilities: ["system_actions"],
    agentKind: undefined,
    toolAllowlist: [],
    actorType: "commander",
    conversationId: "conv1",
    runId: "run1",
    commanderToolPermissions: null,
    runtimeApprovalsEnabled: true,
    db: {} as never,
    services: {} as never,
    ...overrides,
  };
}

describe("commander broker approval marker (W7.5e / SC7)", () => {
  it("a governed commander tool call returns ⚡CONFIRM (isError:false), creates a pending approval, and does NOT execute", async () => {
    const runtimeApprovals = {
      findTrustedExact: vi.fn(async () => null), // no matching trust rule
      createPending: vi.fn(async () => ({ id: "confirm-1" })),
    };

    // The SAME handler the broker builds — no bespoke commander gate.
    const handle = createToolCallHandler({
      tools: [governedTool],
      executeTool: vi.fn() as never, // must not be reached on the marker path
      toolContext: commanderCtx(),
      runtimeApprovals: runtimeApprovals as never,
    });

    const result = await handle("create_task", {});

    // Non-blocking marker: isError:false, carries the confirmId.
    expect(result.isError).toBe(false);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("⚡CONFIRM:");
    expect(text).toContain("confirm-1");

    // A pending approval row was created (the confirm route later executes it
    // host-side — see internal-agent-confirm.test.ts).
    expect(runtimeApprovals.createPending).toHaveBeenCalledTimes(1);
    expect(runtimeApprovals.findTrustedExact).toHaveBeenCalledTimes(1);

    // The tool did NOT execute — it awaits approval.
    expect(governedTool.execute).not.toHaveBeenCalled();
  });
});
