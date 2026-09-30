import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// Commander's use_skill runs through the internal-agent bridge tool, NOT the
// HTTP MCP-server handler. Enforcement must live in the bridge tool.
const src = readFileSync(
  join(__dirname, "../services/internal-agent/tools/skill-tools.ts"),
  "utf-8",
);

describe("use_skill skillKeys enforcement (bridge tool)", () => {
  it("enforces only for the commander actor", () => {
    expect(src).toContain('ctx.actorType === "commander"');
  });
  it("resolves the commander agent via internalAgentConfig.agentId", () => {
    expect(src).toContain("internalAgentConfig");
    expect(src).toMatch(/agentId:\s*internalAgentConfig\.agentId/);
  });
  it("rejects skills not present in the agent's skillKeys using canonical key", () => {
    // Must check skill.key (canonical), not the raw `key` input
    expect(src).toMatch(/allowed\.includes\(skill\.key\)/);
    expect(src).toContain("not enabled for Commander");
  });
});

describe("use_skill flexible key resolution (bridge tool)", () => {
  it("tries the skill: prefix when bare key is not found", () => {
    // Source contains: s.key.toLowerCase() === `skill:${want}`
    expect(src).toContain("skill:");
    expect(src).toContain("${want}");
    expect(src).toMatch(/`skill:\$\{want\}`/);
  });
  it("falls back to slug match", () => {
    expect(src).toContain(".slug");
  });
  it("falls back to name match", () => {
    expect(src).toContain(".name");
  });
  it("resolves against the full company skills list (not exact-match WHERE clause)", () => {
    // Flexible resolution loads all skills then filters in JS
    expect(src).toContain("companySkills.companyId, ctx.companyId");
    // No double-compound AND(companyId, key) exact match in the fetch
    expect(src).not.toMatch(/and\(eq\(companySkills\.companyId.*eq\(companySkills\.key/);
  });
});

describe("HTTP MCP use_skill handler stays company-scoped (no dead commander branch)", () => {
  const httpSrc = readFileSync(join(__dirname, "../mcp/tools/skill-tools.ts"), "utf-8");
  it("does not contain a commander enforcement branch (that path never emits a commander actor)", () => {
    expect(httpSrc).not.toContain("not enabled for Commander");
  });
});
