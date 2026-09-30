// Pins the load-bearing protection: if buildOutputRefs ever throws, the tool
// call must still succeed and the envelope must simply omit outputRefs
// (design §6/§7 — "ref-build failure doesn't fail the tool call").
import { describe, it, expect, vi } from "vitest";

vi.mock("../output-refs.js", () => ({
  buildOutputRefs: () => {
    throw new Error("boom");
  },
}));

import { createToolCallHandler } from "../mcp-bridge.js";
import type { AgentTool, ToolContext, ToolResult } from "../types.js";

const ctx = {
  companyId: "c1",
  userId: "u1",
  userRole: "founder",
  enabledCapabilities: ["system_actions", "discussion_processing", "memory_management"],
  commanderToolPermissions: null,
  runtimeApprovalsEnabled: false,
} as unknown as ToolContext;

describe("mcp-bridge outputRefs throw-path", () => {
  it("tool call succeeds and envelope omits outputRefs when ref-building throws", async () => {
    const handler = createToolCallHandler({
      tools: [
        {
          name: "create_artifact",
          description: "t",
          parameters: { type: "object", properties: {} },
          category: "action",
          requiredRole: "team_member",
          requiresConfirmation: false,
          execute: async () => ({ success: true, data: null, summary: "unused" }),
        } as unknown as AgentTool,
      ],
      executeTool: async (): Promise<ToolResult> => ({
        success: true,
        data: { artifactId: "art-1", versionId: "ver-1" },
        summary: "Created",
      }),
      toolContext: ctx,
    });
    const res = await handler("create_artifact", { title: "X" });
    expect(res.isError).toBeFalsy();
    const envelope = JSON.parse(res.content[0]!.text);
    expect(envelope.success).toBe(true);
    expect("outputRefs" in envelope).toBe(false);
  });
});
