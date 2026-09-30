import { describe, expect, it } from "vitest";
import { buildAlwaysOnCore } from "../services/memory-core-block.js";

describe("buildAlwaysOnCore", () => {
  it("names the role, the current goal, and the query_memory hint", () => {
    const s = buildAlwaysOnCore({ agentRole: "Engineer", goalTitle: "Ship auth" });
    expect(s).toContain("Engineer");
    expect(s).toContain("Ship auth");
    expect(s).toMatch(/query_memory/);
    expect(s).toMatch(/identity|polic/i);
  });

  it("stays small and omits the goal line gracefully when absent", () => {
    const s = buildAlwaysOnCore({ agentRole: "Engineer", goalTitle: null });
    expect(s).not.toMatch(/current goal/i);
    expect(s.length).toBeLessThan(400); // deterministic core, not a dump
  });

  it("falls back to a generic role label when none is given", () => {
    expect(buildAlwaysOnCore({ agentRole: null, goalTitle: null })).toContain("agent");
  });
});
