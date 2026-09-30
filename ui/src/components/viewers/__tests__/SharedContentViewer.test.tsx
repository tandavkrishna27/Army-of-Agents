import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { SharedContentViewer } from "../SharedContentViewer";
import type { ViewerResolution } from "../viewer-registry";

vi.mock("../PdfDocumentViewer", () => ({
  PdfDocumentViewer: ({ fileUrl, filename }: { fileUrl: string; filename: string }) => (
    <div data-testid="pdf-viewer">{filename}:{fileUrl}</div>
  ),
}));

function renderViewer(
  viewer: ViewerResolution,
  inlineTextContent: string | null = null,
  filename = "example.md",
) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={client}>
      <SharedContentViewer
        viewer={viewer}
        filename={filename}
        inlineTextContent={inlineTextContent}
      />
    </QueryClientProvider>,
  );
}

function viewer(overrides: Partial<ViewerResolution>): ViewerResolution {
  return {
    kind: "markdown",
    label: "Markdown preview",
    assetUrl: null,
    url: null,
    canOpenDirectly: false,
    shouldExecuteInBrowser: false,
    requiresTextFetch: true,
    canShowSource: true,
    ...overrides,
  };
}

describe("SharedContentViewer", () => {
  it("renders inline markdown without fetching", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    renderViewer(viewer({ kind: "markdown" }), "# Hello");

    expect(screen.getByRole("heading", { name: "Hello" })).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetches text content when required and no inline content exists", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Fetched source", { status: 200 }),
    );

    renderViewer(viewer({ kind: "code", assetUrl: "/asset.txt", url: "/asset.txt" }));

    await waitFor(() => expect(screen.getByText("Fetched source")).toBeInTheDocument());
    expect(globalThis.fetch).toHaveBeenCalledWith("/asset.txt", { credentials: "include" });
  });

  it("renders html content inside a sandboxed iframe", () => {
    renderViewer(viewer({ kind: "html_sandbox" }), "<h1>Preview</h1>");

    const frame = screen.getByTestId("work-product-html-frame");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  });

  it("renders download fallback with an external open link", () => {
    renderViewer(
      viewer({
        kind: "download",
        label: "Open externally",
        assetUrl: "/bundle.zip",
        url: "/bundle.zip",
        requiresTextFetch: false,
        canShowSource: false,
      }),
    );

    expect(screen.getByTestId("preview-output-download")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute("href", "/bundle.zip");
  });

  // Binary media kinds (image/video/audio) render the raw asset URL directly and
  // never text-fetch. They read `assetUrl` off the resolution.
  it("renders an image from the asset URL without fetching", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderViewer(
      viewer({
        kind: "image",
        label: "Image preview",
        assetUrl: "/api/assets/asset-1/content",
        url: "/api/assets/asset-1/content",
        requiresTextFetch: false,
        canShowSource: false,
      }),
      null,
      "photo.png",
    );
    const wrap = screen.getByTestId("preview-output-image");
    const img = wrap.querySelector("img");
    expect(img).toHaveAttribute("src", "/api/assets/asset-1/content");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders a video from the asset URL with native controls", () => {
    renderViewer(
      viewer({
        kind: "video",
        label: "Video preview",
        assetUrl: "/api/assets/asset-2/content",
        url: "/api/assets/asset-2/content",
        requiresTextFetch: false,
        canShowSource: false,
      }),
      null,
      "clip.mp4",
    );
    const video = screen.getByTestId("work-product-video");
    expect(video).toHaveAttribute("src", "/api/assets/asset-2/content");
    expect(video).toHaveAttribute("controls");
  });

  it("renders audio from the asset URL with native controls", () => {
    renderViewer(
      viewer({
        kind: "audio",
        label: "Audio preview",
        assetUrl: "/api/assets/asset-3/content",
        url: "/api/assets/asset-3/content",
        requiresTextFetch: false,
        canShowSource: false,
      }),
      null,
      "voice.webm",
    );
    const audio = screen.getByTestId("work-product-audio");
    expect(audio).toHaveAttribute("src", "/api/assets/asset-3/content");
    expect(audio).toHaveAttribute("controls");
  });

  // svg_sandbox uses the SAME sandboxed-iframe path as html_sandbox (untrusted
  // markup executes only under sandbox="allow-scripts"), but under its own testid.
  it("renders svg content inside a sandboxed iframe", () => {
    renderViewer(
      viewer({ kind: "svg_sandbox" }),
      '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" /></svg>',
      "diagram.svg",
    );
    const frame = screen.getByTestId("work-product-svg-frame");
    expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    // It is the svg frame, not the html one.
    expect(screen.queryByTestId("work-product-html-frame")).toBeNull();
  });

  it("delegates pdf rendering to PdfDocumentViewer", () => {
    renderViewer(
      viewer({
        kind: "pdf",
        label: "PDF preview",
        assetUrl: "/report.pdf",
        url: "/report.pdf",
        requiresTextFetch: false,
        canShowSource: false,
      }),
    );

    expect(screen.getByTestId("pdf-viewer")).toHaveTextContent("example.md:/report.pdf");
  });

  it("renders inline code as source text", () => {
    renderViewer(viewer({ kind: "code" }), "const x = 1;");
    expect(screen.getByTestId("work-product-source")).toHaveTextContent("const x = 1;");
  });

  // P3.2 discriminator: the code viewer now emits highlight.js token spans.
  // Ablation: the old `SourceOutputViewer` rendered `<pre>{content}</pre>` with
  // ZERO child elements, so `querySelector("span.hljs-keyword")` was null and
  // this assertion failed. The filename drives the language (`snippet.js` → js).
  it("highlights the code viewer with token spans (not a plain <pre>)", () => {
    renderViewer(viewer({ kind: "code" }), "const x = 1;", "snippet.js");
    const source = screen.getByTestId("work-product-source");
    const keyword = source.querySelector("span.hljs-keyword");
    expect(keyword).not.toBeNull();
    expect(keyword).toHaveTextContent("const");
    // The visible text is intact — highlighting only wraps, never mutates.
    expect(source).toHaveTextContent("const x = 1;");
    // The <code> container carries the hljs class the theme CSS targets.
    expect(source.querySelector("code.hljs")).not.toBeNull();
  });

  it("escapes HTML in the code viewer output (XSS-safe highlighting)", () => {
    renderViewer(viewer({ kind: "code" }), "<script>alert(1)</script>", "x.js");
    const source = screen.getByTestId("work-product-source");
    // No live <script> element is injected into the DOM.
    expect(source.querySelector("script")).toBeNull();
    expect(source).toHaveTextContent("<script>alert(1)</script>");
  });

  // P3.2 F2: an unknown/plain extension (.txt) must NOT auto-detect — it renders
  // as escaped plain text, never sprayed with guessed token colors.
  // Ablation: the OLD highlightToHtml auto-detected an absent language; this SQL-
  // ish fixture auto-detects as `sql` and DID emit `hljs-*` token spans, so the
  // `querySelectorAll("[class*='hljs-']").length === 0` assertion failed pre-fix.
  it("renders an unknown-extension code file as plain escaped text (no highlight)", () => {
    renderViewer(
      viewer({ kind: "code" }),
      "SELECT * FROM users WHERE id < 10 AND flag = 1 & 2;\n",
      "notes.txt",
    );
    const source = screen.getByTestId("work-product-source");
    // No highlight.js token spans anywhere (the <code> keeps only the "hljs"
    // container class; token classes are all "hljs-<name>").
    const tokenSpans = source.querySelectorAll("[class*='hljs-']");
    expect(tokenSpans.length).toBe(0);
    // Content still shown, and the raw < / & are entity-escaped (no injection).
    expect(source).toHaveTextContent("SELECT * FROM users WHERE id < 10 AND flag = 1 & 2;");
    expect(source.innerHTML).toContain("&lt;");
    expect(source.innerHTML).toContain("&amp;");
  });

  it("highlights fenced code blocks in markdown, leaving inline code plain", () => {
    renderViewer(
      viewer({ kind: "markdown" }),
      "Run `npm i` first.\n\n```js\nconst x = 1;\n```\n",
    );
    const md = screen.getByTestId("work-product-markdown");
    // Fenced block → highlighted <code class="hljs language-js"> with token spans.
    const fenced = md.querySelector("code.hljs.language-js");
    expect(fenced).not.toBeNull();
    expect(fenced!.querySelector("span.hljs-keyword")).not.toBeNull();
    // Inline code (`npm i`) is left plain — no hljs class.
    const inlineCodes = Array.from(md.querySelectorAll("code")).filter(
      (el) => !el.classList.contains("hljs"),
    );
    expect(inlineCodes.some((el) => el.textContent === "npm i")).toBe(true);
  });

  // P3.2 F1 regression: react-markdown v10 passes a hast `node` prop to custom
  // components. It must never be spread onto the intrinsic <code>, or React 19
  // silently serializes it as node="[object Object]" (no warning, so only a DOM
  // attribute check catches it). Covers both the inline and fenced branches.
  it("never leaks the react-markdown node prop onto rendered <code>", () => {
    renderViewer(
      viewer({ kind: "markdown" }),
      "Run `npm i` first.\n\n```js\nconst x = 1;\n```\n",
    );
    const md = screen.getByTestId("work-product-markdown");
    const codes = Array.from(md.querySelectorAll("code"));
    expect(codes.length).toBeGreaterThan(0);
    for (const el of codes) {
      expect(el.hasAttribute("node")).toBe(false);
    }
  });

  it("renders a CSV table, honoring the comma delimiter and quoted fields", () => {
    renderViewer(viewer({ kind: "table", delimiter: "," }), 'name,city\n"Smith, John",NYC');
    const table = screen.getByTestId("work-product-table");
    expect(table).toHaveTextContent("name");
    expect(table).toHaveTextContent("Smith, John"); // quoted comma kept as one cell
    expect(table).toHaveTextContent("NYC");
  });

  it("renders a TSV table when the resolved delimiter is a tab (delimiter prop is honored)", () => {
    renderViewer(viewer({ kind: "table", delimiter: "\t" }), "name\tcity\nSmith, John\tNYC");
    const table = screen.getByTestId("work-product-table");
    // The comma is a literal inside the tab-delimited cell, not a column break.
    expect(table).toHaveTextContent("Smith, John");
    expect(table).toHaveTextContent("NYC");
  });

  it("renders pretty-printed JSON", () => {
    renderViewer(viewer({ kind: "json" }), '{"ok":true,"count":2}');
    const json = screen.getByTestId("work-product-json");
    expect(json).toHaveTextContent('"ok": true');
    expect(json).toHaveTextContent('"count": 2');
  });

  it("renders an aoa-canvas document by its node labels", () => {
    const canvas = JSON.stringify({ nodes: [{ id: "1", label: "Plan" }, { id: "2", label: "Decision" }] });
    renderViewer(viewer({ kind: "canvas" }), canvas);
    const el = screen.getByTestId("work-product-canvas");
    expect(el).toHaveTextContent("Plan");
    expect(el).toHaveTextContent("Decision");
  });

  // P3.3 de-silo: the docx kind fetches the server render URL (which returns
  // already-sanitized HTML) and injects it. It does NOT text-fetch the raw
  // bytes — it self-fetches the /render URL exactly once.
  it("renders the docx viewer by fetching the render URL and injecting the HTML", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response('<article class="docx-rendered"><h1>Hello Doc</h1></article>', { status: 200 }),
    );

    renderViewer(
      viewer({
        kind: "docx",
        label: "Document preview",
        assetUrl: "/api/assets/asset-9/content",
        url: "/api/assets/asset-9/content",
        renderUrl: "/api/assets/asset-9/render",
        requiresTextFetch: false,
        canShowSource: false,
      }),
      null,
      "report.docx",
    );

    await waitFor(() =>
      expect(screen.getByTestId("work-product-docx")).toHaveTextContent("Hello Doc"),
    );
    // Fetched the /render URL, not the raw /content bytes.
    expect(fetchSpy).toHaveBeenCalledWith("/api/assets/asset-9/render", { credentials: "include" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back to a download card when the docx render URL is missing", () => {
    renderViewer(
      viewer({
        kind: "docx",
        label: "Document preview",
        assetUrl: "/api/assets/asset-9/content",
        url: "/api/assets/asset-9/content",
        renderUrl: null,
        requiresTextFetch: false,
        canShowSource: false,
      }),
      null,
      "report.docx",
    );
    expect(screen.getByTestId("preview-output-download")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute(
      "href",
      "/api/assets/asset-9/content",
    );
  });

  // P3.4 XLSX: the xlsx kind uses the SAME server-rendered fetch-inject path as
  // docx (one ServerRenderedHtmlView), fetching the /render URL that returns
  // already-sanitized HTML and injecting it — under its own testid.
  it("renders the xlsx viewer by fetching the render URL and injecting the HTML", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response('<div class="xlsx-rendered"><table><tbody><tr><td>Q4 Revenue</td></tr></tbody></table></div>', {
        status: 200,
      }),
    );

    renderViewer(
      viewer({
        kind: "xlsx",
        label: "Spreadsheet preview",
        assetUrl: "/api/assets/asset-7/content",
        url: "/api/assets/asset-7/content",
        renderUrl: "/api/assets/asset-7/render",
        requiresTextFetch: false,
        canShowSource: false,
      }),
      null,
      "book.xlsx",
    );

    await waitFor(() =>
      expect(screen.getByTestId("work-product-xlsx")).toHaveTextContent("Q4 Revenue"),
    );
    // Fetched the /render URL, not the raw /content bytes; the docx testid is absent.
    expect(fetchSpy).toHaveBeenCalledWith("/api/assets/asset-7/render", { credentials: "include" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("work-product-docx")).toBeNull();
  });

  it("falls back to a download card when the xlsx render URL is missing", () => {
    renderViewer(
      viewer({
        kind: "xlsx",
        label: "Spreadsheet preview",
        assetUrl: "/api/assets/asset-7/content",
        url: "/api/assets/asset-7/content",
        renderUrl: null,
        requiresTextFetch: false,
        canShowSource: false,
      }),
      null,
      "book.xlsx",
    );
    expect(screen.getByTestId("preview-output-download")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute(
      "href",
      "/api/assets/asset-7/content",
    );
  });
});
