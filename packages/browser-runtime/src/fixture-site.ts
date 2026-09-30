// packages/browser-runtime/src/fixture-site.ts
//
// BRW-002 — the deterministic local site the Test clause requires: "deterministic local site
// navigation, download, popup, and kill tests".
//
// It is an IN-PROCESS Node server with no dependencies, served on loopback, started next to
// the browser. Plan review established that this does NOT need to be a D1 compose service —
// D1/D3 lane work belongs to BRW-005 by three separate documents, and BRW-002's own spec says
// "local". An in-process server is also strictly better for determinism: no container to
// schedule, no network to flake, and the fixtures live beside the tests that assert on them.
//
// NOTE ON THE ONE PORT THIS OPENS. The containment guard measures the DELTA introduced by
// launching the browser, so this server's port is present in the baseline and is not counted
// against the browser. That is deliberate and is why the guard is a delta rather than an
// absolute set — see `listening-ports.ts`.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** Every fixture the four required cases need, keyed by pathname. */
const PAGES: Record<string, { status?: number; type: string; body: string; headers?: Record<string, string> }> = {
  "/": {
    type: "text/html; charset=utf-8",
    body: `<!doctype html><html><head><title>BRW-002 fixture index</title></head>
<body><h1 id="heading">index</h1>
<a id="to-second" href="/second">second</a>
<a id="to-download" href="/download">download</a>
<a id="to-popup" href="/popup" target="_blank">popup</a>
</body></html>`,
  },
  "/second": {
    type: "text/html; charset=utf-8",
    body: `<!doctype html><html><head><title>BRW-002 fixture second</title></head>
<body><h1 id="heading">second</h1></body></html>`,
  },
  "/popup": {
    type: "text/html; charset=utf-8",
    body: `<!doctype html><html><head><title>BRW-002 fixture popup opener</title></head>
<body>
<a id="blank-link" href="/second" target="_blank">open second in a new tab</a>
<button id="open-button" onclick="window.open('/second','_blank')">window.open</button>
</body></html>`,
  },
  // A page that keeps a timer alive, so a browser that survived teardown would still be
  // doing something observable rather than sitting idle.
  "/slow": {
    type: "text/html; charset=utf-8",
    body: `<!doctype html><html><head><title>BRW-002 fixture slow</title></head>
<body><div id="ticks">0</div>
<script>let n=0;setInterval(()=>{document.getElementById('ticks').textContent=String(++n);},50);</script>
</body></html>`,
  },
};

/** Downloads, kept separate because their headers are the point. */
const DOWNLOADS: Record<string, { filename: string; body: string }> = {
  "/download": { filename: "report.csv", body: "col_a,col_b\n1,2\n" },
  // A HOSTILE suggested filename. Chromium pre-sanitises this before it ever reaches
  // `suggestedFilename`, which is exactly why the escape test targets `saveAs` instead — see
  // `path-adapter.ts`. It is served anyway so the sanitisation is observable rather than
  // assumed.
  "/download-traversal": { filename: "../../escape.txt", body: "escaped\n" },
  "/download-absolute": { filename: "/etc/passwd", body: "absolute\n" },
};

export interface FixtureSite {
  readonly origin: string;
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Start the fixture site on an ephemeral loopback port.
 *
 * Binds 127.0.0.1 explicitly rather than the wildcard: this server exists only for the
 * browser sitting beside it, and in a sandbox a wildcard bind is publicly routable (measured
 * — see the port-exposure probe).
 */
export async function startFixtureSite(): Promise<FixtureSite> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;

    // ★ /hold — headers flush, the body NEVER ends. `page.goto(url, {waitUntil:"load"})`
    // therefore stays in-flight and the browser is genuinely held mid-navigation, alive,
    // for the whole observation window. This is what the teardown tests actually need.
    //
    // WHY THIS EXISTS. They used to navigate to /slow, whose NAME promised a held page but
    // whose HANDLER returned a complete document instantly (only a client-side setInterval
    // ran). So `goto` resolved, the runner emitted session_completed, and Chromium exited
    // in ~1s — before the 30s process observer polled. The diagnostic added on 2026-08-24
    // caught it verbatim: `{"type":"session_started",...}` immediately followed by
    // `{"type":"session_completed",...}`. The browser DID start; the observer just missed a
    // process that was already gone. /hold removes the race by keeping the process alive.
    //
    // The socket is left open deliberately; the fixture server is torn down per suite, which
    // drops it. `res.end` is never called, and that is the point.
    if (path === "/hold") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.write("<!doctype html><html><head><title>held</title></head><body>holding");
      return;
    }

    const download = DOWNLOADS[path];
    if (download !== undefined) {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        // The filename is deliberately unencoded: this is the attacker-controlled surface.
        "content-disposition": `attachment; filename="${download.filename}"`,
      });
      res.end(download.body);
      return;
    }

    const page = PAGES[path];
    if (page !== undefined) {
      res.writeHead(page.status ?? 200, { "content-type": page.type, ...(page.headers ?? {}) });
      res.end(page.body);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    port: address.port,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
