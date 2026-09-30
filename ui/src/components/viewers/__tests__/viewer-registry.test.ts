import { resolveViewer } from "../viewer-registry";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

describe("resolveViewer", () => {
  it("detects markdown, json, csv, media, pdf, sandbox markup, mermaid, canvas, and downloads", () => {
    expect(resolveViewer({ contentType: "text/markdown", filename: "note.md", assetId: "a" }).kind).toBe("markdown");
    expect(resolveViewer({ contentType: "application/json", filename: "data.json", assetId: "a" }).kind).toBe("json");
    expect(resolveViewer({ contentType: "text/csv", filename: "data.csv", assetId: "a" }).kind).toBe("table");
    expect(resolveViewer({ contentType: "image/png", filename: "image.png", assetId: "a" }).kind).toBe("image");
    expect(resolveViewer({ contentType: "video/mp4", filename: "video.mp4", assetId: "a" }).kind).toBe("video");
    expect(resolveViewer({ contentType: "audio/webm", filename: "audio.webm", assetId: "a" }).kind).toBe("audio");
    expect(resolveViewer({ contentType: "application/pdf", filename: "report.pdf", assetId: "a" }).kind).toBe("pdf");
    expect(resolveViewer({ contentType: "text/html", filename: "page.html", assetId: "a" }).kind).toBe("html_sandbox");
    expect(resolveViewer({ contentType: "image/svg+xml", filename: "diagram.svg", assetId: "a" }).kind).toBe("svg_sandbox");
    expect(resolveViewer({ contentType: "text/plain", filename: "diagram.mmd", assetId: "a" }).kind).toBe("mermaid");
    expect(resolveViewer({ contentType: "application/json", filename: "flow.aoa-canvas.json", assetId: "a" }).kind).toBe("canvas");
    expect(resolveViewer({ contentType: "application/zip", filename: "bundle.zip", assetId: "a" }).kind).toBe("download");
  });

  // Text-like source files that aren't one of the special text kinds (markdown,
  // csv/tsv, json, mermaid, sandboxed markup) fall through to the `code` viewer,
  // which highlight.js renders. Covers the MIME branch (text/*, application/js|ts)
  // and the extension branch (TEXT_EXTENSIONS) of `isTextLike`.
  it("resolves generic text-like source files (by MIME or extension) to the code kind", () => {
    expect(resolveViewer({ contentType: "text/x-python", filename: "script.py", assetId: "a" }).kind).toBe("code");
    expect(resolveViewer({ contentType: "application/javascript", filename: "app.js", assetId: "a" }).kind).toBe("code");
    // Extension alone (generic/unknown content type) still routes a source ext to code.
    expect(resolveViewer({ contentType: "application/octet-stream", filename: "main.ts", assetId: "a" }).kind).toBe("code");
  });

  it("routes CSV and TSV to the table kind with the correct known delimiter (no sniffing)", () => {
    const csv = resolveViewer({ contentType: "text/csv", filename: "data.csv", assetId: "a" });
    expect(csv.kind).toBe("table");
    expect(csv.delimiter).toBe(",");

    const tsvByType = resolveViewer({ contentType: "text/tab-separated-values", filename: "data.tsv", assetId: "a" });
    expect(tsvByType.kind).toBe("table");
    expect(tsvByType.delimiter).toBe("\t");

    // Extension alone (generic content type) still routes TSV correctly.
    const tsvByExt = resolveViewer({ contentType: "application/octet-stream", filename: "data.tsv", assetId: "a" });
    expect(tsvByExt.kind).toBe("table");
    expect(tsvByExt.delimiter).toBe("\t");
  });

  // P3.3 de-silo. Ablation: before the registry change, DOCX (MIME or .docx)
  // matched no branch and fell to `download`; asserting `docx` here failed.
  it("resolves DOCX by MIME to the docx kind with a generic render URL", () => {
    const byMime = resolveViewer({ contentType: DOCX_MIME, filename: "report.docx", assetId: "asset-9" });
    expect(byMime.kind).toBe("docx");
    expect(byMime.renderUrl).toBe("/api/assets/asset-9/render");
    // The raw-bytes URL is still the /content route (Download / open-externally).
    expect(byMime.assetUrl).toBe("/api/assets/asset-9/content");
    // A server-rendered office doc is not text-fetched by the shared viewer.
    expect(byMime.requiresTextFetch).toBe(false);
  });

  it("resolves a .docx extension (generic content type) to the docx kind", () => {
    const byExt = resolveViewer({ contentType: "application/octet-stream", filename: "report.docx", assetId: "asset-9" });
    expect(byExt.kind).toBe("docx");
    expect(byExt.renderUrl).toBe("/api/assets/asset-9/render");
  });

  it("falls back to download for DOCX when no assetId is available to build the render URL", () => {
    // Without an assetId the generic /render URL cannot be constructed, so the
    // honest result is a download card rather than a broken preview.
    const noAsset = resolveViewer({ contentType: DOCX_MIME, filename: "report.docx", assetUrl: "/blob/x" });
    expect(noAsset.kind).toBe("download");
  });

  // P3.4 XLSX server render. Ablation: before the registry change, an XLSX MIME
  // (or .xlsx) matched no branch and fell to `download`; asserting `xlsx` failed.
  it("resolves XLSX by MIME to the xlsx kind with a generic render URL", () => {
    const byMime = resolveViewer({ contentType: XLSX_MIME, filename: "sheet.xlsx", assetId: "asset-7" });
    expect(byMime.kind).toBe("xlsx");
    expect(byMime.renderUrl).toBe("/api/assets/asset-7/render");
    // The raw-bytes URL stays the /content route (Download / open-externally).
    expect(byMime.assetUrl).toBe("/api/assets/asset-7/content");
    // A server-rendered spreadsheet is not text-fetched by the shared viewer.
    expect(byMime.requiresTextFetch).toBe(false);
  });

  it("resolves a .xlsx extension (generic content type) to the xlsx kind", () => {
    const byExt = resolveViewer({ contentType: "application/octet-stream", filename: "book.xlsx", assetId: "asset-7" });
    expect(byExt.kind).toBe("xlsx");
    expect(byExt.renderUrl).toBe("/api/assets/asset-7/render");
  });

  it("falls back to download for XLSX when no assetId is available to build the render URL", () => {
    const noAsset = resolveViewer({ contentType: XLSX_MIME, filename: "sheet.xlsx", assetUrl: "/blob/x" });
    expect(noAsset.kind).toBe("download");
  });
});
