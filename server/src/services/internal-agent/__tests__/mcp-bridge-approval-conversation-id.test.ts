// server/src/services/internal-agent/__tests__/mcp-bridge-approval-conversation-id.test.ts
//
// Regression for fix ab47b0606: the approval path in createToolCallHandler must
// read the Commander conversation id from `toolContext.contextScope.conversationId`
// (where it actually lives), NOT a non-existent top-level `conversationId`. The
// reconstructed ToolContext has no top-level `conversationId`, so reading it
// directly stored null — which left approval-gated tool results with no
// conversation to attach output refs to (the confirm route guards on a non-null
// claimed.conversationId), so no viewer nav chip was emitted.
import { describe, it, expect, vi } from "vitest";
import { createToolCallHandler } from "../mcp-bridge.js";

describe("mcp-bridge approval createPending conversationId", () => {
  it("uses contextScope.conversationId (not a top-level field) when a tool requires approval", async () => {
    // Tool that requires approval: requiresConfirmation:true → with
    // runtimeApprovalsEnabled:true this makes resolveCommanderToolPolicy return
    // requiresApproval:true. category "query" avoids the capability gate, no
    // requiredRole skips the role gate, no agentKind skips the allowlist gate,
    // and commanderToolPermissions null → default (enabled:true).
    const tool = {
      name: "gated_write",
      description: "a write tool that needs approval",
      parameters: { type: "object", properties: {} },
      category: "query",
      requiresConfirmation: true,
      execute: async () => ({ success: true, data: null, summary: "unused" }),
    } as any;

    // ToolContext with the conversation id ONLY on contextScope — deliberately no
    // top-level `conversationId` field, mirroring the reconstructed bridge context.
    const toolContext = {
      companyId: "company-1",
      userId: "user-1",
      userRole: "founder",
      enabledCapabilities: [],
      // T8 Defect B: the runtime-approval path is Commander-only. This scenario
      // exercises that path, so the actor must be Commander (previously this
      // relied on the bridge applying Commander policy to every actor).
      actorType: "commander",
      agentKind: undefined,
      toolAllowlist: undefined,
      commanderToolPermissions: null,
      runtimeApprovalsEnabled: true,
      runId: "run-7",
      contextScope: { surface: "commander", conversationId: "conv-xyz" },
      db: {} as any,
      services: {} as any,
    } as any;

    const createPending = vi.fn(async (_arg: any) => ({ id: "appr-1" }));
    const findTrustedExact = vi.fn(async (_arg: any) => null);

    const handle = createToolCallHandler({
      tools: [tool],
      // executeTool must NOT run on the approval path (a pending approval is
      // returned instead). Make it throw so an accidental execution is loud.
      executeTool: async () => { throw new Error("executeTool must not run on approval path"); },
      toolContext,
      runtimeApprovals: { findTrustedExact, createPending } as any,
    });

    const res = await handle("gated_write", { title: "x" });

    // Approval path returns a ⚡CONFIRM marker, not an executed result.
    expect(res.isError).toBe(false);
    expect(res.content[0]!.text).toContain("⚡CONFIRM");

    expect(createPending).toHaveBeenCalledTimes(1);
    expect(createPending.mock.calls[0]![0]).toMatchObject({
      conversationId: "conv-xyz",
      companyId: "company-1",
      runId: "run-7",
      userId: "user-1",
      toolName: "gated_write",
    });
    // Explicitly assert it is the contextScope value, not null.
    expect(createPending.mock.calls[0]![0].conversationId).toBe("conv-xyz");
    expect(createPending.mock.calls[0]![0].conversationId).not.toBeNull();
  });
});
