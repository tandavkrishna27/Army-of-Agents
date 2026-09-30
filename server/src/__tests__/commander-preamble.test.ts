import { describe, expect, it } from "vitest";
import { COMMANDER_SKILL_PREAMBLE, SKILL_PREAMBLE_VERSION } from "../services/internal-agent/commander-preamble.js";

describe("COMMANDER_SKILL_PREAMBLE", () => {
  it("is a non-trivial single string", () => {
    expect(typeof COMMANDER_SKILL_PREAMBLE).toBe("string");
    expect(COMMANDER_SKILL_PREAMBLE.length).toBeGreaterThan(200);
    expect(COMMANDER_SKILL_PREAMBLE.length).toBeLessThan(1200); // injected every turn — keep tight
  });
  it("states the confirm-gate protocol with the OPTIONS marker", () => {
    expect(COMMANDER_SKILL_PREAMBLE).toContain("⚡OPTIONS");
    expect(COMMANDER_SKILL_PREAMBLE.toLowerCase()).toContain("confirm");
  });
  it("states memory is PENDING / suggest-only (Rule #6)", () => {
    expect(COMMANDER_SKILL_PREAMBLE.toLowerCase()).toContain("pending");
    // must NOT reference the phantom tool (Plan 1 removed it everywhere)
    expect(COMMANDER_SKILL_PREAMBLE).not.toContain("create_memory");
  });
  it("tells the model to load a skill before improvising and to reference peers by name", () => {
    expect(COMMANDER_SKILL_PREAMBLE.toLowerCase()).toContain("use_skill");
  });
  it("does not hardcode a surface-specific tool spelling beyond the surface-neutral use_skill", () => {
    // memory.write (MCP) and suggest_memory (Commander) are surface-specific — the
    // preamble must stay surface-agnostic (Decision: skills are surface-agnostic).
    expect(COMMANDER_SKILL_PREAMBLE).not.toContain("memory.write");
    expect(COMMANDER_SKILL_PREAMBLE).not.toContain("suggest_memory");
  });
  it("exposes a version string for cache-busting/telemetry", () => {
    expect(typeof SKILL_PREAMBLE_VERSION).toBe("string");
    expect(SKILL_PREAMBLE_VERSION.length).toBeGreaterThan(0);
  });
});
