import { describe, expect, it, vi } from "vitest";
import { buildCompactSkillList } from "../services/internal-agent/commander-skills.js";
import { COMMANDER_SKILL_PREAMBLE } from "../services/internal-agent/commander-preamble.js";

function makeEntry(overrides: Partial<{ key: string; name: string; description: string; triggerPhrases: string[] }> = {}) {
  return {
    key: "brainstorming",
    name: "Brainstorming",
    description: "Before building new features",
    triggerPhrases: [],
    ...overrides,
  };
}

describe("buildCompactSkillList", () => {
  it("returns empty string when entries list is empty", async () => {
    const resolve = vi.fn(async () => []);
    const result = await buildCompactSkillList({ companyId: "c1", agentId: "a1", resolve });
    expect(result).toBe("");
  });

  it("returns markdown table with ## Available Skills header for a single skill with no trigger phrases", async () => {
    const resolve = vi.fn(async () => [makeEntry()]);
    const result = await buildCompactSkillList({ companyId: "c1", agentId: "a1", resolve });
    expect(result).toContain("## Available Skills");
    expect(result).toContain("| **Brainstorming** (`brainstorming`) |");
    expect(result).toContain("Before building new features");
    // No trigger phrases — should not have "Triggers:" text
    expect(result).not.toContain("Triggers:");
  });

  it("includes Triggers in row when skill has trigger phrases", async () => {
    const resolve = vi.fn(async () => [
      makeEntry({ triggerPhrases: ["new feature", "build something"] }),
    ]);
    const result = await buildCompactSkillList({ companyId: "c1", agentId: "a1", resolve });
    expect(result).toContain("Triggers: new feature, build something");
  });

  it("includes all rows and header for multiple skills", async () => {
    const resolve = vi.fn(async () => [
      makeEntry({ key: "brainstorming", name: "Brainstorming", description: "Before building" }),
      makeEntry({ key: "review", name: "Review", description: "Code review tasks" }),
      makeEntry({ key: "plan", name: "Plan", description: "Planning phase" }),
    ]);
    const result = await buildCompactSkillList({ companyId: "c1", agentId: "a1", resolve });
    expect(result).toContain("## Available Skills");
    expect(result).toContain("| **Brainstorming** (`brainstorming`) |");
    expect(result).toContain("| **Review** (`review`) |");
    expect(result).toContain("| **Plan** (`plan`) |");
  });

  it("appends overflow sentinel when skills would exceed 4000 chars, not all skills present", async () => {
    // Each entry is ~80 chars. Create enough to overflow 4000 chars.
    const manyEntries = Array.from({ length: 200 }, (_, i) => ({
      key: `skill-${i}`,
      name: `Skill Number ${i} With A Longer Name To Use More Chars`,
      description: `Description for skill ${i} that is also somewhat long to fill space`,
      triggerPhrases: [],
    }));
    const resolve = vi.fn(async () => manyEntries);
    const result = await buildCompactSkillList({ companyId: "c1", agentId: "a1", resolve });
    expect(result).toContain("_(additional skills configured — query with use_skill)_");
    // Not all 200 should be present
    const rowCount = (result.match(/^\|/gm) ?? []).length;
    // Header row + at-least-separator row: total table rows should be < 200 + 2
    expect(rowCount).toBeLessThan(202);
  });

  it("returns empty string and never throws when resolve function throws", async () => {
    const resolve = vi.fn(async () => {
      throw new Error("DB exploded");
    });
    const result = await buildCompactSkillList({ companyId: "c1", agentId: "a1", resolve });
    expect(result).toBe("");
  });

  it("prepends the shared preamble before the Available Skills header", async () => {
    const resolve = vi.fn(async () => [makeEntry()]);
    const result = await buildCompactSkillList({ companyId: "c1", agentId: "a1", resolve });
    expect(result).toContain(COMMANDER_SKILL_PREAMBLE);
    // preamble must come before the table header
    expect(result.indexOf(COMMANDER_SKILL_PREAMBLE)).toBeLessThan(result.indexOf("## Available Skills"));
  });

  it("omits the preamble entirely when there are no skills (still returns empty string)", async () => {
    const resolve = vi.fn(async () => []);
    const result = await buildCompactSkillList({ companyId: "c1", agentId: "a1", resolve });
    expect(result).toBe("");
    expect(result).not.toContain(COMMANDER_SKILL_PREAMBLE);
  });
});
