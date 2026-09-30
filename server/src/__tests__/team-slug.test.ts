import { describe, expect, it } from "vitest";
import { generateTeamSlug, ensureUniqueSlug } from "../services/team-slug.js";

describe("generateTeamSlug", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(generateTeamSlug("Frontend Team")).toBe("frontend-team");
  });

  it("strips special characters", () => {
    expect(generateTeamSlug("Frontend & UI / Team!")).toBe("frontend-ui-team");
  });

  it("collapses multiple hyphens", () => {
    expect(generateTeamSlug("Frontend  --  Team")).toBe("frontend-team");
  });

  it("trims leading/trailing hyphens", () => {
    expect(generateTeamSlug("  -frontend-  ")).toBe("frontend");
  });

  it("caps at 64 chars", () => {
    const long = "a".repeat(100);
    expect(generateTeamSlug(long).length).toBeLessThanOrEqual(64);
  });

  it("rejects empty input", () => {
    expect(() => generateTeamSlug("")).toThrow("name cannot be empty");
    expect(() => generateTeamSlug("!!!")).toThrow("name produces empty slug");
  });
});

describe("ensureUniqueSlug", () => {
  it("returns base slug if not taken", () => {
    expect(ensureUniqueSlug("frontend", new Set())).toBe("frontend");
  });

  it("appends -2 if base taken", () => {
    expect(ensureUniqueSlug("frontend", new Set(["frontend"]))).toBe("frontend-2");
  });

  it("appends -3 if -2 also taken", () => {
    expect(ensureUniqueSlug("frontend", new Set(["frontend", "frontend-2"]))).toBe("frontend-3");
  });

  it("handles 100 collisions", () => {
    const taken = new Set(["frontend", ...Array.from({length: 99}, (_, i) => `frontend-${i + 2}`)]);
    expect(ensureUniqueSlug("frontend", taken)).toBe("frontend-101");
  });
});
