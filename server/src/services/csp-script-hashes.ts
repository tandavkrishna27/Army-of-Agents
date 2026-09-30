import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";

// Matches a `<script ...>...</script>` block and captures the inner text.
// Crucially we then check whether the opening tag has an `src=` attribute —
// if it does, the tag is loading an external script and we skip it (its
// hash is not the right thing to authorize; the URL is).
//
// We use a non-greedy `[\s\S]*?` between the opening tag and the closing
// `</script>` to capture inline bodies that span multiple lines.
//
// The regex uses `gi` flags: global to capture every script, case-insensitive
// because HTML tag names are case-insensitive (browsers accept `<SCRIPT>`).
const SCRIPT_TAG_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const SRC_ATTR_RE = /\bsrc\s*=/i;

/**
 * Read an HTML file and return base64-encoded SHA-256 hashes of every inline
 * `<script>` block. External scripts (those with `src=`) are skipped.
 *
 * The hashes are formatted to drop into a CSP `script-src 'sha256-<value>'`
 * directive. Browsers compute the hash over the script text after the HTML
 * parser has normalized CRLF and bare CR line endings to LF. We preserve all
 * other whitespace verbatim, but must perform the same newline normalization
 * here or a bundle built on Windows will receive an unusable CSP hash.
 *
 * Failure modes return `[]` rather than throwing:
 * - Missing file → `[]` plus a warn log. Caller (helmet config) decides
 *   whether to error out or continue with a "no inline scripts" CSP.
 * - Read errors → `[]` plus a warn log.
 *
 * Robust to but does not require a full HTML parser. We don't handle script
 * blocks inside HTML comments — Vite's bootloader is a single non-commented
 * inline block, so this is sufficient for the AoA build output.
 */
export async function extractInlineScriptHashes(htmlPath: string): Promise<string[]> {
  let html: string;
  try {
    html = await fs.readFile(htmlPath, "utf8");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[csp] could not read HTML file at ${htmlPath} for inline-script hash extraction:`,
      err instanceof Error ? err.message : err,
    );
    return [];
  }

  if (!html) {
    return [];
  }

  const hashes: string[] = [];
  for (const match of html.matchAll(SCRIPT_TAG_RE)) {
    const attrs = match[1] ?? "";
    const body = match[2] ?? "";
    if (SRC_ATTR_RE.test(attrs)) {
      // External script — its hash isn't the thing to authorize.
      continue;
    }
    if (body.length === 0) {
      // Empty inline script — skip (no hash to compute, browser would not
      // execute anything).
      continue;
    }
    const browserScriptText = body.replace(/\r\n?/g, "\n");
    const hash = createHash("sha256")
      .update(browserScriptText, "utf8")
      .digest("base64");
    hashes.push(hash);
  }

  return hashes;
}
