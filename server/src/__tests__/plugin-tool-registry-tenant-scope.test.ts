import { describe, expect, it, vi } from "vitest";
import { createPluginToolRegistry } from "../services/plugin-tool-registry.js";

const manifest = {
  tools: [
    {
      name: "run",
      displayName: "Run",
      description: "Run the tenant tool",
      parametersSchema: { type: "object" },
    },
  ],
} as any;

describe("plugin tool registry tenant scope", () => {
  it("keeps identical plugin keys isolated by company and routes to the right worker", async () => {
    const workerManager = {
      isRunning: vi.fn(() => true),
      call: vi.fn(async (pluginId: string) => ({
        content: [{ type: "text", text: pluginId }],
      })),
    };
    const registry = createPluginToolRegistry(workerManager as any);
    registry.registerPlugin("acme.shared", manifest, "plugin-a", "company-a");
    registry.registerPlugin("acme.shared", manifest, "plugin-b", "company-b");

    expect(
      registry
        .listTools({ companyId: "company-a" })
        .map((tool) => tool.pluginDbId)
    ).toEqual(["plugin-a"]);
    expect(
      registry
        .listTools({ companyId: "company-b" })
        .map((tool) => tool.pluginDbId)
    ).toEqual(["plugin-b"]);
    expect(registry.getTool("acme.shared:run")).toBeNull();

    await registry.executeTool(
      "acme.shared:run",
      {},
      {
        agentId: "agent-b",
        runId: "run-b",
        companyId: "company-b",
        projectId: "project-b",
      }
    );
    expect(workerManager.call).toHaveBeenCalledWith(
      "plugin-b",
      "executeTool",
      expect.objectContaining({ toolName: "run" })
    );
  });

  it("unregisters one plugin row without removing another tenant's tools", () => {
    const registry = createPluginToolRegistry();
    registry.registerPlugin("acme.shared", manifest, "plugin-a", "company-a");
    registry.registerPlugin("acme.shared", manifest, "plugin-b", "company-b");

    registry.unregisterPlugin("plugin-a");

    expect(registry.getTool("acme.shared:run", "company-a")).toBeNull();
    expect(registry.getTool("acme.shared:run", "company-b")?.pluginDbId).toBe(
      "plugin-b"
    );
  });
});
