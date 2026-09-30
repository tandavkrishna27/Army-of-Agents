import { describe, expect, it } from "vitest";
import {
  SAFE_INLINE_CONTENT_TYPES,
  getSafeServingHeaders,
} from "../services/asset-serving-safety.js";

describe("getSafeServingHeaders — content type classification", () => {
  it("PNG → inline, original Content-Type preserved including parameters", () => {
    const headers = getSafeServingHeaders("image/png", "logo.png");
    expect(headers.contentType).toBe("image/png");
    expect(headers.contentDisposition).toMatch(/^inline;/);
    expect(headers.contentDisposition).toContain('filename="logo.png"');
    expect(headers.xContentTypeOptions).toBe("nosniff");
  });

  it("JPEG with charset param → still inline, original parameters preserved", () => {
    const headers = getSafeServingHeaders("image/jpeg; charset=binary", "photo.jpg");
    expect(headers.contentType).toBe("image/jpeg; charset=binary");
    expect(headers.contentDisposition).toMatch(/^inline;/);
  });

  it("PDF → inline", () => {
    const headers = getSafeServingHeaders("application/pdf", "doc.pdf");
    expect(headers.contentDisposition).toMatch(/^inline;/);
  });

  it("text/plain, text/markdown, application/json → inline", () => {
    expect(getSafeServingHeaders("text/plain", "a.txt").contentDisposition).toMatch(/^inline;/);
    expect(getSafeServingHeaders("text/markdown", "a.md").contentDisposition).toMatch(/^inline;/);
    expect(getSafeServingHeaders("application/json", "a.json").contentDisposition).toMatch(/^inline;/);
  });

  it("non-executable audio/video media → inline", () => {
    expect(getSafeServingHeaders("video/mp4", "demo.mp4").contentDisposition).toMatch(/^inline;/);
    expect(getSafeServingHeaders("video/webm", "demo.webm").contentDisposition).toMatch(/^inline;/);
    expect(getSafeServingHeaders("video/quicktime", "demo.mov").contentDisposition).toMatch(/^inline;/);
    expect(getSafeServingHeaders("audio/mpeg", "voice.mp3").contentDisposition).toMatch(/^inline;/);
    expect(getSafeServingHeaders("audio/webm", "voice.webm").contentDisposition).toMatch(/^inline;/);
  });

  it("text/html, application/javascript, text/css → attachment", () => {
    expect(getSafeServingHeaders("text/html", "a.html").contentDisposition).toMatch(/^attachment;/);
    expect(getSafeServingHeaders("application/javascript", "a.js").contentDisposition).toMatch(/^attachment;/);
    expect(getSafeServingHeaders("text/css", "a.css").contentDisposition).toMatch(/^attachment;/);
  });

  it("image/svg+xml → attachment (SVG can carry script)", () => {
    const headers = getSafeServingHeaders("image/svg+xml", "icon.svg");
    expect(headers.contentDisposition).toMatch(/^attachment;/);
    expect(headers.xContentTypeOptions).toBe("nosniff");
  });

  it("application/octet-stream → attachment", () => {
    const headers = getSafeServingHeaders("application/octet-stream", "blob.bin");
    expect(headers.contentDisposition).toMatch(/^attachment;/);
  });

  it("null/empty/undefined Content-Type → fallback application/octet-stream + attachment", () => {
    const fromNull = getSafeServingHeaders(null, "x.bin");
    expect(fromNull.contentType).toBe("application/octet-stream");
    expect(fromNull.contentDisposition).toMatch(/^attachment;/);

    const fromUndefined = getSafeServingHeaders(undefined, "x.bin");
    expect(fromUndefined.contentType).toBe("application/octet-stream");
    expect(fromUndefined.contentDisposition).toMatch(/^attachment;/);

    const fromEmpty = getSafeServingHeaders("", "x.bin");
    expect(fromEmpty.contentType).toBe("application/octet-stream");
    expect(fromEmpty.contentDisposition).toMatch(/^attachment;/);

    const fromWhitespace = getSafeServingHeaders("   ", "x.bin");
    expect(fromWhitespace.contentType).toBe("application/octet-stream");
    expect(fromWhitespace.contentDisposition).toMatch(/^attachment;/);
  });

  it("filename with CR/LF/quotes/backslashes is sanitised — no header injection", () => {
    // Per spec: `evil"\r\nX-Inject: 1` must not produce a header containing real CR/LF.
    const evil = 'evil"\r\nX-Inject: 1';
    const headers = getSafeServingHeaders("application/pdf", evil);
    expect(headers.contentDisposition).not.toContain("\r");
    expect(headers.contentDisposition).not.toContain("\n");
    // The literal substring "evil" before the quote is fine to remain — what matters
    // is that the quote/CR/LF are gone so no new header line can be injected.
    expect(headers.contentDisposition).not.toContain('"\r');
    expect(headers.contentDisposition).not.toContain('"\n');

    const withBackslash = getSafeServingHeaders("application/pdf", 'a\\b"c.pdf');
    // Backslash and the inner quote must be stripped from the ASCII filename portion.
    const ascii = withBackslash.contentDisposition.match(/filename="([^"]*)"/)?.[1] ?? "";
    expect(ascii).not.toContain("\\");
    expect(ascii).not.toContain('"');
  });

  it("empty filename → 'download' fallback", () => {
    const fromEmpty = getSafeServingHeaders("application/pdf", "");
    expect(fromEmpty.contentDisposition).toContain('filename="download"');

    const fromNull = getSafeServingHeaders("application/pdf", null);
    expect(fromNull.contentDisposition).toContain('filename="download"');

    const fromUndefined = getSafeServingHeaders("application/pdf", undefined);
    expect(fromUndefined.contentDisposition).toContain('filename="download"');

    // Filename of only-CR/LF/quotes/backslashes after stripping is empty → fallback.
    const fromAllStripped = getSafeServingHeaders("application/pdf", '"\\\r\n');
    expect(fromAllStripped.contentDisposition).toContain('filename="download"');
  });

  it("non-ASCII filename → ASCII fallback + filename* RFC 5987 percent-encoded", () => {
    const headers = getSafeServingHeaders("application/pdf", "résumé.pdf");
    // Must include ASCII fallback (legacy clients).
    expect(headers.contentDisposition).toMatch(/filename="[^"]*"/);
    // Must include RFC 5987 form for modern clients.
    expect(headers.contentDisposition).toContain("filename*=UTF-8''");
    expect(headers.contentDisposition).toContain("r%C3%A9sum%C3%A9.pdf");
    // ASCII fallback must not contain raw non-ASCII bytes.
    const asciiFilenameMatch = headers.contentDisposition.match(/filename="([^"]*)"/);
    expect(asciiFilenameMatch).not.toBeNull();
    const asciiFilename = asciiFilenameMatch![1];
    for (const ch of asciiFilename) {
      expect(ch.charCodeAt(0)).toBeLessThan(0x80);
    }
  });

  it("case-insensitive content-type matching: IMAGE/PNG → inline", () => {
    expect(getSafeServingHeaders("IMAGE/PNG", "x.png").contentDisposition).toMatch(/^inline;/);
    expect(getSafeServingHeaders("Application/PDF", "x.pdf").contentDisposition).toMatch(/^inline;/);
    expect(getSafeServingHeaders("Image/SVG+XML", "x.svg").contentDisposition).toMatch(/^attachment;/);
  });
});

describe("SAFE_INLINE_CONTENT_TYPES", () => {
  it("contains exactly the documented allowlist", () => {
    expect(SAFE_INLINE_CONTENT_TYPES.has("image/png")).toBe(true);
    expect(SAFE_INLINE_CONTENT_TYPES.has("image/jpeg")).toBe(true);
    expect(SAFE_INLINE_CONTENT_TYPES.has("image/jpg")).toBe(true);
    expect(SAFE_INLINE_CONTENT_TYPES.has("image/webp")).toBe(true);
    expect(SAFE_INLINE_CONTENT_TYPES.has("image/gif")).toBe(true);
    expect(SAFE_INLINE_CONTENT_TYPES.has("application/pdf")).toBe(true);
    expect(SAFE_INLINE_CONTENT_TYPES.has("text/plain")).toBe(true);
    expect(SAFE_INLINE_CONTENT_TYPES.has("text/markdown")).toBe(true);
    expect(SAFE_INLINE_CONTENT_TYPES.has("application/json")).toBe(true);
    expect(SAFE_INLINE_CONTENT_TYPES.has("video/mp4")).toBe(true);
    expect(SAFE_INLINE_CONTENT_TYPES.has("video/webm")).toBe(true);
    expect(SAFE_INLINE_CONTENT_TYPES.has("video/quicktime")).toBe(true);
    expect(SAFE_INLINE_CONTENT_TYPES.has("audio/mpeg")).toBe(true);
    expect(SAFE_INLINE_CONTENT_TYPES.has("audio/webm")).toBe(true);
    // Negative — SVG must NOT be in the allowlist.
    expect(SAFE_INLINE_CONTENT_TYPES.has("image/svg+xml")).toBe(false);
    expect(SAFE_INLINE_CONTENT_TYPES.has("text/html")).toBe(false);
    expect(SAFE_INLINE_CONTENT_TYPES.has("application/javascript")).toBe(false);
  });
});
