import mammoth from "mammoth";
import { sanitizeOfficeHtml } from "./office-html-sanitize.js";
import { assertOfficeRenderSize } from "./office-render-limits.js";

/** OOXML Word document MIME. The only type the DOCX render path converts. */
export const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/**
 * Convert a DOCX buffer to sanitized, embeddable HTML (`<article
 * class="docx-rendered">…</article>`). This is the SINGLE source of the DOCX
 * render+sanitize used by BOTH server render routes — the generic
 * `/assets/:id/render` and the memory-scoped `/memory/assets/:id/render`. Keep
 * it that way: the routes differ only in asset lookup + authorization; the
 * convert+sanitize+wrap must not be duplicated, or the two surfaces can silently
 * drift in security posture.
 *
 * SECURITY: the convert output is sanitized by the SHARED `sanitizeOfficeHtml`
 * helper (server/src/services/office-html-sanitize.ts) — the ONE DOMPurify
 * allow-list-by-default config shared with the XLSX render path, so DOCX and
 * XLSX cannot drift in security posture. The full invariant (why the DEFAULT
 * allow-list is the real boundary and the FORBID_* lists are only cosmetic
 * defense-in-depth, and why you must NEVER add ADD_TAGS/ADD_ATTR) lives in that
 * module's docblock. The XSS suites (`docx-render.test.ts`, plus the route-level
 * `asset-render-xss` / `memory-asset-render-xss`) pin it by feeding payloads that
 * are NOT in the FORBID_* lists and asserting they are still neutralized.
 */
export async function renderDocxBufferToSafeHtml(buffer: Buffer): Promise<string> {
  // Bound the parse INPUT before mammoth loads the whole document into memory
  // (resource-exhaustion guard — see office-render-limits.ts). Throws
  // OfficeRenderTooLargeError, which the routes map to 413.
  assertOfficeRenderSize(buffer.length);
  const result = await mammoth.convertToHtml({ buffer });
  const sanitized = sanitizeOfficeHtml(result.value);
  return `<article class="docx-rendered">${sanitized}</article>`;
}
