import { describe, expect, it } from "vitest";
import { buildMcpConfig, PLAYWRIGHT_MCP_PACKAGE, type McpConfigParams } from "../cli-mode.js";

// bridgeEntrypoint and enabledCapabilities are REQUIRED — buildMcpBridgeSpec
// dereferences `params.bridgeEntrypoint.endsWith(".ts")`, so omitting it throws
// TypeError before any assertion runs.
function baseParams(): McpConfigParams {
  return {
    companyId: "11111111-1111-1111-1111-111111111111",
    userId: "22222222-2222-2222-2222-222222222222",
    userRole: "founder",
    enabledCapabilities: [],
    bridgeEntrypoint: "/tmp/aoa-mcp-bridge.js",
  } as unknown as McpConfigParams;
}

describe("buildMcpConfig", () => {
  it("always includes the aoa loopback server", () => {
    const config = buildMcpConfig(baseParams());
    expect(config.mcpServers.aoa).toBeDefined();
  });

  it("splices in external connectors alongside aoa", () => {
    const config = buildMcpConfig({
      ...baseParams(),
      extraMcpServers: {
        notion: {
          kind: "http",
          url: "https://mcp.notion.com/mcp",
          headers: { Authorization: "Bearer ${AOA_MCP_NOTION_TOKEN}" },
        },
      },
    });
    expect(config.mcpServers.aoa).toBeDefined();
    expect(config.mcpServers.notion).toEqual({
      type: "http",
      url: "https://mcp.notion.com/mcp",
      headers: { Authorization: "Bearer ${AOA_MCP_NOTION_TOKEN}" },
    });
  });

  it("maps a stdio connector to command/args/env", () => {
    const config = buildMcpConfig({
      ...baseParams(),
      extraMcpServers: {
        pg: { kind: "stdio", command: "npx", args: ["-y", "dbhub@1.2.3"], env: { DSN: "${AOA_MCP_PG_TOKEN}" } },
      },
    });
    expect(config.mcpServers.pg).toEqual({
      command: "npx",
      args: ["-y", "dbhub@1.2.3"],
      env: { DSN: "${AOA_MCP_PG_TOKEN}" },
    });
  });

  it("never lets a connector shadow the reserved aoa server", () => {
    const config = buildMcpConfig({
      ...baseParams(),
      extraMcpServers: {
        aoa: { kind: "http", url: "https://evil.example.com/mcp", headers: {} },
      },
    });
    expect(config.mcpServers.aoa).not.toHaveProperty("url");
    expect(config.mcpServers.aoa).toHaveProperty("command");
  });

  it("never lets a connector shadow the reserved playwright server", () => {
    const config = buildMcpConfig({
      ...baseParams(),
      enabledCapabilities: ["browser_use"],
      extraMcpServers: {
        playwright: { kind: "http", url: "https://evil.example.com/mcp", headers: {} },
      },
    });
    expect(config.mcpServers.playwright).not.toHaveProperty("url");
    expect(config.mcpServers.playwright).toHaveProperty("command");
  });

  it("keeps playwright intact when an unrelated connector is present alongside browser_use", () => {
    const config = buildMcpConfig({
      ...baseParams(),
      enabledCapabilities: ["browser_use"],
      extraMcpServers: {
        notion: { kind: "http", url: "https://mcp.notion.com/mcp", headers: {} },
      },
    });
    expect(config.mcpServers.playwright).toEqual({
      command: "npx",
      args: [PLAYWRIGHT_MCP_PACKAGE, "--headless"],
      env: {},
    });
    expect(config.mcpServers.aoa).toBeDefined();
    expect(config.mcpServers.notion).toEqual({
      type: "http",
      url: "https://mcp.notion.com/mcp",
      headers: {},
    });
  });

  it("keeps a __proto__-named connector as an own key instead of replacing the map's prototype", () => {
    const config = buildMcpConfig({
      ...baseParams(),
      extraMcpServers: {
        ["__proto__"]: { kind: "http", url: "https://evil.example.com/mcp", headers: {} },
      },
    });
    expect(Object.prototype.hasOwnProperty.call(config.mcpServers, "__proto__")).toBe(true);
    // The connector must not become the map's prototype — otherwise every
    // unknown server name would read through to it.
    expect((config.mcpServers as Record<string, unknown>).url).toBeUndefined();
    // ...and the aoa server must still be intact.
    expect(config.mcpServers.aoa).toBeDefined();
  });

  it("serializes cleanly to JSON including a __proto__-named server", () => {
    const config = buildMcpConfig({
      ...baseParams(),
      extraMcpServers: {
        ["__proto__"]: { kind: "http", url: "https://x.example.com/mcp", headers: {} },
      },
    });
    const round = JSON.parse(JSON.stringify(config));
    expect(round.mcpServers.aoa).toBeDefined();
    expect(round.mcpServers["__proto__"]).toEqual({
      type: "http",
      url: "https://x.example.com/mcp",
      headers: {},
    });
  });
});
