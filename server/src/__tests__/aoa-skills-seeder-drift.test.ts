import { describe, it, expect } from "vitest";
import catalog from "../services/internal-agent/generated/aoa-native-skills.json" with { type: "json" };

describe("aoa-native-skills.json — generated catalog invariants", () => {
  it("has a $generated banner + version + non-empty skills", () => {
    expect((catalog as any).$generated).toContain("gen:skills");
    expect(Array.isArray(catalog.skills)).toBe(true);
    expect(catalog.skills.length).toBeGreaterThanOrEqual(4);
  });

  it("every entry has the seeder shape and a mapped key", () => {
    for (const s of catalog.skills) {
      expect(s.key).toMatch(/^skill:aoa\/[a-z-]+$/);
      expect(typeof s.name).toBe("string");
      expect(typeof s.description).toBe("string");
      expect(Array.isArray(s.triggerPhrases)).toBe(true);
      expect(typeof s.markdown).toBe("string");
      expect(s.markdown).not.toContain("create_memory");
    }
  });
});
