import { describe, it, expect } from "vitest";
import {
  MEMORY_ITEM_STATUSES,
  MEMORY_ITEM_LAYERS,
  MEMORY_ITEM_CATEGORIES,
} from "@armyofagents/shared";
import { STATUS_TONE, LAYER_TONE, CATEGORY_TONE, pickIconKind, pickSnippet, formatRelative } from "../memoryItemView";

describe("memoryItemView tone maps", () => {
  it("STATUS_TONE covers every shared status", () => {
    for (const status of MEMORY_ITEM_STATUSES) {
      expect(STATUS_TONE[status]).toBeDefined();
    }
  });

  it("LAYER_TONE covers every shared layer", () => {
    for (const layer of MEMORY_ITEM_LAYERS) {
      expect(LAYER_TONE[layer]).toBeDefined();
    }
  });

  it("CATEGORY_TONE covers every shared category", () => {
    for (const cat of MEMORY_ITEM_CATEGORIES) {
      expect(CATEGORY_TONE[cat]).toBeDefined();
    }
  });
});

describe("pickIconKind", () => {
  it("returns 'markdown' for memory items", () => {
    expect(pickIconKind({ kind: "memory_item" })).toBe("markdown");
  });
  it("returns 'image' for image mime types", () => {
    expect(pickIconKind({ kind: "asset", mimeType: "image/png" })).toBe("image");
    expect(pickIconKind({ kind: "asset", mimeType: "image/jpeg" })).toBe("image");
  });
  it("returns 'video' for video mime types", () => {
    expect(pickIconKind({ kind: "asset", mimeType: "video/mp4" })).toBe("video");
  });
  it("returns 'pdf' for application/pdf", () => {
    expect(pickIconKind({ kind: "asset", mimeType: "application/pdf" })).toBe("pdf");
  });
  it("returns 'docx' for wordprocessingml mimetypes", () => {
    expect(pickIconKind({ kind: "asset", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })).toBe("docx");
  });
  it("falls back to 'generic' for unknown mime types and missing data", () => {
    expect(pickIconKind({ kind: "asset", mimeType: "application/octet-stream" })).toBe("generic");
    expect(pickIconKind({ kind: "asset" })).toBe("generic");
    expect(pickIconKind({ kind: "asset", mimeType: null })).toBe("generic");
  });
});

describe("pickSnippet", () => {
  it("returns the memory item content trimmed and flattened", () => {
    expect(pickSnippet({ kind: "memory_item", content: "Hello\n\n  world" })).toBe("Hello world");
  });
  it("returns the extracted text for assets", () => {
    expect(pickSnippet({ kind: "asset", extractedText: "Asset preview" })).toBe("Asset preview");
  });
  it("strips markdown emphasis and headings", () => {
    expect(pickSnippet({ kind: "memory_item", content: "## Heading\n\n*emphasis* and `code`" })).toBe("Heading emphasis and code");
  });
  it("collapses [text](url) link syntax to just the text", () => {
    expect(pickSnippet({ kind: "memory_item", content: "See [the docs](https://example.com) for more" })).toBe("See the docs for more");
  });
  it("truncates strings longer than 200 chars with an ellipsis", () => {
    const long = "a".repeat(500);
    const out = pickSnippet({ kind: "memory_item", content: long });
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith("…")).toBe(true);
  });
  it("returns empty string when content is missing", () => {
    expect(pickSnippet({ kind: "memory_item" })).toBe("");
    expect(pickSnippet({ kind: "memory_item", content: null })).toBe("");
    expect(pickSnippet({ kind: "asset" })).toBe("");
  });
});

describe("formatRelative", () => {
  const NOW = Date.now();
  function ago(ms: number): string {
    return new Date(NOW - ms).toISOString();
  }
  it("returns 'today' for less than 1 day", () => {
    expect(formatRelative(ago(60_000))).toBe("today");
    expect(formatRelative(ago(0))).toBe("today");
  });
  it("returns Nd for 1-6 days", () => {
    expect(formatRelative(ago(2 * 86_400_000))).toBe("2d");
    expect(formatRelative(ago(6 * 86_400_000))).toBe("6d");
  });
  it("returns Nw for 7-29 days", () => {
    expect(formatRelative(ago(14 * 86_400_000))).toBe("2w");
  });
  it("returns Nmo for 30-364 days", () => {
    expect(formatRelative(ago(60 * 86_400_000))).toBe("2mo");
  });
  it("returns Ny for 365+ days", () => {
    expect(formatRelative(ago(800 * 86_400_000))).toBe("2y");
  });
  it("returns 'recently' for invalid date strings", () => {
    expect(formatRelative("not-a-date")).toBe("recently");
  });
});
