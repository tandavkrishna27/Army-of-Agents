import { describe, it, expect } from "vitest";
import { isInlinePreviewable, isInlineImage } from "./inline-preview.js";

describe("isInlinePreviewable", () => {
  it("raster images + small text inline; svg(+params)/pdf/zip/unknown-size-text not", () => {
    expect(isInlinePreviewable("image/png", 9e9)).toBe(true);
    expect(isInlinePreviewable("IMAGE/PNG", 10)).toBe(true);
    expect(isInlinePreviewable("image/svg+xml; charset=utf-8", 10)).toBe(false);
    expect(isInlinePreviewable("text/markdown", 1000)).toBe(true);
    expect(isInlinePreviewable("text/plain", 300 * 1024)).toBe(false);
    expect(isInlinePreviewable("text/plain", null)).toBe(false);
    expect(isInlinePreviewable("application/pdf", 10)).toBe(false);
    expect(isInlinePreviewable("application/zip", 10)).toBe(false);
    expect(isInlinePreviewable("text/html", 1000)).toBe(false);
    expect(isInlinePreviewable("text/html; charset=utf-8", 1000)).toBe(false);
  });

  it("keeps script-capable and heavy types OUT of feed cards even though the full viewer renders them", () => {
    // html + svg render in a `sandbox="allow-scripts"` iframe — must not auto-run in a feed.
    expect(isInlinePreviewable("text/html", 100)).toBe(false);
    expect(isInlinePreviewable("image/svg+xml", 100)).toBe(false);
    // pdf is heavy (pdfjs worker); office is heavy (server render round-trip). Both open on click.
    expect(isInlinePreviewable("application/pdf", 100)).toBe(false);
    expect(
      isInlinePreviewable("application/vnd.openxmlformats-officedocument.wordprocessingml.document", 100),
    ).toBe(false);
    expect(
      isInlinePreviewable("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 100),
    ).toBe(false);
    // ...but cheap text-family content (csv -> table, mermaid, json) DOES preview inline.
    expect(isInlinePreviewable("text/csv", 5000)).toBe(true);
    expect(isInlinePreviewable("application/json", 5000)).toBe(true);
  });
});

describe("isInlineImage", () => {
  it("matches the raster inline allowlist only", () => {
    expect(isInlineImage("image/png")).toBe(true);
    expect(isInlineImage("image/svg+xml")).toBe(false);
    expect(isInlineImage("text/plain")).toBe(false);
  });
});
