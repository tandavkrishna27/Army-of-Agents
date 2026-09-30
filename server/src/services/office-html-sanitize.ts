import DOMPurify from "isomorphic-dompurify";

/**
 * SECURITY — the single shared sanitize config for ALL server-side office→HTML
 * renders (DOCX via mammoth, XLSX via exceljs). Read this before touching it.
 *
 * The safety of every office render comes from DOMPurify's DEFAULT allow-list,
 * NOT from the FORBID_* lists below. DOMPurify v3 is allow-list-by-default: when
 * no `ALLOWED_TAGS`/`ALLOWED_ATTR` are passed, only a known-safe set of tags and
 * attributes survives and everything else is dropped — scripts, ALL event
 * handlers (not just the five named below), `javascript:`/`vbscript:` URLs,
 * `<base>`, `<meta>`, `<svg onload>`, unknown/custom elements, and so on. The
 * `FORBID_TAGS`/`FORBID_ATTR` lists only SUBTRACT from that default; they are
 * cosmetic defense-in-depth, NOT the security boundary — removing them would not
 * meaningfully change what gets through.
 *
 * Therefore:
 *  - Do NOT add `ADD_TAGS` / `ADD_ATTR` here. That REOPENS the allow-list and can
 *    let active content through. This is the one change that can turn a safe
 *    render into an XSS sink.
 *  - Do NOT treat "add one more entry to FORBID_*" as how you close a hole — the
 *    default allow-list already closes it; a new tag/attr is denied unless you
 *    explicitly allow it.
 *  - Both the DOCX and XLSX helpers MUST import THIS one config so the two
 *    surfaces cannot silently drift in security posture. If they each inlined a
 *    copy, one could be hardened and the other forgotten.
 *
 * The XSS suites (`docx-render.test.ts`, `xlsx-render.test.ts`, plus the
 * route-level `asset-render-xss` / `memory-asset-render-xss`) pin this by
 * feeding payloads that are NOT in the FORBID_* lists and asserting they are
 * still neutralized — proving the default allow-list is the real boundary.
 */
export const OFFICE_SANITIZE_CONFIG = {
  ALLOWED_URI_REGEXP: /^(?:https?|mailto|tel|#)/i,
  FORBID_TAGS: ["script", "iframe", "object", "embed", "form"],
  FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus"],
};

/**
 * Sanitize assembled office HTML with the shared allow-list-by-default config.
 * Returns a string of already-safe HTML for injection via
 * `dangerouslySetInnerHTML` on the client.
 */
export function sanitizeOfficeHtml(html: string): string {
  return DOMPurify.sanitize(html, OFFICE_SANITIZE_CONFIG);
}
