import { describe, expect, it } from "vitest";
import { deriveDiscussionTitle, displayDiscussionTitle } from "../discussion-title.js";

describe("discussion title helpers", () => {
  it("preserves a nonblank explicit title after trimming", () => {
    expect(deriveDiscussionTitle("  Planning notes  ", "Ignored opening content")).toBe("Planning notes");
  });

  it("derives the title from the first non-empty opening-content line", () => {
    expect(deriveDiscussionTitle(null, "  \n  Launch   the new   portal  \nAdditional details"))
      .toBe("Launch the new portal");
  });

  it("limits a derived title to 80 Unicode code points including the ellipsis", () => {
    expect(deriveDiscussionTitle(undefined, `${"🚀".repeat(81)}\nMore details`))
      .toBe(`${"🚀".repeat(79)}…`);
  });

  it.each([undefined, null, "", "  \n \t "]) (
    "uses the fallback for unusable title and opening content (%s)",
    (content) => {
      expect(deriveDiscussionTitle("  ", content)).toBe("Untitled discussion");
    },
  );

  it.each([undefined, null, "", "   "]) (
    "provides a display fallback for legacy null or blank titles (%s)",
    (title) => {
      expect(displayDiscussionTitle(title)).toBe("Untitled discussion");
    },
  );
});
