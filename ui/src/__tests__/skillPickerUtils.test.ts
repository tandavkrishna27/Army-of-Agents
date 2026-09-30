import { describe, it, expect } from "vitest";
import type { CompanySkillListItem } from "@armyofagents/shared";
import {
  buildSkillDirective,
  filterSkills,
  matchSlashToken,
} from "../components/commander/skillPickerUtils";

function skill(partial: Partial<CompanySkillListItem>): CompanySkillListItem {
  return {
    id: "id",
    companyId: "c1",
    key: "skill:aoa/example",
    slug: "example",
    name: "Example",
    description: null,
    sourceType: "local_path",
    sourceLocator: null,
    sourceRef: null,
    trustLevel: "markdown_only",
    compatibility: "compatible",
    fileInventory: [],
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    attachedAgentCount: 0,
    editable: false,
    editableReason: null,
    ...partial,
  };
}

describe("filterSkills", () => {
  const skills = [
    skill({ id: "1", name: "Sprint Planner", key: "skill:aoa/sprint" }),
    skill({ id: "2", name: "Brainstorm", key: "skill:aoa/brainstorm" }),
    skill({ id: "3", name: "Code Review", key: "skill:eng/review" }),
  ];

  it("returns all skills for an empty query", () => {
    expect(filterSkills(skills, "")).toHaveLength(3);
  });

  it("returns all skills for a whitespace-only query", () => {
    expect(filterSkills(skills, "   ")).toHaveLength(3);
  });

  it("matches on name (case-insensitive)", () => {
    const r = filterSkills(skills, "SPRINT");
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe("1");
  });

  it("matches on key (case-insensitive)", () => {
    const r = filterSkills(skills, "ENG/");
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe("3");
  });

  it("matches substrings anywhere in name or key", () => {
    const r = filterSkills(skills, "brain");
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe("2");
  });

  it("returns empty when nothing matches", () => {
    expect(filterSkills(skills, "zzz")).toHaveLength(0);
  });
});

describe("matchSlashToken", () => {
  it("matches a bare slash at the start", () => {
    expect(matchSlashToken("/")).toEqual({ active: true, query: "", start: 0 });
  });

  it("matches a partial token at the start", () => {
    expect(matchSlashToken("/spr")).toEqual({
      active: true,
      query: "spr",
      start: 0,
    });
  });

  it("matches a slash after whitespace and reports the correct start", () => {
    const m = matchSlashToken("hello /spr");
    expect(m.active).toBe(true);
    expect(m.query).toBe("spr");
    expect(m.start).toBe(6); // index of the "/"
  });

  it("does NOT match a completed token followed by a space", () => {
    expect(matchSlashToken("/foo bar")).toEqual({
      active: false,
      query: "",
      start: -1,
    });
  });

  it("does NOT match a slash that is not at start or after whitespace", () => {
    expect(matchSlashToken("path/to/file")).toEqual({
      active: false,
      query: "",
      start: -1,
    });
  });

  it("does NOT match text with no slash", () => {
    expect(matchSlashToken("just typing")).toEqual({
      active: false,
      query: "",
      start: -1,
    });
  });

  it("reports a start index usable for replacement", () => {
    const text = "do /rev";
    const m = matchSlashToken(text);
    expect(m.start).toBe(3);
    // Splice in a replacement using [start, length)
    expect(text.slice(0, m.start) + "X").toBe("do X");
  });
});

describe("buildSkillDirective", () => {
  it("includes both the name and the exact key", () => {
    expect(
      buildSkillDirective({ name: "Sprint Planner", key: "skill:aoa/sprint" }),
    ).toBe('Use the "Sprint Planner" skill (skill:aoa/sprint).');
  });
});
