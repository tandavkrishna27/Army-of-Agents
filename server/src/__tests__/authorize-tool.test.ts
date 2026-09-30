import { describe, it, expect } from "vitest";
import { authorizeToolInvocation } from "../services/internal-agent/authorize-tool.js";
import type { AgentTool } from "../services/internal-agent/types.js";

function fakeTool(overrides: Partial<AgentTool>): AgentTool {
  return {
    name: "fake_tool",
    description: "",
    parameters: { type: "object", properties: {} },
    category: "query",
    requiredRole: "team_member",
    requiresConfirmation: false,
    execute: async () => ({ success: true, data: null, summary: "" }),
    ...overrides,
  };
}

describe("authorizeToolInvocation — role gate", () => {
  it("allows founder to invoke a founder-required tool", () => {
    const tool = fakeTool({ requiredRole: "founder" });
    expect(authorizeToolInvocation(tool, "founder", []).allowed).toBe(true);
  });
  it("rejects team_member from a founder-required tool", () => {
    const tool = fakeTool({ requiredRole: "founder" });
    const result = authorizeToolInvocation(tool, "team_member", []);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.error).toBe("FORBIDDEN_ROLE");
  });
  it("rejects team_member from a team_lead-required tool", () => {
    const tool = fakeTool({ requiredRole: "team_lead" });
    const result = authorizeToolInvocation(tool, "team_member", []);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.error).toBe("FORBIDDEN_ROLE");
  });
  it("allows team_lead to invoke a team_member-required tool", () => {
    const tool = fakeTool({ requiredRole: "team_member" });
    expect(authorizeToolInvocation(tool, "team_lead", []).allowed).toBe(true);
  });
  it("rejects an unknown role string (fail-closed)", () => {
    const tool = fakeTool({ requiredRole: "team_member" });
    const result = authorizeToolInvocation(tool, "admin" as any, []);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.error).toBe("FORBIDDEN_ROLE");
  });
  it("rejects an empty role string (fail-closed)", () => {
    const tool = fakeTool({ requiredRole: "team_member" });
    const result = authorizeToolInvocation(tool, "", []);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.error).toBe("FORBIDDEN_ROLE");
  });
});

describe("authorizeToolInvocation — capability gate", () => {
  it("rejects discussion tool when discussion_processing is not enabled", () => {
    const tool = fakeTool({ category: "discussion", requiredRole: "team_member" });
    const result = authorizeToolInvocation(tool, "founder", []);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.error).toBe("CAPABILITY_DISABLED");
  });
  it("allows discussion tool when discussion_processing is enabled", () => {
    const tool = fakeTool({ category: "discussion", requiredRole: "team_member" });
    expect(authorizeToolInvocation(tool, "founder", ["discussion_processing"]).allowed).toBe(true);
  });
  it("rejects action tool when system_actions is not enabled", () => {
    const tool = fakeTool({ category: "action", requiredRole: "founder" });
    const result = authorizeToolInvocation(tool, "founder", []);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.error).toBe("CAPABILITY_DISABLED");
  });
  it("allows query tool regardless of capabilities (core surface)", () => {
    const tool = fakeTool({ category: "query", requiredRole: "team_member" });
    expect(authorizeToolInvocation(tool, "team_member", []).allowed).toBe(true);
  });
  it("role gate fires before capability gate", () => {
    const tool = fakeTool({ category: "action", requiredRole: "founder" });
    const result = authorizeToolInvocation(tool, "team_member", ["system_actions"]);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.error).toBe("FORBIDDEN_ROLE");
  });
});
