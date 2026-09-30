// server/src/services/internal-agent/__tests__/mcp-bridge-crew-policy.test.ts
//
// T8 Defect B — the bridge tool-call gate must mirror the tools/list gate:
// resolveCommanderToolPolicy (Commander permissions + runtime-approval layer)
// applies ONLY to `actorType === "commander"`; every other actor (crew 'aoa',
// org) falls back to authorizeToolInvocation (allowlist + role + capability).
// See tool-registry.ts filterAuthorizedToolsForContext for the listing gate.
//
// Crew has NO confirm route (the ⚡CONFIRM approval loop is Commander's SSE
// route only). Applying the Commander runtime-approval layer to a crew tool
// emits a CONFIRM marker nothing can resolve → the tool never runs. Dropping
// that layer for crew keeps the base gate (allowlist/role/capability) intact.
import { describe, it, expect, vi } from "vitest";
import { createToolCallHandler } from "../mcp-bridge.js";
import type { AgentTool, ToolContext } from "../types.js";

function makeTool(overrides: Partial<AgentTool>): AgentTool {
  return {
    name: "tool",
    description: "a tool",
    parameters: { type: "object", properties: {} },
    // "query" avoids the capability gate; the discriminator is the
    // requiresConfirmation → runtime-approval layer, not a capability.
    category: "query",
    requiredRole: "team_member",
    requiresConfirmation: false,
    execute: async () => ({ success: true, data: null, summary: "ok" }),
    ...overrides,
  } as AgentTool;
}

const CREW_CTX = {
  companyId: "co-1",
  userId: "aoa-subagent",
  userRole: "founder",
  enabledCapabilities: ["system_actions"],
  actorType: "agent",
  agentKind: "aoa",
  toolAllowlist: ["crew_write"],
  // runtimeApprovalsEnabled:true is the trap — under the OLD (buggy) code this
  // would push a requiresConfirmation crew tool onto the approval path. The fix
  // means crew never reaches resolveCommanderToolPolicy at all.
  runtimeApprovalsEnabled: true,
  runId: "run-1",
  agentId: "a-1",
  db: {} as any,
  services: {} as any,
} as unknown as ToolContext;

describe("mcp-bridge crew tool-call gate (Defect B)", () => {
  it("crew: a requiresConfirmation tool that IS in the allowlist executes directly (no Commander approval)", async () => {
    // Discriminator: under resolveCommanderToolPolicy this tool would return a
    // ⚡CONFIRM marker and NOT execute (requiresConfirmation:true +
    // runtimeApprovalsEnabled:true). Under authorizeToolInvocation it executes.
    const tool = makeTool({ name: "crew_write", requiresConfirmation: true });
    const executeSpy = vi.fn().mockResolvedValue({ success: true, data: { ok: 1 }, summary: "done" });
    const createPending = vi.fn().mockResolvedValue({ id: "should-not-happen" });

    const handler = createToolCallHandler({
      tools: [tool],
      executeTool: executeSpy,
      toolContext: CREW_CTX,
      runtimeApprovals: { createPending, findTrustedExact: vi.fn().mockResolvedValue(null) },
    });

    const res = await handler("crew_write", { title: "x" });

    expect(executeSpy).toHaveBeenCalledOnce();
    expect(res.isError).toBeFalsy();
    // The Commander approval machinery must be untouched for crew.
    expect(createPending).not.toHaveBeenCalled();
    expect(res.content[0]!.text).not.toContain("CONFIRM");
  });

  it("crew: a tool NOT in the allowlist is still DENIED (allowlist enforcement survives the coupling fix)", async () => {
    const tool = makeTool({ name: "forbidden_tool" });
    const executeSpy = vi.fn().mockResolvedValue({ success: true, data: null, summary: "leaked" });

    const handler = createToolCallHandler({
      tools: [tool],
      executeTool: executeSpy,
      toolContext: CREW_CTX, // allowlist is ["crew_write"] only
    });

    const res = await handler("forbidden_tool", {});

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("NOT_IN_ALLOWLIST");
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("commander: the same requiresConfirmation tool STILL routes through the Commander approval layer (fix did not over-reach)", async () => {
    // Regression guard for the coupling fix: a Commander actor must keep
    // resolveCommanderToolPolicy → requiresConfirmation yields a ⚡CONFIRM marker.
    const tool = makeTool({ name: "commander_write", category: "action", requiresConfirmation: true });
    const executeSpy = vi.fn().mockResolvedValue({ success: true, data: null, summary: "should-not-run" });
    const createPending = vi.fn().mockResolvedValue({ id: "approval-9" });

    const commanderCtx = {
      companyId: "co-1",
      userId: "user-1",
      userRole: "founder",
      enabledCapabilities: ["system_actions"],
      actorType: "commander",
      commanderToolPermissions: null,
      runtimeApprovalsEnabled: true,
      runId: "run-2",
      contextScope: { surface: "commander", conversationId: "conv-1" },
      db: {} as any,
      services: {} as any,
    } as unknown as ToolContext;

    const handler = createToolCallHandler({
      tools: [tool],
      executeTool: executeSpy,
      toolContext: commanderCtx,
      runtimeApprovals: { createPending, findTrustedExact: vi.fn().mockResolvedValue(null) },
    });

    const res = await handler("commander_write", { title: "x" });

    expect(executeSpy).not.toHaveBeenCalled();
    expect(createPending).toHaveBeenCalledOnce();
    expect(res.content[0]!.text).toContain("CONFIRM");
    expect(res.isError).toBeFalsy();
  });
});
