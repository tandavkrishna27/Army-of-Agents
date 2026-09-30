import { describe, expect, it } from "vitest";
import { toolHandlers, toolAllowedActors, TOOL_DEFINITIONS } from "../mcp/tools/index.js";
import { createToolRegistry } from "../services/internal-agent/tool-registry.js";

describe("Ask Human registration", () => {
  it("registers the canonical tool and compatibility alias", () => {
    expect(typeof toolHandlers["ask_human"]).toBe("function");
    expect(typeof toolHandlers["ask_founder"]).toBe("function");
  });

  it("is gated to agent actors only", () => {
    expect(toolAllowedActors["ask_human"]).toEqual(["agent"]);
    expect(toolAllowedActors["ask_founder"]).toEqual(["agent"]);
  });

  it("publishes matching schemas for the canonical tool and alias", () => {
    for (const name of ["ask_human", "ask_founder"]) {
      const def = TOOL_DEFINITIONS.find((candidate) => candidate.name === name);
      expect(def).toBeTruthy();
      expect(def!.inputSchema.required).toContain("question");
      expect(def!.inputSchema.properties).toHaveProperty("options");
      expect(def!.inputSchema.properties).toHaveProperty("context");
    }
  });

  it("publishes both names through the stdio bridge used by heartbeat agents", () => {
    const registry = createToolRegistry();
    for (const name of ["ask_human", "ask_founder"]) {
      const tool = registry.find((candidate) => candidate.name === name);
      expect(tool).toBeTruthy();
      expect(tool!.requiredRole).toBe("team_member");
      expect(tool!.requiresConfirmation).toBe(false);
      expect(tool!.parameters.required).toContain("question");
    }
  });
});
