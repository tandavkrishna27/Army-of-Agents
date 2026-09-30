import { describe, it, expect } from "vitest";
import {
  buildSkillMentionHref,
  parseSkillMentionHref,
  extractSkillMentionIds,
  normalizeSkillSlug,
} from "@armyofagents/shared";

describe("skill mentions", () => {
  it("buildSkillMentionHref creates skill:// URL with slug", () => {
    expect(buildSkillMentionHref("abc-123", "my-skill")).toBe("skill://abc-123?s=my-skill");
  });

  it("buildSkillMentionHref omits slug when not provided", () => {
    expect(buildSkillMentionHref("abc-123")).toBe("skill://abc-123");
  });

  it("parseSkillMentionHref round-trips with slug", () => {
    expect(parseSkillMentionHref("skill://abc-123?s=my-skill")).toEqual({
      skillId: "abc-123",
      slug: "my-skill",
    });
  });

  it("parseSkillMentionHref handles no slug", () => {
    expect(parseSkillMentionHref("skill://abc-123")).toEqual({
      skillId: "abc-123",
      slug: null,
    });
  });

  it("parseSkillMentionHref returns null for invalid", () => {
    expect(parseSkillMentionHref("project://abc")).toBeNull();
  });

  it("extractSkillMentionIds finds all IDs", () => {
    const md =
      "see [foo](skill://abc-123?s=foo) and [bar](skill://def-456) and [baz](project://other)";
    expect(extractSkillMentionIds(md).sort()).toEqual(["abc-123", "def-456"]);
  });

  it("normalizeSkillSlug handles spaces and special chars", () => {
    expect(normalizeSkillSlug("My Cool Skill!")).toBe("my-cool-skill");
  });

  it("normalizeSkillSlug decomposes accented Latin chars", () => {
    expect(normalizeSkillSlug("naïve skill")).toBe("naive-skill");
    expect(normalizeSkillSlug("Café Routine")).toBe("cafe-routine");
  });
});
