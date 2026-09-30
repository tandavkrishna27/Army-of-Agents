/**
 * Robust RFC-4180-style delimited-text parser for the shared content table viewer.
 *
 * The previous implementation was a naive `content.split(/\r?\n/).map(l => l.split(","))`,
 * which breaks on quoted fields, commas inside quotes, newlines inside quotes, and
 * escaped quotes. This parser handles all of those correctly.
 *
 * Behaviour notes:
 * - The delimiter is supplied by the caller (the viewer registry resolves `.csv` -> `,`
 *   and `.tsv` -> `\t`). It is NOT sniffed from the content, so a valid CSV whose first
 *   line happens to contain unquoted tabs is never misparsed.
 * - A leading UTF-8 BOM is stripped once before parsing, so the first header cell is
 *   never polluted by an invisible zero-width character (even when it is quoted).
 * - The first row is the header; the table renderer treats `rows[0]` as `<th>`.
 * - Ragged rows are returned verbatim (no padding to the header width) so the renderer
 *   keeps its existing per-row cell mapping.
 * - Fully-blank physical lines are dropped (a single empty field) to avoid ghost rows,
 *   preserving the old "skip blank lines" behaviour. Empty input therefore yields `[]`,
 *   which the viewer uses to fall back to the raw source view.
 * - Unquoted fields are trimmed for display; quoted fields are preserved verbatim
 *   (leading/trailing whitespace, embedded delimiters, and newlines are kept).
 * - An unterminated quote degrades sanely: the remaining text becomes the final field.
 */

/** Parse delimited text into rows of cells using a single-pass RFC-4180 state machine. */
export function parseDelimited(content: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  let quoted = false; // whether the current field was opened with a quote
  let dirty = false; // whether any character has been consumed for the current record

  const endField = () => {
    record.push(quoted ? field : field.trim());
    field = "";
    quoted = false;
  };
  const endRecord = () => {
    endField();
    rows.push(record);
    record = [];
    dirty = false;
  };

  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];

    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          field += '"'; // escaped quote: "" -> "
          i += 1;
        } else {
          inQuotes = false; // closing quote
        }
      } else {
        field += ch; // delimiters and newlines are literal inside quotes
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      quoted = true;
      dirty = true;
      continue;
    }
    if (ch === delimiter) {
      endField();
      dirty = true;
      continue;
    }
    if (ch === "\r") {
      if (content[i + 1] === "\n") i += 1; // CRLF
      endRecord();
      continue;
    }
    if (ch === "\n") {
      endRecord();
      continue;
    }
    field += ch;
    dirty = true;
  }

  // Flush a trailing record only when there is pending content. A file ending in a
  // newline has `dirty === false` here, so no spurious empty final row is produced.
  if (dirty || field.length > 0 || record.length > 0) {
    endRecord();
  }

  return rows;
}

/** Remove a single leading UTF-8 BOM (U+FEFF) if present. */
function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

/**
 * Parse CSV/TSV content into rows of cells. The first row is the header. The delimiter
 * is caller-supplied (defaults to comma). Blank physical lines are dropped so the table
 * has no empty ghost rows.
 */
export function parseCsv(content: string, delimiter: string = ","): string[][] {
  const rows = parseDelimited(stripBom(content), delimiter);
  return rows.filter((row) => !(row.length === 1 && row[0] === ""));
}
