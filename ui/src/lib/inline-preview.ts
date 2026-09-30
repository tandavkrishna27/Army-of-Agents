// Shared inline-preview eligibility for attachment cards. Pure fns, no React.
export function normalizeMime(contentType: string | null): string | null {
  if (!contentType) return null;
  const base = contentType.split(";")[0]!.trim().toLowerCase();
  return base || null;
}
export const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const INLINE_TEXT_MAX_BYTES = 256 * 1024;

/** Raster image safe to render inline as <img> (matches server inline allowlist). */
export function isInlineImage(contentType: string | null): boolean {
  const ct = normalizeMime(contentType);
  return ct != null && INLINE_IMAGE_TYPES.has(ct);
}

/**
 * Whether an attachment should AUTO-render inline in a discussion/timeline feed card.
 *
 * This is deliberately NARROWER than what `SharedContentViewer` can render, and the gap
 * is intentional — do not widen it to "everything the viewer supports". An inline card is
 * a lightweight, auto-rendered feed surface (capped at ~18rem, no user click), so it only
 * auto-previews content that is cheap, self-contained, and safe to render unprompted:
 *   - raster images (rendered as <img>), and
 *   - small (<=256KB) text-family content: text/* (markdown, csv->table, mermaid, code…)
 *     and application/json.
 *
 * Intentionally EXCLUDED even though the viewer renders them on click-through:
 *   - text/html and image/svg+xml — SharedContentViewer renders these in an iframe with
 *     `sandbox="allow-scripts"` (SharedContentViewer.tsx). Auto-executing scripts from an
 *     arbitrary uploaded file the moment a feed card scrolls into view is not acceptable;
 *     these open in the full viewer on an explicit click instead.
 *   - application/pdf and Office (docx/xlsx) — heavy (pdfjs worker / server render round-trip);
 *     open on click.
 *   - text/json over 256KB — performance in a feed of cards.
 * `isInlinePreviewable.test.ts` pins these exclusions so a future widening fails loudly.
 */
export function isInlinePreviewable(contentType: string | null, byteSize: number | null): boolean {
  const ct = normalizeMime(contentType);
  if (!ct) return false;
  if (INLINE_IMAGE_TYPES.has(ct)) return true;
  const isText = (ct.startsWith("text/") && ct !== "text/html") || ct === "application/json";
  if (isText) return byteSize != null && byteSize <= INLINE_TEXT_MAX_BYTES;
  return false;
}
