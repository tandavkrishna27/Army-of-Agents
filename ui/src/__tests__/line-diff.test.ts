import { describe, expect, it } from "vitest";
import { diffLines, isDiffEmpty } from "../lib/line-diff.js";

describe("diffLines", () => {
  it("returns empty hunks for identical texts", () => {
    const hunks = diffLines("hello\nworld", "hello\nworld");
    expect(isDiffEmpty(hunks)).toBe(true);
  });

  it("detects a single added line", () => {
    const hunks = diffLines("line1\nline2", "line1\nnew line\nline2");
    expect(isDiffEmpty(hunks)).toBe(false);
    const allLines = hunks.flatMap((h) => h.lines);
    expect(allLines.some((l) => l.type === "added" && l.text === "new line")).toBe(true);
  });

  it("detects a single removed line", () => {
    const hunks = diffLines("line1\nold line\nline2", "line1\nline2");
    const allLines = hunks.flatMap((h) => h.lines);
    expect(allLines.some((l) => l.type === "removed" && l.text === "old line")).toBe(true);
  });

  it("detects a modified line as remove+add", () => {
    const hunks = diffLines("foo", "bar");
    const allLines = hunks.flatMap((h) => h.lines);
    expect(allLines.some((l) => l.type === "removed" && l.text === "foo")).toBe(true);
    expect(allLines.some((l) => l.type === "added" && l.text === "bar")).toBe(true);
  });

  it("includes context lines around changes", () => {
    const old = "a\nb\nc\nd\ne";
    const next = "a\nb\nCHANGED\nd\ne";
    const hunks = diffLines(old, next, 1);
    expect(hunks).toHaveLength(1);
    const types = hunks[0].lines.map((l) => l.type);
    // Should have: context(b), removed(c), added(CHANGED), context(d)
    expect(types.filter((t) => t === "context")).toHaveLength(2);
    expect(types.filter((t) => t === "removed")).toHaveLength(1);
    expect(types.filter((t) => t === "added")).toHaveLength(1);
  });

  it("handles empty old text", () => {
    const hunks = diffLines("", "line1\nline2");
    const allLines = hunks.flatMap((h) => h.lines);
    const added = allLines.filter((l) => l.type === "added");
    expect(added).toHaveLength(2);
  });

  it("handles empty new text", () => {
    const hunks = diffLines("line1\nline2", "");
    const allLines = hunks.flatMap((h) => h.lines);
    const removed = allLines.filter((l) => l.type === "removed");
    expect(removed).toHaveLength(2);
  });

  it("produces two separate hunks when changes are far apart", () => {
    // 10 context lines between changes ensures two hunks with default contextLines=2
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
    const oldText = lines.join("\n");
    const newLines = [...lines];
    newLines[0] = "CHANGED_TOP";
    newLines[19] = "CHANGED_BOTTOM";
    const newText = newLines.join("\n");
    const hunks = diffLines(oldText, newText);
    expect(hunks).toHaveLength(2);
  });
});
