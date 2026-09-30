// server/src/services/internal-agent/__tests__/mcp-bridge-output-refs.test.ts
import { describe, it, expect } from "vitest";
import { createToolCallHandler } from "../mcp-bridge.js";
import type { AgentTool, ToolContext, ToolResult } from "../types.js";

const ctx = {
  companyId: "c1",
  userId: "u1",
  userRole: "founder",
  enabledCapabilities: ["system_actions", "discussion_processing", "memory_management"],
  commanderToolPermissions: null,
  runtimeApprovalsEnabled: false,
  runId: "run-9",
  contextScope: { surface: "commander", conversationId: "conv-9" },
} as unknown as ToolContext;

function makeTool(name: string): AgentTool {
  return {
    name,
    description: "t",
    parameters: { type: "object", properties: {} },
    category: "action",
    requiredRole: "team_member",
    requiresConfirmation: false,
    execute: async () => ({ success: true, data: null, summary: "unused" }),
  } as unknown as AgentTool;
}

describe("mcp-bridge envelope outputRefs", () => {
  it("includes outputRefs for create_artifact results", async () => {
    const handler = createToolCallHandler({
      tools: [makeTool("create_artifact")],
      executeTool: async (): Promise<ToolResult> => ({
        success: true,
        data: { artifactId: "art-1", versionId: "ver-1" },
        summary: "Created artifact: GTM Plan",
      }),
      toolContext: ctx,
    });
    const res = await handler("create_artifact", { title: "GTM Plan", type: "document" });
    const envelope = JSON.parse(res.content[0]!.text);
    expect(envelope.outputRefs).toHaveLength(1);
    expect(envelope.outputRefs[0]).toMatchObject({
      v: 2, kind: "artifact", id: "art-1", action: "created", title: "GTM Plan",
      provenance: { surface: "commander", entityId: "conv-9", runId: "run-9" },
    });
  });

  it("omits outputRefs key for tools with no refs", async () => {
    const handler = createToolCallHandler({
      tools: [makeTool("post_entry")],
      executeTool: async (): Promise<ToolResult> => ({ success: true, data: { entryId: "e1" }, summary: "ok" }),
      toolContext: ctx,
    });
    const res = await handler("post_entry", {});
    const envelope = JSON.parse(res.content[0]!.text);
    expect("outputRefs" in envelope).toBe(false);
  });
});
