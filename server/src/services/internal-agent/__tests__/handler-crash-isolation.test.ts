import { describe, it, expect } from "vitest";
import { createToolCallHandler } from "../mcp-bridge.js";

describe("handler crash isolation", () => {
  it("a tool that throws returns isError, never rejects", async () => {
    // Minimal AgentTool stub: no requiredRole (skips role gate), category "query"
    // (not in CAPABILITY_TO_CATEGORY map → no capability gate), agentKind absent
    // (skips AoA allowlist gate), requiresConfirmation: false → requiresApproval:
    // false → straight to executeAndFormat where the throw is caught.
    const tool = {
      name: "boom",
      description: "test tool that always throws",
      parameters: { type: "object", properties: {} },
      category: "query",
      requiresConfirmation: false,
      execute: async () => { throw new Error("kaboom"); },
    } as any;

    // Minimal ToolContext stub: userRole "founder" passes all role checks,
    // no agentKind to avoid allowlist gate, commanderToolPermissions null → default
    // (enabled:true, requireConfirmation:false, minimumRole:"team_member"),
    // runtimeApprovalsEnabled: false ensures requiresApproval stays false even if
    // the tool stub lacks requiresConfirmation. db/services are never reached
    // because the throw happens inside executeTool before any ctx.db usage.
    const toolContext = {
      companyId: "test-company",
      userId: "test-user",
      userRole: "founder",
      enabledCapabilities: [],
      agentKind: undefined,
      toolAllowlist: undefined,
      commanderToolPermissions: null,
      runtimeApprovalsEnabled: false,
      db: {} as any,
      services: {} as any,
    } as any;

    const handle = createToolCallHandler({
      tools: [tool],
      executeTool: async () => { throw new Error("kaboom"); },
      toolContext,
      runtimeApprovals: {
        findTrustedExact: async () => true,
        createPending: async () => ({ id: "x" }),
      } as any,
    });

    const r = await handle("boom", {});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("kaboom");
  });
});
