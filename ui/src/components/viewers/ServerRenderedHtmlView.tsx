import { useQuery } from "@tanstack/react-query";
import { Loader2, FileWarning } from "lucide-react";

/**
 * Presentational renderer for server-rendered office documents, shared by the
 * canonical `SharedContentViewer` (every surface) for BOTH DOCX and XLSX, and by
 * the Memory `DocxFileViewer` (which composes its own chrome around this). It
 * fetches a server render URL that returns **already-sanitized** HTML
 * (`/api/assets/:id/render` or the memory-scoped `/render`; sanitization is
 * server-side — see the render routes' shared DOMPurify config + XSS tests) and
 * injects it. This component adds NO sanitization of its own and has NO knowledge
 * of memory/assets APIs — it is deliberately decoupled so the fetch-and-inject
 * logic lives in exactly one place (docx and xlsx do not each reimplement it).
 */
async function fetchRenderedHtml(url: string): Promise<string> {
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error(`Render failed (HTTP ${r.status})`);
  return r.text();
}

export function ServerRenderedHtmlView({
  renderUrl,
  // Type-aware copy: "document" for DOCX, "spreadsheet" for XLSX. Defaults to the
  // neutral-but-accurate "document" so existing DOCX call sites read unchanged.
  noun = "document",
}: {
  renderUrl: string;
  noun?: string;
}) {
  const htmlQuery = useQuery({
    queryKey: ["office-render", renderUrl],
    queryFn: () => fetchRenderedHtml(renderUrl),
    enabled: Boolean(renderUrl),
    staleTime: 5 * 60 * 1000,
  });

  if (htmlQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Rendering {noun}…
      </div>
    );
  }

  if (htmlQuery.error) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-sm text-muted-foreground">
        <FileWarning className="h-8 w-8" />
        <div>Couldn't render this {noun}. Use Download to open it externally.</div>
      </div>
    );
  }

  return (
    <article
      className="prose prose-sm dark:prose-invert max-w-none"
      // Server-sanitized HTML (see fetchRenderedHtml docblock). No client sanitize.
      dangerouslySetInnerHTML={{ __html: htmlQuery.data ?? "" }}
    />
  );
}
