import { describe, expect, it } from "vitest";
import {
  parseCoordinationSections,
  replaceAutoSection,
  type CoordinationSection,
} from "../services/coordination-parser.js";

describe("parseCoordinationSections", () => {
  it("returns one user-section for plain markdown without markers", () => {
    const md = "# Mission\nWe build things.";
    const sections = parseCoordinationSections(md);
    expect(sections).toEqual([
      { kind: "user", content: "# Mission\nWe build things." },
    ]);
  });

  it("extracts a single auto section with name", () => {
    const md = `## Mission
prose

<!-- begin:auto:members -->
## Members
- alice
<!-- end:auto:members -->

## End
final prose`;
    const sections = parseCoordinationSections(md);
    expect(sections).toHaveLength(3);
    expect(sections[0].kind).toBe("user");
    expect(sections[1]).toEqual({
      kind: "auto",
      name: "members",
      content: "## Members\n- alice",
    });
    expect(sections[2].kind).toBe("user");
  });

  it("extracts multiple auto sections", () => {
    const md = `prose1
<!-- begin:auto:members -->
A
<!-- end:auto:members -->
prose2
<!-- begin:auto:routing -->
B
<!-- end:auto:routing -->
prose3`;
    const sections = parseCoordinationSections(md);
    const names = sections
      .filter((s) => s.kind === "auto")
      .map((s) => (s as CoordinationSection & { kind: "auto" }).name);
    expect(names).toEqual(["members", "routing"]);
  });

  it("rejects nested markers", () => {
    const md = `<!-- begin:auto:outer -->
<!-- begin:auto:inner -->
x
<!-- end:auto:inner -->
<!-- end:auto:outer -->`;
    expect(() => parseCoordinationSections(md)).toThrow(/nested/i);
  });

  it("rejects unmatched opening marker", () => {
    const md = `<!-- begin:auto:members -->\n# x\n`;
    expect(() => parseCoordinationSections(md)).toThrow(/unmatched/i);
  });

  it("preserves whitespace inside user sections", () => {
    const md = "  leading\nspace\n";
    const sections = parseCoordinationSections(md);
    expect(sections[0]).toEqual({ kind: "user", content: "  leading\nspace" });
  });
});

describe("replaceAutoSection", () => {
  it("replaces matching auto section content, preserves user sections", () => {
    const md = `## Mission
prose

<!-- begin:auto:members -->
old members
<!-- end:auto:members -->

## End`;
    const result = replaceAutoSection(md, "members", "## Members\n- bob\n- eve");
    expect(result).toContain("## Members\n- bob\n- eve");
    expect(result).not.toContain("old members");
    expect(result).toContain("## Mission");
    expect(result).toContain("prose");
    expect(result).toContain("## End");
  });

  it("appends a new auto section when name missing", () => {
    const md = "## Mission\nprose";
    const result = replaceAutoSection(md, "members", "list");
    expect(result).toContain("<!-- begin:auto:members -->");
    expect(result).toContain("list");
    expect(result).toContain("<!-- end:auto:members -->");
    expect(result).toContain("## Mission");
    expect(result).toContain("prose");
  });

  it("only replaces the named section, not others", () => {
    const md = `<!-- begin:auto:members -->
A
<!-- end:auto:members -->
<!-- begin:auto:routing -->
B
<!-- end:auto:routing -->`;
    const result = replaceAutoSection(md, "members", "NEW_A");
    expect(result).toContain("NEW_A");
    expect(result).toContain("B");
    // Should not contain the literal "\nA\n" anymore
    expect(result).not.toMatch(/begin:auto:members\s*-->\s*\nA\s*\n\s*<!--/);
  });
});
