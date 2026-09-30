# Memory Page Redesign — Phase 6.1c.2 (Source Drawer + DOCX + Polish) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the most visible mockup-vs-reality gap. Add the source-text drawer (open-source-asset-from-the-md-item), render DOCX uploads natively (instead of falling to GenericFileViewer), and run a polish pass on typography/motion/density across the explorer.

**Architecture:** Server gets a new `GET /memory/assets/:id/render` endpoint that returns DOCX as HTML via the already-installed `mammoth` dep. UI gets `DocxFileViewer` that fetches the HTML, plus a `SourceTextDrawer` that slides in from `MarkdownItemViewer` when the item has an `importJobId`, opening the originating asset right beside it. Visual polish is a small set of Tailwind tweaks across the existing components — no structural changes.

**Out of scope (deferred to polish slice or Slice D):**
- **PDF excerpt highlighting** — needs `memory_extractions.charStart/charEnd` to be populated by the file-import worker. Currently those rows aren't created. This is a worker-side change; punt.
- **PPTX slide grid** — needs server-side LibreOffice conversion. Big lift; falls back to GenericFileViewer for now.
- **Browser-style viewer tabs** (open multiple items at once) — complex state management; the URL-driven single-selection model already works.
- **Re-extract button** — backend change; defer.
- **⌘K + Home** — Slice D.

**Branch + worktree:** `memory-phase-6-0` in `.claude/worktrees/memory-phase-6-0/`. Most recent commit at plan-write time: `2d46cbe`.

---

## File Structure

### New files

```
server/src/routes/memory-asset-render.ts                       ← GET /memory/assets/:id/render
server/src/__tests__/memory-asset-render-routes.test.ts        ← contract test
ui/src/components/memory/SourceTextDrawer.tsx                  ← slide-in drawer for md items
```

### Modified files

```
server/src/app.ts                                              ← mount new render route
ui/src/api/memoryAssets.ts                                     ← add `renderUrl(id)` helper
ui/src/components/memory/viewers/DocxFileViewer.tsx            ← fetch + render HTML
ui/src/components/memory/viewers/MarkdownItemViewer.tsx        ← add "Source" footer button
ui/src/components/memory/viewers/PdfFileViewer.tsx             ← polish (typography + spacing)
ui/src/components/memory/viewers/ImageFileViewer.tsx           ← polish
ui/src/components/memory/viewers/VideoFileViewer.tsx           ← polish
ui/src/components/memory/viewers/GenericFileViewer.tsx         ← polish
ui/src/components/memory/MemoryTree.tsx                        ← polish (tree row density + hover)
ui/src/components/memory/MemoryFileList.tsx                    ← polish (row hierarchy + spacing)
ui/src/components/memory/MemoryViewer.tsx                      ← consume SourceTextDrawer
```

### Why this split

The render endpoint is its own route file — it stays narrow (one route, one MIME today, one helper function). `SourceTextDrawer` is a separate component because its lifecycle (open/close + which asset) is independent of the markdown viewer's content. The polish edits are intentionally diffuse — small Tailwind tweaks across components — but bundled into one commit so the polish pass is reviewable as a unit.

---

## Task 1: Server — `GET /memory/assets/:id/render` (DOCX → HTML)

**Files:**
- Create: `server/src/routes/memory-asset-render.ts`
- Create: `server/src/__tests__/memory-asset-render-routes.test.ts`
- Modify: `server/src/app.ts` (mount before `memoryRoutes(db)`)

- [ ] Step 1: Branch safety check.
- [ ] Step 2: Inspect the existing `memory-assets.ts` route + `memoryAssetsService.get`. The render endpoint follows the same auth (`assertCompanyAccess`) and same get-asset-then-do-something pattern.

- [ ] Step 3: Write the failing test:

```typescript
// server/src/__tests__/memory-asset-render-routes.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { Readable } from "node:stream";
import { memoryAssetRenderRoutes } from "../routes/memory-asset-render.js";

vi.mock("../routes/authz.js", () => ({
  assertCompanyAccess: () => undefined,
}));

vi.mock("mammoth", () => ({
  default: {
    convertToHtml: vi.fn(async () => ({ value: "<p>hello world</p>", messages: [] })),
  },
}));

function buildApp(svc: unknown, storage: unknown) {
  const app = express();
  app.use(express.json());
  app.use(memoryAssetRenderRoutes({ svc: svc as never, storage: storage as never }));
  return app;
}

describe("memory-asset render route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders DOCX to HTML", async () => {
    const svc = {
      get: vi.fn(async () => ({
        id: "a-1",
        fileName: "doc.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        storageKey: "co-1/imports/a-1.docx",
      })),
    };
    const storage = {
      getObject: vi.fn(async () => ({
        stream: Readable.from([Buffer.from("dummy docx bytes")]),
        contentLength: 16,
      })),
    };
    const app = buildApp(svc, storage);
    const res = await request(app).get("/companies/co-1/memory/assets/a-1/render");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.text).toContain("hello world");
  });

  it("returns 415 for unsupported mime types", async () => {
    const svc = {
      get: vi.fn(async () => ({
        id: "a-1",
        fileName: "x.png",
        mimeType: "image/png",
        storageKey: "k",
      })),
    };
    const storage = { getObject: vi.fn() };
    const app = buildApp(svc, storage);
    const res = await request(app).get("/companies/co-1/memory/assets/a-1/render");
    expect(res.status).toBe(415);
    expect(storage.getObject).not.toHaveBeenCalled();
  });

  it("returns 404 when asset doesn't exist", async () => {
    const svc = { get: vi.fn(async () => null) };
    const storage = { getObject: vi.fn() };
    const app = buildApp(svc, storage);
    const res = await request(app).get("/companies/co-1/memory/assets/missing/render");
    expect(res.status).toBe(404);
  });
});
```

- [ ] Step 4: Implement:

```typescript
// server/src/routes/memory-asset-render.ts
import { Router, type Request, type Response } from "express";
import mammoth from "mammoth";
import type { Db } from "@armyofagents/db";
import { memoryAssetsService } from "../services/memory-assets.js";
import type { StorageService } from "../storage/types.js";
import { assertCompanyAccess } from "./authz.js";

interface RoutesOptions {
  db?: Db;
  svc?: ReturnType<typeof memoryAssetsService>;
  storage?: { getObject: (companyId: string, key: string) => Promise<{ stream: NodeJS.ReadableStream; contentLength: number }> };
  storageService?: StorageService;
}

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

export function memoryAssetRenderRoutes(opts: RoutesOptions) {
  const router = Router();
  const svc = opts.svc ?? memoryAssetsService(opts.db!);
  const storage = opts.storage ?? opts.storageService;

  router.get(
    "/companies/:companyId/memory/assets/:id/render",
    async (req: Request, res: Response, next) => {
      try {
        const companyId = req.params.companyId as string;
        const id = req.params.id as string;
        assertCompanyAccess(req, companyId);

        const asset = await svc.get(id, companyId);
        if (!asset) {
          res.status(404).json({ error: "Asset not found" });
          return;
        }

        if (asset.mimeType !== DOCX_MIME) {
          res.status(415).json({
            error: `Render not supported for ${asset.mimeType}. Try /content for the raw bytes.`,
          });
          return;
        }

        if (!storage) {
          res.status(500).json({ error: "Storage not configured" });
          return;
        }

        const obj = await storage.getObject(companyId, asset.storageKey);
        const buffer = await streamToBuffer(obj.stream);
        const result = await mammoth.convertToHtml({ buffer });

        res.setHeader("Content-Type", "text/html; charset=utf-8");
        // Wrap so the consumer can drop it directly into a styled container.
        res.send(`<article class="docx-rendered">${result.value}</article>`);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
```

- [ ] Step 5: Run tests + typecheck.
- [ ] Step 6: Mount in `server/src/app.ts` BEFORE `memoryRoutes(db)`. Place right after `memoryAssetsUploadRoutes`. Same import-then-mount pattern.
- [ ] Step 7: Commit:

```
feat(memory): GET /memory/assets/:id/render — DOCX → HTML via mammoth
```

---

## Task 2: UI — `DocxFileViewer` consumes the render endpoint

**Files:**
- Modify: `ui/src/api/memoryAssets.ts` (add `renderUrl(id)` helper)
- Modify: `ui/src/components/memory/viewers/DocxFileViewer.tsx` (currently doesn't exist; create)
- Modify: `ui/src/components/memory/MemoryViewer.tsx` (route DOCX MIME to the new viewer)

- [ ] Step 1: Branch safety.

- [ ] Step 2: Add `renderUrl` to the API client. Append to the `memoryAssetsApi` object in `ui/src/api/memoryAssets.ts`:

```typescript
/** Returns the URL the browser can hit to fetch a server-rendered HTML view of the asset (DOCX today). */
renderUrl: (companyId: string, id: string): string =>
  `/api/companies/${companyId}/memory/assets/${id}/render`,
```

- [ ] Step 3: Create `ui/src/components/memory/viewers/DocxFileViewer.tsx`:

```typescript
import { useQuery } from "@tanstack/react-query";
import { Loader2, Download, FileWarning } from "lucide-react";
import { Button } from "@/components/ui/button";
import { memoryAssetsApi } from "../../../api/memoryAssets";
import { queryKeys } from "../../../lib/queryKeys";
import { ExtractsSidebar } from "../ExtractsSidebar";

interface DocxFileViewerProps {
  companyId: string;
  assetId: string;
}

async function fetchDocxHtml(url: string): Promise<string> {
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error(`Render failed (HTTP ${r.status})`);
  return r.text();
}

export function DocxFileViewer({ companyId, assetId }: DocxFileViewerProps) {
  const { data: asset } = useQuery({
    queryKey: queryKeys.memory.assets.detail(companyId, assetId),
    queryFn: () => memoryAssetsApi.get(companyId, assetId),
  });

  const renderUrl = memoryAssetsApi.renderUrl(companyId, assetId);
  const downloadUrl = memoryAssetsApi.contentUrl(companyId, assetId);

  const htmlQuery = useQuery({
    queryKey: ["memory-asset-render", companyId, assetId],
    queryFn: () => fetchDocxHtml(renderUrl),
    enabled: Boolean(asset),
    staleTime: 5 * 60 * 1000,
  });

  if (!asset) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="h-full flex">
      <div className="flex-1 flex flex-col">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border text-xs bg-card/30">
          <span className="font-medium truncate flex-1">{asset.fileName}</span>
          <Button size="sm" variant="ghost" asChild className="h-7 gap-1">
            <a href={downloadUrl} download={asset.fileName}>
              <Download className="h-3 w-3" />
              Download
            </a>
          </Button>
        </div>
        <div className="flex-1 overflow-auto bg-background px-10 py-8">
          {htmlQuery.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Rendering document…
            </div>
          ) : htmlQuery.error ? (
            <div className="flex flex-col items-center gap-2 py-8 text-sm text-muted-foreground">
              <FileWarning className="h-8 w-8" />
              <div>Couldn't render this DOCX. Use Download to open it externally.</div>
            </div>
          ) : (
            <article
              className="prose prose-sm dark:prose-invert max-w-none"
              dangerouslySetInnerHTML={{ __html: htmlQuery.data ?? "" }}
            />
          )}
        </div>
      </div>
      {asset.importJobId && (
        <ExtractsSidebar companyId={companyId} importJobId={asset.importJobId} />
      )}
    </div>
  );
}
```

- [ ] Step 4: Wire the new viewer into `ui/src/components/memory/MemoryViewer.tsx`. Find the `AssetViewerSlot` switch and add a DOCX branch:

```typescript
import { DocxFileViewer } from "./viewers/DocxFileViewer";

// inside the AssetViewerSlot component:
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// add this branch BEFORE the GenericFileViewer fallback:
if (mt === DOCX_MIME) {
  return <DocxFileViewer companyId={companyId} assetId={assetId} />;
}
```

- [ ] Step 5: Typecheck. Commit:

```
feat(ui): DocxFileViewer renders DOCX uploads via the render endpoint
```

---

## Task 3: `SourceTextDrawer` — open the source asset from the .md viewer

**Files:**
- Create: `ui/src/components/memory/SourceTextDrawer.tsx`
- Modify: `ui/src/components/memory/viewers/MarkdownItemViewer.tsx` (add a "Show source" footer button + drawer state)

- [ ] Step 1: Branch safety.

- [ ] Step 2: Create `ui/src/components/memory/SourceTextDrawer.tsx`:

```typescript
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { X, ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { memoryApi } from "../../api/memory";
import { memoryAssetsApi } from "../../api/memoryAssets";
import { queryKeys } from "../../lib/queryKeys";
import { useNavigate } from "@/lib/router";
import { useCompany } from "../../context/CompanyContext";
import { cn } from "@/lib/utils";

interface SourceTextDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  importJobId: string;
}

/**
 * Slides in from the right side of a .md viewer when the founder clicks
 * "Show source". Looks up the source asset by importJobId and renders a
 * compact preview — the same view a user would get clicking the asset
 * directly in the file list, just embedded in-place.
 *
 * v1: shows the source filename + mimeType and a button to open the full
 * asset viewer in the explorer (preserves user's current item context for
 * back-button). Future v2 (Slice C.3): inline render the originating
 * passage with character-offset highlight from memory_extractions.
 */
export function SourceTextDrawer({
  open,
  onOpenChange,
  companyId,
  importJobId,
}: SourceTextDrawerProps) {
  const navigate = useNavigate();
  const { selectedCompany } = useCompany();
  const companyPrefix = (selectedCompany as { issuePrefix?: string } | null)?.issuePrefix ?? "";

  // Find the asset whose importJobId matches.
  const { data: assets, isLoading } = useQuery({
    queryKey: queryKeys.memory.assets.list(companyId),
    queryFn: () => memoryAssetsApi.list(companyId),
    enabled: open,
  });
  const asset = (assets ?? []).find((a) => a.importJobId === importJobId);

  // Close on Escape for keyboard a11y.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onOpenChange(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  function openInViewer() {
    if (!asset) return;
    const params = new URLSearchParams(window.location.search);
    params.set("item", asset.id);
    params.set("type", "asset");
    navigate(`/${companyPrefix}/memory?${params.toString()}`);
    onOpenChange(false);
  }

  return (
    <div
      className={cn(
        "absolute inset-y-0 right-0 w-[420px] bg-card border-l border-border shadow-2xl",
        "transition-transform duration-200 ease-out z-30",
        open ? "translate-x-0" : "translate-x-full",
      )}
      role="complementary"
      aria-label="Source text drawer"
      aria-hidden={!open}
    >
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground flex-1">
          Source
        </span>
        <Button
          size="icon"
          variant="ghost"
          onClick={() => onOpenChange(false)}
          className="h-7 w-7"
          aria-label="Close source drawer"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="px-4 py-4">
        {isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading…
          </div>
        ) : !asset ? (
          <div className="text-xs text-muted-foreground">
            The source file for this item is no longer available. It may have
            been deleted or archived.
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <div className="text-sm font-medium">{asset.fileName}</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">
                {asset.mimeType} · {Math.round(asset.fileSize / 1024)} KB
              </div>
            </div>
            <div className="text-xs text-muted-foreground leading-relaxed">
              This memory item was extracted from the file above. Inline
              passage rendering with the originating text highlighted is
              coming in a follow-up slice.
            </div>
            <Button
              size="sm"
              onClick={openInViewer}
              className="w-full gap-2"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open source in viewer
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] Step 3: Wire into `ui/src/components/memory/viewers/MarkdownItemViewer.tsx`. Add state + a footer button + the drawer at the bottom of the rendered output:

```typescript
import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { SourceTextDrawer } from "../SourceTextDrawer";

// inside the component:
const [sourceOpen, setSourceOpen] = useState(false);
const importJobId = (i as MemoryItem & { importJobId?: string | null }).importJobId ?? null;
```

Wrap the existing return in a relative-positioned div so the drawer can position absolutely:

```typescript
return (
  <div className="h-full flex flex-col relative overflow-hidden">
    {/* existing header band ... */}
    {/* existing body (preview or editor) ... */}

    {importJobId && (
      <div className="border-t border-border px-6 py-2 text-xs flex items-center gap-2 bg-card/30">
        <span className="text-muted-foreground">Extracted from a source file</span>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setSourceOpen(true)}
          className="h-7 gap-1"
        >
          <ExternalLink className="h-3 w-3" />
          Show source
        </Button>
      </div>
    )}

    {importJobId && (
      <SourceTextDrawer
        open={sourceOpen}
        onOpenChange={setSourceOpen}
        companyId={companyId}
        importJobId={importJobId}
      />
    )}
  </div>
);
```

- [ ] Step 4: Add a smoke test for the drawer:

```typescript
// ui/src/__tests__/SourceTextDrawer.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/router");
  return { ...actual, useNavigate: () => vi.fn() };
});

vi.mock("../api/memoryAssets", () => ({
  memoryAssetsApi: {
    list: vi.fn(async () => [
      { id: "a-1", fileName: "rfc.pdf", mimeType: "application/pdf", fileSize: 12_345, importJobId: "j-1" },
    ]),
  },
}));

vi.mock("../api/memory", () => ({ memoryApi: {} }));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { issuePrefix: "co1" } }),
}));

import { SourceTextDrawer } from "../components/memory/SourceTextDrawer";

function renderDrawer(open = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SourceTextDrawer
          open={open}
          onOpenChange={vi.fn()}
          companyId="co-1"
          importJobId="j-1"
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SourceTextDrawer", () => {
  it("renders the matching asset's filename + size", async () => {
    renderDrawer();
    await waitFor(() => expect(screen.getByText("rfc.pdf")).toBeInTheDocument());
    expect(screen.getByText(/application\/pdf/i)).toBeInTheDocument();
  });

  it("shows a fallback when no asset matches the importJobId", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <SourceTextDrawer
            open={true}
            onOpenChange={vi.fn()}
            companyId="co-1"
            importJobId="j-99-not-found"
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByText(/source file for this item is no longer available/i)).toBeInTheDocument(),
    );
  });

  it("opens in viewer when the button is clicked", async () => {
    const user = userEvent.setup();
    renderDrawer();
    await waitFor(() => expect(screen.getByText("rfc.pdf")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /open source in viewer/i }));
    // navigation mock — just verify the button is clickable without throwing
  });
});
```

- [ ] Step 5: Run tests + typecheck. Commit:

```
feat(ui): SourceTextDrawer + "Show source" footer on MarkdownItemViewer
```

---

## Task 4: Visual polish pass

**Scope:** small Tailwind tweaks, no structural changes. The aim is to bring the explorer closer to the mockup's visual rhythm without scope creep.

**Files:** all viewers + tree + file list. See list above.

**The pass — what to apply:**

1. **Header bands** in all viewers (PDF, Image, Video, Generic, Docx): change `text-xs` toolbar lines to `text-[11px]`, increase `py-2` to `py-2.5`, tighten the filename truncation. Mockup uses tighter info density.

2. **Tree rows** (`FolderTreeNode.tsx`): `py-1` → `py-1.5`, increase line-height from default to `leading-snug`, raise hover bg from `bg-muted/40` to `bg-muted/60` for clearer affordance.

3. **File list rows** (`MemoryFileList.tsx`): ensure 2-line layout (name on top, type · time below) has consistent vertical rhythm. Switch metadata from `text-[10px]` to `text-[11px]`. Trim the row min-height.

4. **Status chips:** the `bg-emerald-100 text-emerald-800` etc. are the right colors; bump letter-spacing on the uppercase label (`tracking-wider` → `tracking-[0.06em]`) and tighten padding (`px-2 py-0.5` → `px-1.5 py-0.5`). Same treatment in MarkdownItemViewer header chips.

5. **Animations:**
   - `MemoryTree` chevron rotation: add `transition-transform duration-150` when expanding folders. Currently they snap.
   - `SourceTextDrawer`: already has `transition-transform duration-200 ease-out` (fine).
   - File list row selection: add `transition-colors duration-100` on the row hover/select bg.

6. **Empty states**: `MemoryEmptyViewer.tsx` is too cold. Add a subtle gradient or de-emphasize the brain icon to `opacity-20` and increase to `h-10 w-10`. Adjust the copy to be inviting — "Pick a memory item or upload a file to start" is warmer than "Select an item to view it here".

7. **Right-pane scroll**: the markdown body uses `prose prose-sm dark:prose-invert`. Add `prose-headings:font-semibold` and `prose-p:leading-relaxed` so paragraph text breathes properly.

**Implementation:**

Don't change component APIs or data flow — just className tweaks + minor copy. Each file gets ~3-8 lines changed. Verify nothing visually regresses by comparing screenshots before/after.

- [ ] Step 1: Branch safety.
- [ ] Step 2: Apply the polish pass to the listed files.
- [ ] Step 3: Run typecheck — must be 0 errors.
- [ ] Step 4: Run UI test suite — must not regress vs the post-Phase-6.1c baseline (5 failed files, 20 failed tests, all pre-existing).
- [ ] Step 5: Commit:

```
polish(ui): tighten typography + spacing + motion across explorer viewers and tree
```

---

## Task 5: Browser smoke verify

**No code changes — verification only.**

1. Restart dev servers if needed.
2. Navigate to `/IMP/memory`. Confirm the new explorer is the default route.
3. Click an existing `.md` memory item that came from a file import (e.g. one of the smoke-test extracts). Confirm:
   - The new "Show source" footer button appears.
   - Clicking it slides in `SourceTextDrawer` from the right.
   - The drawer shows the source asset's filename + mimeType.
   - Clicking "Open source in viewer" navigates to the file viewer for that asset.
   - Pressing Escape closes the drawer.
4. Upload a `.docx` file. Click it. Confirm `DocxFileViewer` renders the document HTML (not the GenericFileViewer fallback).
5. Visually compare tree rows, file list rows, and status chips against the mockup screenshots. Polish should land closer.

If anything fails, report which step + the symptom.

---

## Verification — exit criteria for Phase 6.1c.2

1. ✅ `pnpm -r typecheck` — 0 errors.
2. ✅ `pnpm --filter server test memory-asset-render-routes` — 3/3 PASS.
3. ✅ `pnpm --filter ui test SourceTextDrawer` — 3/3 PASS.
4. ✅ Full UI suite — no NEW regressions vs the post-Phase-6.1c baseline.
5. ✅ Browser smoke checklist passes.
6. ✅ Branch `memory-phase-6-0` has 4 new commits ahead of `2d46cbe` (T1, T2, T3, T4).
