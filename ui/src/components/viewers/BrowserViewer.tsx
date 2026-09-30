// Shared sandboxed in-panel browser: URL bar + iframe + reload + open-externally.
// Extracted verbatim from threads/ThreadViewer.tsx so both the Discussions viewer
// and the Commander viewer can use it without a commander -> threads dependency.
import { useState } from "react";
import type { FormEvent } from "react";
import { ExternalLink, Globe, RefreshCw } from "lucide-react";
import { toSafeBrowserUrl } from "@armyofagents/shared";
import { Button } from "@/components/ui/button";

export function normalizeBrowserUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed === "about:blank") return trimmed;
  if (trimmed.startsWith("/")) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

/** Minimal local empty-state (mirrors threads' CenteredMessage without depending on it). */
function CenteredMessage({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex h-full min-h-0 items-center justify-center p-5">
      <div className="max-w-xs text-center">
        <div className="text-sm font-semibold">{title}</div>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}

export function BrowserViewer({ initialUrl }: { initialUrl: string }) {
  const safeInitial = toSafeBrowserUrl(initialUrl);
  const [iframeKey, setIframeKey] = useState(0);
  const [draftUrl, setDraftUrl] = useState(safeInitial === "about:blank" ? "" : safeInitial);
  const [url, setUrl] = useState(safeInitial || "about:blank");
  const showFrame = url !== "about:blank";

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = normalizeBrowserUrl(draftUrl);
    setDraftUrl(next);
    setUrl(next || "about:blank");
    setIframeKey((key) => key + 1);
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" data-testid="thread-browser-viewer">
      <form onSubmit={submit} className="flex min-w-0 shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <input
          value={draftUrl}
          onChange={(event) => setDraftUrl(event.target.value)}
          placeholder="Enter a URL"
          className="min-w-0 flex-1 rounded-md border border-border bg-muted/30 px-2 py-1 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-brand"
          aria-label="Browser URL"
          data-testid="thread-browser-url-input"
        />
        <Button type="submit" size="sm" className="h-7 px-2 text-xs">
          Open
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => setIframeKey((key) => key + 1)}
          title="Reload"
          aria-label="Reload browser preview"
          data-testid="thread-browser-reload"
          disabled={!showFrame}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
        {showFrame && (
          <Button asChild type="button" variant="ghost" size="icon" className="h-7 w-7" title="Open externally">
            <a href={toSafeBrowserUrl(url) || "about:blank"} target="_blank" rel="noopener noreferrer" aria-label="Open browser preview externally">
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </Button>
        )}
      </form>
      {showFrame ? (
        <iframe
          key={iframeKey}
          title={url}
          src={toSafeBrowserUrl(url) || "about:blank"}
          className="min-h-0 flex-1 border-0 bg-background"
          sandbox="allow-forms allow-popups allow-same-origin allow-scripts"
          data-testid="thread-browser-iframe"
        />
      ) : (
        <CenteredMessage title="Browser" body="Enter a URL to open it in the viewer." />
      )}
    </div>
  );
}
