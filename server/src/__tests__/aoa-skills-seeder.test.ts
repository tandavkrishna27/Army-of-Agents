import { describe, expect, it, vi } from "vitest";
import { seedAoaNativeSkills, AOA_NATIVE_SKILLS } from "../services/internal-agent/aoa-skills-seeder.js";
import catalog from "../services/internal-agent/generated/aoa-native-skills.json" with { type: "json" };

describe("seedAoaNativeSkills", () => {
  it("matches the generated catalog (no hand-drift)", () => {
    expect(AOA_NATIVE_SKILLS.length).toBe(catalog.skills.length);
    expect(AOA_NATIVE_SKILLS.length).toBeGreaterThanOrEqual(4);
  });

  it("each skill has required fields: key, name, description, markdown", () => {
    for (const skill of AOA_NATIVE_SKILLS) {
      expect(skill.key).toMatch(/^skill:aoa\//);
      expect(skill.name).toBeTruthy();
      expect(skill.description).toBeTruthy();
      expect(skill.markdown).toBeTruthy();
    }
  });

  it("every native key is a runtime seeder key (skill:aoa/<name>), never the repo source key", () => {
    for (const s of AOA_NATIVE_SKILLS) {
      expect(s.key).toMatch(/^skill:aoa\/[a-z-]+$/);
      expect(s.key.startsWith("skill:aoa-curated/")).toBe(false);
    }
  });

  it("carries no create_memory phantom in any body", () => {
    for (const s of AOA_NATIVE_SKILLS) expect(s.markdown).not.toContain("create_memory");
  });

  it("calls db insert for each skill", async () => {
    const insertSpy = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: () => Promise.resolve(),
      }),
    });
    const mockDb = { insert: insertSpy } as any;

    await seedAoaNativeSkills(mockDb, "company-123");

    expect(insertSpy).toHaveBeenCalledTimes(AOA_NATIVE_SKILLS.length);
  });
});
