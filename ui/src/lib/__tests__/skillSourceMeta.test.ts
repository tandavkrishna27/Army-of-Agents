// ui/src/lib/__tests__/skillSourceMeta.test.ts
import { describe, it, expect } from "vitest";
import { Github, Folder, Boxes, Link2 } from "lucide-react";
import { skillSourceMeta, VercelMark } from "../skillSourceMeta";

describe("skillSourceMeta", () => {
  it("returns Vercel triangle + amber for skills_sh", () => {
    const meta = skillSourceMeta("skills_sh", "skills.sh");
    expect(meta.Icon).toBe(VercelMark);
    expect(meta.tone).toBe("amber");
    expect(meta.label).toBe("skills.sh");
  });

  it("returns Github + slate for plain github source", () => {
    const meta = skillSourceMeta("github", "garrytan/gstack");
    expect(meta.Icon).toBe(Github);
    expect(meta.tone).toBe("slate");
  });

  it("flags skills.sh-managed github URLs as skills_sh tone", () => {
    const meta = skillSourceMeta("github", "vercel-labs/skills");
    expect(meta.Icon).toBe(VercelMark);
    expect(meta.tone).toBe("amber");
  });

  it("returns Folder + teal for local", () => {
    const meta = skillSourceMeta("local", null);
    expect(meta.Icon).toBe(Folder);
    expect(meta.tone).toBe("teal");
    expect(meta.label).toBe("Local");
  });

  it("returns Boxes + indigo for paperclip (AoA-managed)", () => {
    const meta = skillSourceMeta("paperclip", null);
    expect(meta.Icon).toBe(Boxes);
    expect(meta.tone).toBe("indigo");
    expect(meta.label).toBe("AoA");
  });

  it("returns Link2 + magenta for url", () => {
    const meta = skillSourceMeta("url", "https://example.com/skill.md");
    expect(meta.Icon).toBe(Link2);
    expect(meta.tone).toBe("magenta");
  });

  it("returns the managedLabel with 'managed' suffix", () => {
    expect(skillSourceMeta("github", "owner/repo").managedLabel).toBe("GitHub managed");
    expect(skillSourceMeta("skills_sh", "skills.sh").managedLabel).toBe("skills.sh managed");
    expect(skillSourceMeta("local", null).managedLabel).toBe("Local skill");
    expect(skillSourceMeta("paperclip", null).managedLabel).toBe("AoA managed");
  });
});
