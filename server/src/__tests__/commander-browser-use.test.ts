import { describe, expect, it } from "vitest";
import { buildMcpConfig, PLAYWRIGHT_MCP_PACKAGE } from "../services/internal-agent/cli-mode.js";

const baseParams = {
  companyId: "c1",
  userId: "u1",
  userRole: "founder",
  bridgeEntrypoint: "/fake/bridge.js",
  enabledCapabilities: [] as readonly string[],
};

describe("buildMcpConfig: browser_use capability", () => {
  it("does NOT include playwright server when browser_use is absent", () => {
    const config = buildMcpConfig({
      ...baseParams,
      enabledCapabilities: ["system_actions"],
    });
    expect(config.mcpServers).not.toHaveProperty("playwright");
  });

  it("includes playwright server entry when browser_use is enabled", () => {
    const config = buildMcpConfig({
      ...baseParams,
      enabledCapabilities: ["system_actions", "browser_use"],
    });
    expect(config.mcpServers).toHaveProperty("playwright");
    expect(config.mcpServers.playwright!.command).toBe("npx");
    expect(config.mcpServers.playwright!.args).toContain(PLAYWRIGHT_MCP_PACKAGE);
    expect(config.mcpServers.playwright!.args).toContain("--headless");
  });

  it("aoa bridge is always present regardless of browser_use", () => {
    const config = buildMcpConfig({
      ...baseParams,
      enabledCapabilities: ["browser_use"],
    });
    expect(config.mcpServers).toHaveProperty("aoa");
  });
});
