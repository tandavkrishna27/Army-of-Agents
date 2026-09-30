import { describe, it, expect } from "vitest";
import {
  splitSections,
  computeSectionDiff,
  applyMergeDecisions,
  mergeSkillDocument,
} from "../services/marketplace-merge.js";

describe("splitSections", () => {
  it("returns a preamble section for content before first ##", () => {
    const md = "intro text\n## Section A\ncontent A";
    const sections = splitSections(md);
    expect(sections[0].header).toBe("__preamble__");
    expect(sections[0].content).toBe("intro text");
    expect(sections[1].header).toBe("Section A");
  });

  it("returns ALL sections including duplicates", () => {
    const md = "## Examples\nfirst\n## Examples\nsecond";
    const sections = splitSections(md);
    expect(sections).toHaveLength(3); // preamble + 2 × Examples
    expect(sections[1].header).toBe("Examples");
    expect(sections[2].header).toBe("Examples");
  });

  it("returns single preamble when no ## headers", () => {
    const md = "just text here";
    const sections = splitSections(md);
    expect(sections).toHaveLength(1);
    expect(sections[0].header).toBe("__preamble__");
  });

  it("keeps headings inside fenced code blocks in their parent section", () => {
    const md = [
      "## Instructions",
      "before",
      "```md",
      "## Example",
      "inside",
      "```",
      "## Next",
      "after",
    ].join("\n");

    const sections = splitSections(md);

    expect(sections.map((section) => section.header)).toEqual([
      "__preamble__",
      "Instructions",
      "Next",
    ]);
    expect(sections[1].content).toContain("## Example");
    expect(sections[1].content.match(/```/g)).toHaveLength(2);
  });

  it("requires a same-marker closing fence at least as long as the opener", () => {
    const md = [
      "## Instructions",
      "~~~~",
      "~~~",
      "```",
      "## Still code",
      "~~~~",
      "## Next",
      "after",
    ].join("\n");

    expect(splitSections(md).map((section) => section.header)).toEqual([
      "__preamble__",
      "Instructions",
      "Next",
    ]);
  });

  it("does not treat a four-space-indented delimiter as a fence", () => {
    const md = [
      "    ```",
      "indented code",
      "## Real section",
      "body",
    ].join("\n");

    expect(splitSections(md).map((section) => section.header)).toEqual([
      "__preamble__",
      "Real section",
    ]);
  });
});

describe("computeSectionDiff — unique headers", () => {
  it("marks unchanged sections correctly", () => {
    const mine = "## Overview\nSame text";
    const theirs = "## Overview\nSame text";
    const diff = computeSectionDiff(mine, theirs);
    const overview = diff.find((d) => d.header === "Overview" || d.header.startsWith("Overview"));
    expect(overview?.state).toBe("unchanged");
  });

  it("marks changed sections correctly", () => {
    const mine = "## Overview\nOld text";
    const theirs = "## Overview\nNew text";
    const diff = computeSectionDiff(mine, theirs);
    const overview = diff.find((d) => d.header === "Overview" || d.header.startsWith("Overview"));
    expect(overview?.state).toBe("changed");
    expect(overview?.mine).toContain("Old text");
    expect(overview?.theirs).toContain("New text");
  });

  it("marks added sections (in theirs but not mine)", () => {
    const mine = "## Overview\ntext";
    const theirs = "## Overview\ntext\n## Usage\nnew section";
    const diff = computeSectionDiff(mine, theirs);
    const usage = diff.find((d) => d.header === "Usage" || d.header.startsWith("Usage"));
    expect(usage?.state).toBe("added");
  });

  it("marks removed sections (in mine but not theirs)", () => {
    const mine = "## Overview\ntext\n## Deprecated\nold stuff";
    const theirs = "## Overview\ntext";
    const diff = computeSectionDiff(mine, theirs);
    const deprecated = diff.find((d) => d.header === "Deprecated" || d.header.startsWith("Deprecated"));
    expect(deprecated?.state).toBe("removed");
  });
});

describe("computeSectionDiff — duplicate headers (the bug)", () => {
  it("preserves BOTH sections when mine has two sections with the same header", () => {
    const mine = "## Examples\nfirst example\n## Examples\nsecond example";
    const theirs = "## Examples\nfirst example\n## Examples\nthird example";
    const diff = computeSectionDiff(mine, theirs);

    // Should have 3 entries: preamble (unchanged/added) + Examples + Examples [2]
    // The first Examples should be unchanged, the second should be changed
    const exampleDiffs = diff.filter((d) => d.header.startsWith("Examples"));
    expect(exampleDiffs).toHaveLength(2);

    const first = exampleDiffs[0];
    const second = exampleDiffs[1];

    expect(first.state).toBe("unchanged");
    expect(second.state).toBe("changed");
    expect(second.mine).toContain("second example");
    expect(second.theirs).toContain("third example");
  });

  it("does NOT drop the first section when theirs has a single version of a duplicate header", () => {
    // mine has two ## Examples; theirs has one. First should match, second should be "removed".
    const mine = "## Examples\nfirst\n## Examples\nsecond";
    const theirs = "## Examples\nfirst";
    const diff = computeSectionDiff(mine, theirs);

    // preamble diff + Examples (unchanged) + Examples [2] (removed)
    const exampleDiffs = diff.filter((d) => d.header.startsWith("Examples"));
    expect(exampleDiffs).toHaveLength(2);
    expect(exampleDiffs[0].state).toBe("unchanged");
    expect(exampleDiffs[1].state).toBe("removed");
  });
});

describe("applyMergeDecisions", () => {
  it("keeps mine when decision is 'mine'", () => {
    const mine = "## Overview\nmy content";
    const theirs = "## Overview\ntheir content";
    const diff = computeSectionDiff(mine, theirs);
    const result = applyMergeDecisions(diff, { Overview: "mine" });
    expect(result).toContain("my content");
    expect(result).not.toContain("their content");
  });

  it("keeps theirs when decision is 'theirs'", () => {
    const mine = "## Overview\nmy content";
    const theirs = "## Overview\ntheir content";
    const diff = computeSectionDiff(mine, theirs);
    const result = applyMergeDecisions(diff, { Overview: "theirs" });
    expect(result).toContain("their content");
    expect(result).not.toContain("my content");
  });

  it("honors an explicit theirs decision for a trim-equal unchanged section", () => {
    const mine = "## Overview\nSame words.  \n";
    const theirs = "## Overview\nSame words.\n";
    const diff = computeSectionDiff(mine, theirs);
    expect(diff.find((section) => section.header === "Overview")?.state).toBe("unchanged");

    expect(applyMergeDecisions(diff, { Overview: "theirs" })).toBe(theirs);
  });

  it("keeps a mixed merge's fenced block balanced", () => {
    const mine = [
      "## Instructions",
      "```md",
      "plain code",
      "```",
      "## Tail",
      "mine tail",
    ].join("\n");
    const theirs = [
      "## Instructions",
      "```md",
      "## Example",
      "upstream code",
      "```",
      "## Tail",
      "upstream tail",
    ].join("\n");
    const diff = computeSectionDiff(mine, theirs);

    const result = applyMergeDecisions(diff, {
      Instructions: "theirs",
      Example: "mine",
      Tail: "mine",
    });

    expect(result).toContain("## Example");
    expect(result.match(/```/g)).toHaveLength(2);
    expect(result).toContain("mine tail");
  });

  it("preserves CRLF throughout a mixed merge", () => {
    const mine = "# Skill\r\n\r\n## Overview\r\nold\r\n\r\n## Notes\r\nmine\r\n";
    const theirs = "# Skill\r\n\r\n## Overview\r\nnew\r\n\r\n## Notes\r\ntheirs\r\n";
    const diff = computeSectionDiff(mine, theirs);

    const result = applyMergeDecisions(diff, { Overview: "theirs", Notes: "mine" });

    expect(result).toContain("new");
    expect(result).toContain("mine");
    expect(result).not.toMatch(/(?<!\r)\n/);
    expect(result.endsWith("\r\n")).toBe(true);
  });

  it("preserves CRLF when merge decisions drop every section", () => {
    const mine = "## Only\r\nfounder\r\n";
    const diff = computeSectionDiff(mine, "");

    expect(applyMergeDecisions(diff, { Only: "theirs" })).toBe("\r\n");
  });

  it("keeps the existing LF mixed-merge bytes unchanged", () => {
    const mine = "# Skill\n\n## Overview\nold\n\n## Notes\nmine\n";
    const theirs = "# Skill\n\n## Overview\nnew\n\n## Notes\ntheirs\n";
    const diff = computeSectionDiff(mine, theirs);

    expect(applyMergeDecisions(diff, { Overview: "theirs", Notes: "mine" })).toBe(
      "# Skill\n\n\n## Overview\nnew\n\n\n## Notes\nmine\n",
    );
  });
});

describe("mergeSkillDocument", () => {
  it("writes the upstream document verbatim when every section resolves upstream", () => {
    const mine = "# Skill\r\n\r\n## Overview\r\n\r\nFounder copy.\r\n";
    const upstream = "# Skill\r\n\r\n## Overview\r\n\r\nUpstream copy.\r\n";
    const diff = computeSectionDiff(mine, upstream);
    const decisions = Object.fromEntries(
      diff.map((section) => [section.header, "theirs" as const]),
    );

    expect(mergeSkillDocument(diff, decisions, upstream, mine)).toEqual({
      content: upstream,
      pureUpstream: true,
    });
  });

  it("keeps customized true when any changed section resolves to mine", () => {
    const mine = "# Skill\n\n## Overview\n\nFounder copy.\n";
    const upstream = "# Skill\n\n## Overview\n\nUpstream copy.\n";
    const diff = computeSectionDiff(mine, upstream);

    const result = mergeSkillDocument(diff, { Overview: "mine" }, upstream, mine);

    expect(result.pureUpstream).toBe(false);
    expect(result.content).toContain("Founder copy.");
  });

  it("does not call trim-equal unchanged bytes pure upstream", () => {
    const mine = "# Skill\n\n## Overview\n\nSame words.  \n";
    const upstream = "# Skill\n\n## Overview\n\nSame words.\n";
    const diff = computeSectionDiff(mine, upstream);
    expect(diff.every((section) => section.state === "unchanged")).toBe(true);

    const result = mergeSkillDocument(diff, {}, upstream, mine);

    expect(result.pureUpstream).toBe(false);
    expect(result.content).not.toBe(upstream);
  });

  it("returns trim-equal upstream bytes verbatim when all sections choose theirs", () => {
    const mine = "# Skill\n\n## Overview\n\nSame words.  \n";
    const upstream = "# Skill\n\n## Overview\n\nSame words.\n";
    const diff = computeSectionDiff(mine, upstream);
    expect(diff.every((section) => section.state === "unchanged")).toBe(true);
    const decisions = Object.fromEntries(
      diff.map((section) => [section.header, "theirs" as const]),
    );

    expect(mergeSkillDocument(diff, decisions, upstream, mine)).toEqual({
      content: upstream,
      pureUpstream: true,
    });
  });

  it("is pure upstream only when added sections are accepted and removed sections are dropped", () => {
    const mine = "## Local\nfounder-only\n";
    const upstream = "## Added\nupstream-only\n";
    const diff = computeSectionDiff(mine, upstream);

    expect(mergeSkillDocument(diff, {}, upstream, mine).pureUpstream).toBe(false);
    expect(
      mergeSkillDocument(diff, { Local: "theirs", Added: "theirs" }, upstream, mine),
    ).toEqual({
      content: upstream,
      pureUpstream: true,
    });
  });

  it("does not overwrite a founder-reordered document whose sections are individually unchanged", () => {
    const mine = "## Second\nsame second\n## First\nsame first\n";
    const upstream = "## First\nsame first\n## Second\nsame second\n";
    const diff = computeSectionDiff(mine, upstream);
    expect(diff.every((section) => section.state === "unchanged")).toBe(true);

    const result = mergeSkillDocument(diff, {}, upstream, mine);

    expect(result.pureUpstream).toBe(false);
    expect(result.content.indexOf("## Second")).toBeLessThan(result.content.indexOf("## First"));
  });

  it("returns reordered upstream bytes verbatim when all sections choose theirs", () => {
    const mine = "## Second\nsame second\n## First\nsame first\n";
    const upstream = "## First\nsame first\n## Second\nsame second\n";
    const diff = computeSectionDiff(mine, upstream);
    expect(diff.every((section) => section.state === "unchanged")).toBe(true);
    const decisions = Object.fromEntries(
      diff.map((section) => [section.header, "theirs" as const]),
    );

    expect(mergeSkillDocument(diff, decisions, upstream, mine)).toEqual({
      content: upstream,
      pureUpstream: true,
    });
  });

  it("does not erase an LF/CRLF-only difference at a section boundary", () => {
    const mine = "## First\r\n## Second";
    const upstream = "## First\n## Second";
    const diff = computeSectionDiff(mine, upstream);
    expect(diff.every((section) => section.state === "unchanged")).toBe(true);

    const result = mergeSkillDocument(diff, {}, upstream, mine);

    expect(result.pureUpstream).toBe(false);
  });

  it("derives upstream parity from the bytes emitted by the merge", () => {
    const mine = "## A\nx";
    const upstream = "## A\nx\n";
    const diff = computeSectionDiff(mine, upstream);
    expect(diff.every((section) => section.state === "unchanged")).toBe(true);

    expect(mergeSkillDocument(diff, {}, upstream, mine)).toEqual({
      content: upstream,
      pureUpstream: true,
    });
  });
});

describe("applyMergeDecisions — section ordering (A-M15)", () => {
  // Helper: extract the ## section headers from a merged markdown doc, in order.
  const headerOrder = (md: string): string[] =>
    md
      .split("\n")
      .filter((line) => line.startsWith("## "))
      .map((line) => line.slice(3).trim());

  it("preserves user section order when upstream drops a middle section (B removed)", () => {
    // mine = [A, B, C]; theirs = [A, C] (B removed upstream).
    // B is a user-retained section (defaults to 'mine'/kept) and must stay in its
    // original slot — output must be A, B, C, NOT A, C, B.
    const mine = "## A\nbody a\n## B\nbody b\n## C\nbody c";
    const theirs = "## A\nbody a\n## C\nbody c";
    const diff = computeSectionDiff(mine, theirs);
    const merged = applyMergeDecisions(diff, {});
    expect(headerOrder(merged)).toEqual(["A", "B", "C"]);
  });

  it("places an upstream-added section at its anchor relative to surviving neighbors", () => {
    // mine = [A, C]; theirs = [A, D, C] (D added upstream between A and C).
    // D should land between A and C → output A, D, C.
    const mine = "## A\nbody a\n## C\nbody c";
    const theirs = "## A\nbody a\n## D\nbody d\n## C\nbody c";
    const diff = computeSectionDiff(mine, theirs);
    const merged = applyMergeDecisions(diff, {});
    expect(headerOrder(merged)).toEqual(["A", "D", "C"]);
  });
});
