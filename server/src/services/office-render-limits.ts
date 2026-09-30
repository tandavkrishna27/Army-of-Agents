// server/src/services/office-render-limits.ts
//
// Input-size guard for the server-side office (DOCX/XLSX) render path.
//
// WHY this exists: `mammoth.convertToHtml({buffer})` and
// `workbook.xlsx.load(buffer)` both parse the ENTIRE file into memory before any
// of our OUTPUT caps (rows/cols/sheets in xlsx-render.ts) apply. The OUTPUT caps
// bound the HTML we emit; they do NOT bound what the parser holds. An OOXML file
// is a zip, so a modest on-disk size can decompress into a very large in-memory
// object model (many millions of cells / a deeply nested document) — a
// resource-exhaustion (DoS) vector even within the 50 MB asset-upload cap.
//
// This guard bounds the INPUT to the render path: any office file above
// OFFICE_RENDER_MAX_BYTES is refused with a typed error BEFORE the parser runs.
// The refusal is honest — the caller falls back to downloading the raw bytes
// (the /content route is uncapped; only inline preview is capped).
//
// Enforced at the render-helper chokepoint (renderDocxBufferToSafeHtml /
// renderXlsxBufferToSafeHtml) so EVERY caller is protected, and additionally
// pre-checked at the route layer against the asset's recorded size so an
// oversized file is rejected without fetching+buffering its bytes at all.

/**
 * Max INPUT bytes an office document may have to be server-rendered inline.
 * Deliberately well below the 50 MB asset-upload cap (AOA_FILE_MAX_BYTES): a
 * document that renders sensibly as a browser preview is small; anything larger
 * is a download, not a preview. Override with AOA_OFFICE_RENDER_MAX_BYTES.
 */
export const OFFICE_RENDER_MAX_BYTES =
  Number(process.env.AOA_OFFICE_RENDER_MAX_BYTES) || 15 * 1024 * 1024;

/**
 * Thrown when an office document exceeds the inline-render input cap. Routes map
 * this to HTTP 413 (Payload Too Large); it must never surface as a 500.
 */
export class OfficeRenderTooLargeError extends Error {
  readonly byteSize: number;
  readonly limit: number;
  constructor(byteSize: number, limit: number) {
    super(
      `Office document is ${byteSize} bytes, over the ${limit}-byte inline-render limit. Download to view the full file.`,
    );
    this.name = "OfficeRenderTooLargeError";
    this.byteSize = byteSize;
    this.limit = limit;
  }
}

/**
 * Throw {@link OfficeRenderTooLargeError} when `byteSize` exceeds `limit`. The
 * comparison is strict `>`, so a file exactly at the limit renders. `limit` is
 * injectable for unit tests; production callers use the default.
 */
export function assertOfficeRenderSize(
  byteSize: number,
  limit: number = OFFICE_RENDER_MAX_BYTES,
): void {
  if (byteSize > limit) {
    throw new OfficeRenderTooLargeError(byteSize, limit);
  }
}
