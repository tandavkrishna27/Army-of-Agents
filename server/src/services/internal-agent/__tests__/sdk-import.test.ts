import { describe, it, expect } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

describe("mcp sdk export-map", () => {
  it("resolves Server, StdioServerTransport, schemas", () => {
    expect(typeof Server).toBe("function");
    expect(typeof StdioServerTransport).toBe("function");
    expect(ListToolsRequestSchema).toBeTruthy();
    expect(CallToolRequestSchema).toBeTruthy();
  });
});
