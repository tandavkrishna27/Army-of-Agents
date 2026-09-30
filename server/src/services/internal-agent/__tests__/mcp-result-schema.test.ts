import { describe, it, expect } from "vitest";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

describe("McpToolResult is SDK-compliant", () => {
  it("a success tool result parses against CallToolResultSchema", () => {
    const result = { content: [{ type: "text", text: JSON.stringify({ success: true, data: {} }) }], isError: false };
    expect(() => CallToolResultSchema.parse(result)).not.toThrow();
  });
  it("an error result parses too", () => {
    const result = { content: [{ type: "text", text: "Tool execution error: boom" }], isError: true };
    expect(() => CallToolResultSchema.parse(result)).not.toThrow();
  });
  it("the approval-marker result parses too", () => {
    const result = { content: [{ type: "text", text: "⚡CONFIRM:{}⚡ This action requires your approval before I can proceed." }], isError: false };
    expect(() => CallToolResultSchema.parse(result)).not.toThrow();
  });
});
