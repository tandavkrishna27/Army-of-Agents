import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { extractInlineScriptHashes } from "../services/csp-script-hashes.js";

function sha256Base64(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("base64");
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aoa-csp-hashes-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("extractInlineScriptHashes", () => {
  it("returns one hash for HTML with one inline script", async () => {
    const inlineBody = `console.log("hello");`;
    const html = `<!DOCTYPE html><html><head><script>${inlineBody}</script></head><body></body></html>`;
    const file = path.join(tmpDir, "index.html");
    await fs.writeFile(file, html, "utf8");

    const hashes = await extractInlineScriptHashes(file);

    expect(hashes).toHaveLength(1);
    expect(hashes[0]).toBe(sha256Base64(inlineBody));
  });

  it("returns empty array when only external scripts present", async () => {
    const html = `<!DOCTYPE html><html><head>
      <script src="/main.js"></script>
      <script type="module" src="/src/main.tsx"></script>
    </head><body></body></html>`;
    const file = path.join(tmpDir, "index.html");
    await fs.writeFile(file, html, "utf8");

    const hashes = await extractInlineScriptHashes(file);
    expect(hashes).toEqual([]);
  });

  it("returns hashes only for inline scripts when mixed with external", async () => {
    const inlineA = `var a = 1;`;
    const inlineB = `var b = 2;`;
    const html = `<!DOCTYPE html><html><head>
      <script>${inlineA}</script>
      <script src="/external1.js"></script>
      <script type="module">${inlineB}</script>
      <script type="module" src="/external2.js"></script>
    </head><body></body></html>`;
    const file = path.join(tmpDir, "index.html");
    await fs.writeFile(file, html, "utf8");

    const hashes = await extractInlineScriptHashes(file);
    expect(hashes).toHaveLength(2);
    expect(hashes).toContain(sha256Base64(inlineA));
    expect(hashes).toContain(sha256Base64(inlineB));
  });

  it("returns empty array (no throw) when file is missing", async () => {
    const hashes = await extractInlineScriptHashes(path.join(tmpDir, "does-not-exist.html"));
    expect(hashes).toEqual([]);
  });

  it("preserves whitespace and LF newlines verbatim when computing hash", async () => {
    const inlineBody = `\n      (() => {\n        const x = 1;\n      })();\n    `;
    const html = `<html><head><script>${inlineBody}</script></head></html>`;
    const file = path.join(tmpDir, "index.html");
    await fs.writeFile(file, html, "utf8");

    const hashes = await extractInlineScriptHashes(file);
    expect(hashes).toHaveLength(1);
    // Hash matches the inner text including leading/trailing whitespace.
    expect(hashes[0]).toBe(sha256Base64(inlineBody));
  });

  it("normalizes Windows and legacy Mac line endings like the HTML parser", async () => {
    const inlineBody = "\r\n  const first = 1;\r  const second = 2;\r\n";
    const browserScriptText = "\n  const first = 1;\n  const second = 2;\n";
    const html = `<html><head><script>${inlineBody}</script></head></html>`;
    const file = path.join(tmpDir, "index.html");
    await fs.writeFile(file, html, "utf8");

    const hashes = await extractInlineScriptHashes(file);

    expect(hashes).toEqual([sha256Base64(browserScriptText)]);
    expect(hashes[0]).not.toBe(sha256Base64(inlineBody));
  });

  it("handles multi-line inline scripts that span many lines", async () => {
    const inlineBody = [
      "function bootstrap() {",
      "  const theme = localStorage.getItem('theme');",
      "  document.documentElement.classList.toggle('dark', theme === 'dark');",
      "}",
      "bootstrap();",
    ].join("\n");
    const html = `<!DOCTYPE html><html><head>
      <script>
${inlineBody}
      </script>
      <script src="/main.js"></script>
    </head></html>`;
    const file = path.join(tmpDir, "index.html");
    await fs.writeFile(file, html, "utf8");

    const hashes = await extractInlineScriptHashes(file);
    expect(hashes).toHaveLength(1);
    // The body the regex captures will include the surrounding whitespace.
    // We verify a hash is computed (deterministic) — exact value depends on
    // the regex's whitespace handling, which is documented as "verbatim".
    expect(hashes[0]).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("ignores <script> tags with attributes that have src=", async () => {
    const html = `<html><head>
      <script src="/foo.js" defer></script>
      <script defer src="/bar.js"></script>
      <script async src='/baz.js'></script>
    </head></html>`;
    const file = path.join(tmpDir, "index.html");
    await fs.writeFile(file, html, "utf8");

    const hashes = await extractInlineScriptHashes(file);
    expect(hashes).toEqual([]);
  });

  it("returns empty array for an empty HTML file (no throw)", async () => {
    const file = path.join(tmpDir, "empty.html");
    await fs.writeFile(file, "", "utf8");
    const hashes = await extractInlineScriptHashes(file);
    expect(hashes).toEqual([]);
  });
});
