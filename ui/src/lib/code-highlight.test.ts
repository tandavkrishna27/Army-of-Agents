import { describe, expect, it } from "vitest";
import { escapeHtml, highlightToHtml, languageForFilename } from "./code-highlight";

describe("highlightToHtml", () => {
  it("wraps a JavaScript keyword in an hljs-keyword token span", () => {
    const { html, language } = highlightToHtml("const x = 1;", "javascript");
    // The discriminator vs a plain <pre>: a real token class appears.
    expect(html).toContain('<span class="hljs-keyword">const</span>');
    expect(language).toBe("javascript");
  });

  it("resolves the js alias (registered grammar aliases work)", () => {
    const { html } = highlightToHtml("let y = 2;", "js");
    expect(html).toContain("hljs-keyword");
  });

  it("escapes HTML in the source so the output is XSS-safe", () => {
    const { html } = highlightToHtml("<script>alert(1)</script>", "javascript");
    // The original angle brackets are entity-escaped; no live tag survives.
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("</script>");
  });

  it("degrades an explicit unknown language to escaped plain text without throwing", () => {
    let result: ReturnType<typeof highlightToHtml> | undefined;
    expect(() => {
      result = highlightToHtml("<b>plain & simple</b>", "cobol-9000");
    }).not.toThrow();
    expect(result!.language).toBeNull();
    // No highlight spans; just entity-escaped text.
    expect(result!.html).toBe("&lt;b&gt;plain &amp; simple&lt;/b&gt;");
    expect(result!.html).not.toContain("hljs-");
  });

  it("renders escaped plain text when no language is given (no auto-detect)", () => {
    // An absent language must NOT be auto-detected/tokenized — a plain note
    // stays plain. It is escaped, and carries no hljs-* token spans.
    const { html, language } = highlightToHtml("def greet(): return 1 & <x>\n");
    expect(html).not.toContain("hljs-");
    expect(html).toContain("&amp;");
    expect(html).toContain("&lt;x&gt;");
    expect(language).toBeNull();
  });

  it("never throws and escapes even for empty / odd input", () => {
    expect(() => highlightToHtml("", "javascript")).not.toThrow();
    expect(highlightToHtml("a < b && c > d", "definitely-not-a-language").html).not.toContain("<b");
  });
});

describe("languageForFilename", () => {
  it("maps common extensions to highlight.js language ids", () => {
    expect(languageForFilename("app.ts")).toBe("typescript");
    expect(languageForFilename("Component.tsx")).toBe("typescript");
    expect(languageForFilename("index.js")).toBe("javascript");
    expect(languageForFilename("view.jsx")).toBe("javascript");
    expect(languageForFilename("main.py")).toBe("python");
    expect(languageForFilename("data.json")).toBe("json");
    expect(languageForFilename("page.html")).toBe("xml");
    expect(languageForFilename("styles.scss")).toBe("scss");
    expect(languageForFilename("run.sh")).toBe("bash");
    expect(languageForFilename("main.rs")).toBe("rust");
  });

  it("recognises a bare Dockerfile and .dockerfile", () => {
    expect(languageForFilename("Dockerfile")).toBe("dockerfile");
    expect(languageForFilename("web.dockerfile")).toBe("dockerfile");
  });

  it("returns undefined for unknown, plain, and missing filenames", () => {
    expect(languageForFilename("notes.txt")).toBeUndefined();
    expect(languageForFilename("archive.zip")).toBeUndefined();
    expect(languageForFilename("noext")).toBeUndefined();
    expect(languageForFilename(undefined)).toBeUndefined();
    expect(languageForFilename(null)).toBeUndefined();
    expect(languageForFilename("")).toBeUndefined();
  });
});

describe("escapeHtml", () => {
  it("escapes the five significant HTML characters", () => {
    expect(escapeHtml(`<a href="x">& '</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp; &#39;&lt;/a&gt;",
    );
  });
});
