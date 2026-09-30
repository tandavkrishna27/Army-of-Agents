import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOC = join(__dirname, "../../../docs/paperclip-migration.md");

describe("paperclip-migration.md — annotation deprecation", () => {
  const text = readFileSync(DOC, "utf8");

  it("documents discussion_annotations as a deprecated stub", () => {
    expect(text).toMatch(/discussion_annotations/);
    expect(text.toLowerCase()).toMatch(/deprecated/);
  });

  it("notes the Thread-surface UI removal and the DiscussionDetail follow-up", () => {
    expect(text).toMatch(/EntryRow/);
    expect(text).toMatch(/DiscussionDetail/);
  });
});
