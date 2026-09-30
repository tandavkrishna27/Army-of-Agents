// W7.5e — Task 2 (SC7): trust-rule short-circuit over the broker. A governed
// tool WITH a matching `findTrustedExact` trust rule (an earlier `allow_always`
// decision) executes directly — NO ⚡CONFIRM marker, NO new pending approval.
//
// This proves `allow_always` parity over the broker: an already-trusted action
// does NOT re-prompt. It exercises the SAME `createToolCallHandler` +
// `resolveCommanderToolPolicy` path the in-process bridge uses (SC7), so there
// is no drift between the cloud/broker and desktop/stdio approval behavior.
import { describe, it, expect, vi } from "vitest";
import { createToolCallHandler } from "../services/internal-agent/mcp-bridge.js";
import type { AgentTool, ToolContext } from "../services/internal-agent/types.js";

const governedTool: AgentTool = {
  name: "create_task",
  description: "Create a task",
  parameters: { type: "object", properties: {} },
  category: "action",
  requiresConfirmation: true,
  execute: vi.fn(async () => ({ success: true, data: { id: "t1" }, summary: "created" })),
};

const ctx: ToolContext = {
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
};

describe("commander broker trust-rule short-circuit (W7.5e / SC7)", () => {
  it("an exact trust rule executes the tool without a ⚡CONFIRM marker and without creating a pending approval", async () => {
    const runtimeApprovals = {
      findTrustedExact: vi.fn(async () => ({ id: "rule-1" })), // exact match
      createPending: vi.fn(),
    };
    // Mirrors the real executeTool contract: delegate to the tool's execute.
    const executeTool = vi.fn(
      async (tool: AgentTool, args: unknown, c: ToolContext) => tool.execute(args, c),
    );

    const handle = createToolCallHandler({
      tools: [governedTool],
      executeTool: executeTool as never,
      toolContext: ctx,
      runtimeApprovals: runtimeApprovals as never,
    });

    const result = await handle("create_task", {});

    // No marker — the trusted action ran directly.
    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toContain("⚡CONFIRM:");
    expect(result.isError).toBe(false);

    // The trust rule was consulted; no new pending approval was minted.
    expect(runtimeApprovals.findTrustedExact).toHaveBeenCalledTimes(1);
    expect(runtimeApprovals.createPending).not.toHaveBeenCalled();

    // The tool executed under the trust rule (allow_always parity).
    expect(governedTool.execute).toHaveBeenCalledTimes(1);
  });
});
