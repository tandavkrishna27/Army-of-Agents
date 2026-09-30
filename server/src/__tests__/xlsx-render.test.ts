import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { renderXlsxBufferToSafeHtml, DEFAULT_XLSX_LIMITS } from "../services/xlsx-render.js";
import {
  OFFICE_RENDER_MAX_BYTES,
  OfficeRenderTooLargeError,
} from "../services/office-render-limits.js";

// Unlike DOCX (where mammoth cannot emit scripts, so the XSS suite mocks it),
// exceljs faithfully round-trips whatever we put in a cell — including
// script-like text and `javascript:` hyperlinks. So we build REAL workbooks and
// drive the REAL render+sanitize path with hostile data. DOMPurify runs for real.
async function buildXlsx(build: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  // writeBuffer() returns a Node Buffer at runtime; exceljs types it as its own
  // ArrayBuffer-ish Buffer, hence the cast.
  return (await wb.xlsx.writeBuffer()) as unknown as Buffer;
}

describe("renderXlsxBufferToSafeHtml — XLSX render + sanitize", () => {
  it("wraps output and renders a table per sheet with an ESCAPED sheet name", async () => {
    const buf = await buildXlsx((wb) => {
      const ws = wb.addWorksheet("Sales<script>");
      ws.getCell("A1").value = "Region";
      ws.getCell("B1").value = "Total";
      ws.getCell("A2").value = "West";
      ws.getCell("B2").value = 1200;
    });
    const html = await renderXlsxBufferToSafeHtml(buf);
    expect(html).toMatch(/^<div class="xlsx-rendered">/);
    expect(html).toMatch(/<\/div>$/);
    expect(html).toContain("<table>");
    // The sheet name is escaped — a `<script>` in a sheet name is not a live tag.
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("Sales&lt;script&gt;");
    expect(html).toContain("Region");
    expect(html).toContain("West");
    expect(html).toContain("1200");
  });

  it("renders the COMPUTED formula result, never the formula source", async () => {
    const buf = await buildXlsx((wb) => {
      const ws = wb.addWorksheet("F");
      ws.getCell("A1").value = { formula: "1+2", result: 3 };
    });
    const html = await renderXlsxBufferToSafeHtml(buf);
    expect(html).toContain(">3<"); // the cached result is rendered
    expect(html).not.toContain("1+2"); // the formula SOURCE is never emitted
  });

  // Per-cell escaping: hostile cell TEXT never becomes live markup. Includes
  // out-of-FORBID payloads (<svg onload>, <base href>, onmouseenter) — asserted
  // as "no live tag", because escaping renders them as inert entity-escaped text.
  it("escapes hostile cell text so no live markup is produced (default-deny by escaping)", async () => {
    const buf = await buildXlsx((wb) => {
      const ws = wb.addWorksheet("X");
      ws.getCell("A1").value = "<script>alert(1)</script>";
      ws.getCell("A2").value = "<img src=x onerror=alert(1)>"; // FORBID_ATTR handler
      ws.getCell("A3").value = "<svg onload=alert(1)></svg>"; // out-of-FORBID handler
      ws.getCell("A4").value = '<base href="http://evil.example/">'; // out-of-FORBID tag
      ws.getCell("A5").value = "<b onmouseenter=alert(1)>x</b>"; // out-of-FORBID handler
    });
    const html = await renderXlsxBufferToSafeHtml(buf);
    // No live opening tag from any cell value survives.
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<svg/i);
    expect(html).not.toMatch(/<base/i);
    // …but the content is still shown, entity-escaped (no data loss).
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;svg onload=alert(1)&gt;");
  });

  // DISCRIMINATOR: the DOMPurify URI allow-list (the SHARED office config) drops
  // dangerous hyperlink schemes and keeps benign ones. A `javascript:` href is a
  // live attribute reaching DOMPurify — remove the sanitizeOfficeHtml call and
  // these assertions fail, proving the assembled HTML really passes through it.
  it("neutralizes hostile hyperlink hrefs and preserves benign ones", async () => {
    const buf = await buildXlsx((wb) => {
      const ws = wb.addWorksheet("L");
      ws.getCell("A1").value = { text: "js", hyperlink: "javascript:alert(1)" };
      ws.getCell("A2").value = { text: "vb", hyperlink: "vbscript:msgbox(1)" }; // out-of-FORBID scheme
      ws.getCell("A3").value = { text: "d", hyperlink: "data:text/html,<script>alert(1)</script>" };
      ws.getCell("A4").value = { text: "safe", hyperlink: "https://example.com" };
      ws.getCell("A5").value = { text: "mail", hyperlink: "mailto:a@b.com" };
    });
    const html = await renderXlsxBufferToSafeHtml(buf);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/vbscript:/i);
    expect(html).not.toMatch(/data:text\/html/i);
    // Benign links survive with their href intact.
    expect(html).toMatch(/href="https:\/\/example\.com"/);
    expect(html).toMatch(/href="mailto:a@b\.com"/);
    // Display labels are still present.
    expect(html).toContain(">safe<");
  });

  // A hyperlink whose display label carries character formatting (a partly-bold
  // link — a routine Excel construct) makes exceljs return `cell.text` as a
  // rich-text OBJECT, not a string. Escaping that object directly threw
  // `TypeError: value.replace is not a function` → 500. The render must flatten
  // the rich text to a plain string first: no throw, the label text is shown, and
  // the <a href> still renders. (Ablation: fails against the pre-fix code.)
  it("flattens a rich-text hyperlink label instead of throwing (F1)", async () => {
    const buf = await buildXlsx((wb) => {
      const ws = wb.addWorksheet("RT");
      ws.getCell("A1").value = {
        text: { richText: [{ font: { bold: true }, text: "Click " }, { text: "here" }] },
        hyperlink: "https://ok.example",
      };
    });
    // Must resolve (not reject with a TypeError) …
    const html = await renderXlsxBufferToSafeHtml(buf);
    // … with the rich-text runs flattened into the visible label …
    expect(html).toContain("Click here");
    // … and the anchor still rendered with its benign href intact.
    expect(html).toMatch(/href="https:\/\/ok\.example"/);
  });

  // A rich-text (non-hyperlink) cell — a cell with mixed formatting — also makes
  // `cell.text` an object; the catch-all path must flatten it too, not throw.
  it("flattens a rich-text non-hyperlink cell in the catch-all path (F1)", async () => {
    const buf = await buildXlsx((wb) => {
      const ws = wb.addWorksheet("RT2");
      ws.getCell("A1").value = {
        richText: [{ font: { bold: true }, text: "Bold " }, { text: "plain" }],
      };
    });
    const html = await renderXlsxBufferToSafeHtml(buf);
    expect(html).toContain("Bold plain");
  });

  it("escapes an attribute-breakout attempt inside a hyperlink href", async () => {
    const buf = await buildXlsx((wb) => {
      const ws = wb.addWorksheet("B");
      ws.getCell("A1").value = { text: "x", hyperlink: 'https://ok.example" onmouseover="alert(1)' };
    });
    const html = await renderXlsxBufferToSafeHtml(buf);
    // The breakout double-quote is escaped, so a standalone onmouseover attribute
    // is never formed (the raw, unescaped sequence must not appear).
    expect(html).not.toContain('ok.example" onmouseover');
  });

  it("caps rows at the limit and shows a LOUD truncation notice (no silent drop)", async () => {
    const buf = await buildXlsx((wb) => {
      const ws = wb.addWorksheet("Big");
      for (let r = 1; r <= 5; r++) ws.getCell(`A${r}`).value = `ROW_${r}`;
    });
    const html = await renderXlsxBufferToSafeHtml(buf, { maxSheets: 12, maxRows: 3, maxCols: 50 });
    expect(html).toContain("Showing first 3 of 5 rows — download to see the full sheet.");
    // Rows within the cap are present…
    expect(html).toContain("ROW_3");
    // …and the rows PAST the cap are absent (truncated, not partially rendered).
    expect(html).not.toContain("ROW_4");
    expect(html).not.toContain("ROW_5");
  });

  it("caps columns at the limit and notes the truncation", async () => {
    const buf = await buildXlsx((wb) => {
      const ws = wb.addWorksheet("Wide");
      ws.getCell("A1").value = "C1";
      ws.getCell("B1").value = "C2";
      ws.getCell("C1").value = "C3_GONE";
      ws.getCell("D1").value = "C4_GONE";
    });
    const html = await renderXlsxBufferToSafeHtml(buf, { maxSheets: 12, maxRows: 1000, maxCols: 2 });
    expect(html).toContain("Showing first 2 of 4 columns — download to see the full sheet.");
    expect(html).toContain("C2");
    expect(html).not.toContain("C3_GONE");
    expect(html).not.toContain("C4_GONE");
  });

  it("caps sheets and notes the truncation (workbook wording)", async () => {
    const buf = await buildXlsx((wb) => {
      for (let i = 1; i <= 4; i++) {
        const ws = wb.addWorksheet(`S${i}`);
        ws.getCell("A1").value = `SHEET_${i}`;
      }
    });
    const html = await renderXlsxBufferToSafeHtml(buf, { maxSheets: 2, maxRows: 1000, maxCols: 50 });
    expect(html).toContain("Showing first 2 of 4 sheets — download to see the full workbook.");
    expect(html).toContain("SHEET_2");
    expect(html).not.toContain("SHEET_3");
    expect(html).not.toContain("SHEET_4");
  });

  it("shows NO truncation notice when nothing is truncated (default limits)", async () => {
    const buf = await buildXlsx((wb) => {
      const ws = wb.addWorksheet("Small");
      ws.getCell("A1").value = "only";
    });
    const html = await renderXlsxBufferToSafeHtml(buf);
    expect(html).not.toContain("Showing first");
  });

  it("pins the production caps so a regression to a huge/tiny cap fails loudly", () => {
    expect(DEFAULT_XLSX_LIMITS.maxRows).toBe(1000);
    expect(DEFAULT_XLSX_LIMITS.maxCols).toBe(50);
    expect(DEFAULT_XLSX_LIMITS.maxSheets).toBe(12);
  });

  // Resource-exhaustion guard: a buffer over the render cap is refused BEFORE
  // exceljs parses it. The guard throws OfficeRenderTooLargeError specifically
  // (a corrupt/oversized buffer reaching exceljs would throw a different error),
  // so this proves the size check fires first — no unbounded parse.
  it("refuses a buffer over the render input cap without parsing (OfficeRenderTooLargeError)", async () => {
    const oversized = Buffer.alloc(OFFICE_RENDER_MAX_BYTES + 1);
    await expect(renderXlsxBufferToSafeHtml(oversized)).rejects.toBeInstanceOf(
      OfficeRenderTooLargeError,
    );
  });

  it("renders an empty sheet with a note instead of a broken table", async () => {
    const buf = await buildXlsx((wb) => {
      wb.addWorksheet("Empty");
    });
    const html = await renderXlsxBufferToSafeHtml(buf);
    expect(html).toContain("This sheet is empty.");
    expect(html).not.toContain("<table>");
  });
});
