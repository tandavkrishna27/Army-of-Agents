import ExcelJS from "exceljs";
import type { Cell, Worksheet } from "exceljs";
import { sanitizeOfficeHtml } from "./office-html-sanitize.js";
import { assertOfficeRenderSize } from "./office-render-limits.js";

/** OOXML spreadsheet MIME. The only type the XLSX render path converts. */
export const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Output caps for the XLSX render — REQUIRED and LOUD.
 *
 * A worksheet can hold ~1,048,576 rows × 16,384 columns. Emitting that as one
 * HTML table would blow the response size and OOM the browser, so we cap the
 * OUTPUT and, whenever we truncate, emit a VISIBLE notice ("Showing first N of M
 * …") per the "no silent caps" rule — rows/columns/sheets are never dropped
 * silently. We iterate row/column INDICES up to the cap (via getRow/getCell)
 * rather than eachRow, so a 100k-row sheet only ever materializes ~cap cells of
 * output — it does not walk every row.
 *
 * Note on INPUT: `workbook.xlsx.load(buffer)` still parses the whole workbook
 * into memory (same as mammoth for DOCX). That input is bounded by
 * `assertOfficeRenderSize` (OFFICE_RENDER_MAX_BYTES — see office-render-limits.ts),
 * which refuses an oversized buffer BEFORE the parse; these caps bound the
 * OUTPUT HTML. Raw bytes above the render cap are still downloadable via /content.
 */
export interface XlsxRenderLimits {
  /** Max worksheets rendered; extra sheets are noted, not dropped. */
  maxSheets: number;
  /** Max rows rendered per sheet. */
  maxRows: number;
  /** Max columns rendered per sheet. */
  maxCols: number;
}

export const DEFAULT_XLSX_LIMITS: XlsxRenderLimits = {
  maxSheets: 12,
  maxRows: 1000,
  maxCols: 50,
};

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * HTML-escape one string for both text and attribute contexts. Every
 * user-controlled value (cell text, sheet name, hyperlink href) is escaped here
 * as the table is assembled — we never string-concatenate raw cell content into
 * the markup. The assembled HTML is ALSO run through the shared DOMPurify config
 * (defense in depth), so a cell that looks like markup or a `javascript:` URL is
 * neutralized twice over.
 */
function esc(value: string): string {
  // Coerce at the boundary (S2): every caller already passes a string via
  // cellPlainText/String(), but a future exceljs value shape must never be able
  // to reach `.replace` on a non-string and 500 the render — fail safe to text.
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] as string);
}

/**
 * Flatten a cell's display value to a plain string.
 *
 * exceljs types `cell.text` as `string`, but at RUNTIME it returns a rich-text
 * OBJECT (`{ richText: [{ text }, …] }`) whenever the cell's display value
 * carries character formatting — e.g. a hyperlink whose label is partly bold, a
 * routine Excel construct. Escaping that object directly threw
 * `TypeError: value.replace is not a function` → a 500 on a common spreadsheet.
 * Concatenate the rich-text runs into one string so both the hyperlink-label and
 * the catch-all paths always hand `esc` a string.
 */
function cellPlainText(cell: Cell): string {
  const t = cell.text as unknown;
  if (typeof t === "string") return t;
  if (t && typeof t === "object" && "richText" in t) {
    return ((t as { richText?: Array<{ text?: unknown }> }).richText ?? [])
      .map((r) => String(r?.text ?? ""))
      .join("");
  }
  return t == null ? "" : String(t);
}

/**
 * One cell → an escaped HTML fragment.
 *
 *  - Formula cells render their COMPUTED result via `cell.text` (exceljs returns
 *    the cached result string, "" when there is no cached result) — the formula
 *    SOURCE is never emitted.
 *  - Hyperlink cells ({ text, hyperlink }) render as an <a href>; the shared
 *    ALLOWED_URI_REGEXP drops `javascript:`/`vbscript:` and other non-web
 *    schemes, so a hostile href never survives sanitize.
 *  - Dates render as a deterministic ISO string (cell.text for a date is a
 *    locale/timezone-dependent JS toString — unstable across machines).
 *  - Everything else (string/number/boolean/error/rich text) uses the computed
 *    display text.
 */
function cellToHtml(cell: Cell): string {
  const value = cell.value;

  // Hyperlink cell. Render an anchor; DOMPurify's URI allow-list validates the
  // scheme. cell.text is the display label (never includes the href).
  if (
    value !== null &&
    typeof value === "object" &&
    !(value instanceof Date) &&
    "hyperlink" in value
  ) {
    const href = String((value as { hyperlink?: unknown }).hyperlink ?? "");
    const label = cellPlainText(cell) || href;
    return `<a href="${esc(href)}">${esc(label)}</a>`;
  }

  // Date: deterministic ISO rather than the locale/timezone toString.
  if (value instanceof Date) {
    return esc(value.toISOString());
  }

  // String / number / boolean / error / rich text / formula RESULT.
  return esc(cellPlainText(cell));
}

function truncationNote(shown: number, total: number, unit: "rows" | "columns" | "sheets"): string {
  const target = unit === "sheets" ? "workbook" : "sheet";
  return `<p class="xlsx-truncation-note">Showing first ${shown} of ${total} ${unit} — download to see the full ${target}.</p>`;
}

function renderSheet(sheet: Worksheet, limits: XlsxRenderLimits): string {
  const totalRows = sheet.rowCount;
  const totalCols = sheet.columnCount;
  const shownRows = Math.min(totalRows, limits.maxRows);
  const shownCols = Math.min(totalCols, limits.maxCols);

  const parts: string[] = [];
  parts.push(`<section class="xlsx-sheet">`);
  parts.push(`<h3 class="xlsx-sheet-name">${esc(sheet.name)}</h3>`);

  if (totalRows === 0 || totalCols === 0) {
    parts.push(`<p class="xlsx-empty-sheet">This sheet is empty.</p>`);
    parts.push(`</section>`);
    return parts.join("");
  }

  parts.push(`<table><tbody>`);
  for (let r = 1; r <= shownRows; r++) {
    const row = sheet.getRow(r);
    const cells: string[] = [];
    for (let c = 1; c <= shownCols; c++) {
      cells.push(`<td>${cellToHtml(row.getCell(c))}</td>`);
    }
    parts.push(`<tr>${cells.join("")}</tr>`);
  }
  parts.push(`</tbody></table>`);

  // Truncation notices are LOUD and appear right under the truncated table.
  if (shownCols < totalCols) parts.push(truncationNote(shownCols, totalCols, "columns"));
  if (shownRows < totalRows) parts.push(truncationNote(shownRows, totalRows, "rows"));

  parts.push(`</section>`);
  return parts.join("");
}

/**
 * Convert an XLSX buffer to sanitized, embeddable HTML
 * (`<div class="xlsx-rendered">…</div>`), one <table> per worksheet with a sheet
 * heading. Mirrors the DOCX render path: build → sanitize (SHARED config) → wrap.
 * See the SECURITY invariant in office-html-sanitize.ts — the SAME DOMPurify
 * config sanitizes DOCX and XLSX so the two surfaces cannot drift.
 */
export async function renderXlsxBufferToSafeHtml(
  buffer: Buffer,
  limits: XlsxRenderLimits = DEFAULT_XLSX_LIMITS,
): Promise<string> {
  // Bound the parse INPUT before exceljs loads the whole workbook into memory
  // (resource-exhaustion guard — see office-render-limits.ts). A modest on-disk
  // OOXML zip can expand into millions of in-memory cells; the output caps below
  // only bound the emitted HTML, not the parse. Throws OfficeRenderTooLargeError,
  // which the routes map to 413.
  assertOfficeRenderSize(buffer.length);

  const workbook = new ExcelJS.Workbook();
  // exceljs's bundled types declare load(buffer: <its own Buffer extends
  // ArrayBuffer>), which a Node Buffer is not structurally assignable to (its
  // slice() returns a Uint8Array-view, not an ArrayBuffer). exceljs handles a
  // real Node Buffer fine at runtime, so cast to its declared param type.
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);

  const sheets = workbook.worksheets;
  const shownSheets = Math.min(sheets.length, limits.maxSheets);

  const body: string[] = [];
  for (let i = 0; i < shownSheets; i++) {
    body.push(renderSheet(sheets[i] as Worksheet, limits));
  }
  if (shownSheets < sheets.length) {
    body.push(truncationNote(shownSheets, sheets.length, "sheets"));
  }

  const sanitized = sanitizeOfficeHtml(body.join(""));
  return `<div class="xlsx-rendered">${sanitized}</div>`;
}
