# Memory Page Redesign — Phase 6.1c (File Viewers + Upload + Extracts Sidebar) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the explorer file-aware end-to-end — founder can upload PDFs/images/videos, the file lands in the right folder, the file-import worker extracts memory items as before, and the viewer renders the file natively (PDF.js for PDFs, native `<img>` / `<video>` for media, download fallback for everything else). The asset's right rail shows the items extracted from it (via `importJobId` join — no schema change needed).

Source-text drawer (clicking "Show source" from a `.md` item to see the originating PDF excerpt) is **deferred to Slice C.2** because it needs character-offset annotations on `memory_extractions` that aren't fully wired through the API yet. Re-extract button likewise deferred.

**Architecture:** New server endpoint `POST /api/companies/:cid/memory/assets/upload` that wraps the existing `fileImportService.upload` + inserts a `memory_assets` row in the same transaction. UI: a single `MemoryUploadButton` in the explorer toolbar pops a hidden file input → POST → invalidate folders + assets queries. New viewers (`PdfFileViewer`, `ImageFileViewer`, `VideoFileViewer`, `GenericFileViewer`) replace the placeholder asset case in `MemoryViewer`. New `ExtractsSidebar` renders inside file viewers, hits the existing memory list endpoint filtered by `importJobId`.

**Tech Stack:** New dep `react-pdf` (wraps `pdfjs-dist`, ~500KB shaved by Vite tree-shake but expect ~250-400KB net). Native HTMLVideoElement for video. Native `<img>` with CSS for image zoom. Server uses existing `multer` + `fileImportService` patterns.

**Spec reference:** `docs/superpowers/specs/2026-05-02-memory-page-redesign-design.md` § "File-type viewers" (PDF, image, video, PPTX, generic) + § "Bidirectional source binding" (the right-rail extracts list).

**Branch + worktree:** `memory-phase-6-0` in `.claude/worktrees/memory-phase-6-0/`. Most recent commit at plan-write time: `0b67c02`.

**Out of scope (later):**
- Source-text drawer with PDF.js highlight on the .md side → Slice C.2
- Re-extract button on the file viewer → Slice C.2
- DOCX rendering (mammoth) — falls back to GenericFileViewer (download) in this slice
- PPTX slide grid — falls back to GenericFileViewer in this slice
- Drag-and-drop upload (button + click only) → polish slice
- ⌘K quick switcher + global search → Slice D
- Home page → Slice D

---

## File Structure

### New files

```
server/src/routes/memory-assets-upload.ts                          ← POST /memory/assets/upload
server/src/__tests__/memory-assets-upload-routes.test.ts           ← upload contract test

ui/src/components/memory/MemoryUploadButton.tsx                    ← toolbar button + hidden file input
ui/src/components/memory/ExtractsSidebar.tsx                       ← right-rail list of extracted items
ui/src/components/memory/viewers/PdfFileViewer.tsx                 ← react-pdf based
ui/src/components/memory/viewers/ImageFileViewer.tsx               ← native img + CSS zoom
ui/src/components/memory/viewers/VideoFileViewer.tsx               ← native video player
ui/src/components/memory/viewers/GenericFileViewer.tsx             ← metadata + download fallback
ui/src/__tests__/MemoryUploadButton.test.tsx
ui/src/__tests__/ExtractsSidebar.test.tsx
```

### Modified files

```
server/src/app.ts                                            ← mount the new upload route
ui/package.json                                              ← add react-pdf
ui/src/api/memoryAssets.ts                                   ← add `upload` method
ui/src/lib/queryKeys.ts                                      ← (no change — list invalidation reuses existing keys)
ui/src/components/memory/MemoryViewer.tsx                    ← replace asset placeholder with the per-MIME viewers
ui/src/pages/MemoryExplorer.tsx                              ← add MemoryUploadButton to a top toolbar
```

### Why this split

The upload endpoint sits in its own route file (mirroring `memory-folders.ts` / `memory-assets.ts`) so the existing `memory-assets.ts` stays read-only. Each viewer is its own file because they have wildly different shapes (PDF.js iframe, video element, image with CSS) and are easier to reason about in isolation. `ExtractsSidebar` is shared across all file viewers so it's its own component. The test pattern follows the existing dispatch convention (mocked db + supertest for routes; testing-library + mocked api for UI).

---

## Task 1: Server — `POST /memory/assets/upload` endpoint

**Files:**
- Create: `server/src/routes/memory-assets-upload.ts`
- Create: `server/src/__tests__/memory-assets-upload-routes.test.ts`
- Modify: `server/src/app.ts` (mount the new route)

- [ ] **Step 1: Branch safety**

```bash
cd "C:/Users/TK/OneDrive/Desktop/Claude Data/Paperclip-AoA/AoA-2.5/.claude/worktrees/memory-phase-6-0"
git rev-parse --abbrev-ref HEAD
```

Expected: `memory-phase-6-0`.

- [ ] **Step 2: Inspect existing patterns**

```bash
head -50 server/src/routes/file-import.ts
```

Note how the file-import route handles multer + the file-import service. Mirror that closely.

```bash
grep -n "memoryAssetsService" server/src/services/memory-assets.ts
```

Note the `create` method signature (companyId, departmentId, folderPath, fileName, mimeType, fileSize, storageKey, importJobId, ...).

- [ ] **Step 3: Write the failing test**

Create `server/src/__tests__/memory-assets-upload-routes.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { memoryAssetsUploadRoutes } from "../routes/memory-assets-upload.js";

vi.mock("../routes/authz.js", () => ({
  assertCompanyAccess: () => undefined,
  getActorInfo: () => ({ userId: "u-1", actorType: "user" }),
}));
vi.mock("../middleware/rbac.js", () => ({
  assertRole: async () => undefined,
}));

function buildApp(opts: {
  fileImport: unknown;
  assets: unknown;
  storage: unknown;
}) {
  const app = express();
  app.use(express.json());
  app.use(
    memoryAssetsUploadRoutes({
      fileImportService: opts.fileImport as never,
      assetsService: opts.assets as never,
      storage: opts.storage as never,
    }),
  );
  return app;
}

describe("memory-assets upload route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uploads a file, creates a job and asset row, and returns both", async () => {
    const fileImport = {
      createJob: vi.fn(async () => ({ id: "job-1", storageKey: "k", fileName: "x.pdf" })),
    };
    const assets = {
      create: vi.fn(async (input: unknown) => ({ id: "a-1", ...(input as object) })),
    };
    const storage = {
      putFile: vi.fn(async () => ({
        objectKey: "co-1/file-imports/abc-x.pdf",
        size: 12,
        sha256: "deadbeef",
      })),
    };
    const app = buildApp({ fileImport, assets, storage });

    const res = await request(app)
      .post("/companies/co-1/memory/assets/upload")
      .field("departmentId", "dept-1")
      .field("folderPath", "Engineering/Files")
      .attach("file", Buffer.from("hello"), {
        filename: "x.pdf",
        contentType: "application/pdf",
      });

    expect(res.status).toBe(201);
    expect(res.body.asset).toMatchObject({
      fileName: "x.pdf",
      mimeType: "application/pdf",
      folderPath: "Engineering/Files",
      importJobId: "job-1",
    });
    expect(res.body.jobId).toBe("job-1");
    expect(storage.putFile).toHaveBeenCalled();
    expect(fileImport.createJob).toHaveBeenCalled();
    expect(assets.create).toHaveBeenCalled();
  });

  it("rejects unsupported mime types with 400", async () => {
    const fileImport = { createJob: vi.fn() };
    const assets = { create: vi.fn() };
    const storage = { putFile: vi.fn() };
    const app = buildApp({ fileImport, assets, storage });

    const res = await request(app)
      .post("/companies/co-1/memory/assets/upload")
      .field("folderPath", "Files")
      .attach("file", Buffer.from("hi"), {
        filename: "x.exe",
        contentType: "application/x-msdownload",
      });

    expect(res.status).toBe(400);
    expect(fileImport.createJob).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run test, expect FAIL**

```bash
pnpm --filter server test memory-assets-upload-routes
```

Expected: FAIL — module not found.

- [ ] **Step 5: Implement the route**

Create `server/src/routes/memory-assets-upload.ts`:

```typescript
import path from "node:path";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import type { Db } from "@armyofagents/db";
import { fileImportService, SUPPORTED_MIME_TYPES } from "../services/file-import.js";
import { memoryAssetsService } from "../services/memory-assets.js";
import type { StorageService } from "../storage/types.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { assertRole } from "../middleware/rbac.js";

// Reuse Phase 4.5 supported MIME list. Image/video/PPTX live alongside the
// text formats already supported by the file-import worker.
const SUPPORTED_UPLOAD_MIME_TYPES_SET = new Set<string>([
  ...SUPPORTED_MIME_TYPES,
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

const MAX_FILE_SIZE_BYTES =
  Number(process.env.AOA_FILE_MAX_BYTES) || 50 * 1024 * 1024;

interface RoutesOptions {
  db?: Db;
  fileImportService?: ReturnType<typeof fileImportService>;
  assetsService?: ReturnType<typeof memoryAssetsService>;
  storage?: { putFile: (input: unknown) => Promise<{ objectKey: string; size: number; sha256: string }> };
  storageService?: StorageService;
}

export function memoryAssetsUploadRoutes(opts: RoutesOptions) {
  const router = Router();
  const fileImport = opts.fileImportService ?? fileImportService(opts.db!);
  const assets = opts.assetsService ?? memoryAssetsService(opts.db!);
  const storage = opts.storage ?? opts.storageService;

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 },
  });

  function runSingle(req: Request, res: Response): Promise<void> {
    return new Promise((resolve, reject) => {
      upload.single("file")(req, res, (err: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  router.post(
    "/companies/:companyId/memory/assets/upload",
    async (req, res, next) => {
      try {
        const companyId = req.params.companyId as string;
        assertCompanyAccess(req, companyId);
        if (opts.db) await assertRole(opts.db, req, companyId, "team_lead");

        try {
          await runSingle(req, res);
        } catch (err) {
          if (err instanceof multer.MulterError) {
            if (err.code === "LIMIT_FILE_SIZE") {
              res.status(422).json({ error: `File exceeds ${MAX_FILE_SIZE_BYTES} bytes` });
              return;
            }
            res.status(400).json({ error: err.message });
            return;
          }
          throw err;
        }

        const file = (req as Request & { file?: { mimetype: string; buffer: Buffer; originalname: string; size: number } }).file;
        if (!file) {
          res.status(400).json({ error: "No file uploaded" });
          return;
        }

        if (!SUPPORTED_UPLOAD_MIME_TYPES_SET.has(file.mimetype)) {
          res.status(400).json({
            error: `Unsupported file type: ${file.mimetype}`,
          });
          return;
        }

        const { departmentId, folderPath } = req.body as Record<string, string | undefined>;

        if (!storage) {
          res.status(500).json({ error: "Storage not configured" });
          return;
        }

        // Sanitize filename for storage key.
        const safeName = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, "_");
        const namespace = `imports/${Date.now()}-${safeName}`;
        const stored = await storage.putFile({
          companyId,
          namespace,
          originalFilename: file.originalname,
          contentType: file.mimetype,
          body: file.buffer,
        });

        const actor = getActorInfo(req);
        const job = await fileImport.createJob({
          companyId,
          fileName: file.originalname,
          mimeType: file.mimetype,
          fileSize: stored.size,
          storageKey: stored.objectKey,
          createdBy: actor.userId ?? "unknown",
          departmentId: departmentId ?? null,
          projectId: null,
          defaultLayer: "domain",
          defaultCategory: "reference",
        });

        const asset = await assets.create({
          companyId,
          departmentId: departmentId ?? null,
          folderPath: folderPath ?? "",
          fileName: file.originalname,
          mimeType: file.mimetype,
          fileSize: stored.size,
          storageKey: stored.objectKey,
          importJobId: job.id,
          uploadedByUserId: actor.userId ?? null,
        });

        res.status(201).json({ asset, jobId: job.id });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
```

- [ ] **Step 6: Run tests**

```bash
pnpm --filter server test memory-assets-upload-routes
```

Expected: PASS — both cases.

- [ ] **Step 7: Mount in app.ts**

Open `server/src/app.ts`. Add the import alongside the other memory route imports:

```typescript
import { memoryAssetsUploadRoutes } from "./routes/memory-assets-upload.js";
```

Mount it BEFORE the existing `memoryRoutes(db)` (same reasoning as the Phase 6.0 fix — `/memory/:id` is a catch-all). Place it right after `memoryAssetsRoutes`:

```typescript
api.use(memoryFoldersRoutes({ db }));
api.use(memoryAssetsRoutes({ db, storageService: opts.storageService }));
api.use(memoryAssetsUploadRoutes({ db, storageService: opts.storageService }));
api.use(memoryRoutes(db));
```

- [ ] **Step 8: Run typecheck + commit**

```bash
pnpm --filter server typecheck
git rev-parse --abbrev-ref HEAD
git add server/src/routes/memory-assets-upload.ts server/src/__tests__/memory-assets-upload-routes.test.ts server/src/app.ts
git commit -m "feat(memory): POST /memory/assets/upload — wraps fileImport + creates memory_asset row"
```

---

## Task 2: UI upload control — `MemoryUploadButton` + API client method + toolbar wiring

**Files:**
- Modify: `ui/src/api/memoryAssets.ts` (add `upload` method)
- Create: `ui/src/components/memory/MemoryUploadButton.tsx`
- Create: `ui/src/__tests__/MemoryUploadButton.test.tsx`
- Modify: `ui/src/pages/MemoryExplorer.tsx` (add toolbar with upload button)

- [ ] **Step 1: Branch safety**

```bash
git rev-parse --abbrev-ref HEAD
```

- [ ] **Step 2: Add the API client method**

Open `ui/src/api/memoryAssets.ts`. Add:

```typescript
upload: async (
  companyId: string,
  file: File,
  params: { departmentId?: string; folderPath?: string } = {},
): Promise<{ asset: MemoryAssetRecord; jobId: string }> => {
  const formData = new FormData();
  formData.append("file", file);
  if (params.departmentId) formData.append("departmentId", params.departmentId);
  if (params.folderPath) formData.append("folderPath", params.folderPath);
  // Note: api.post may not handle multipart correctly; if so, use fetch directly.
  const r = await fetch(`/api/companies/${companyId}/memory/assets/upload`, {
    method: "POST",
    body: formData,
    credentials: "include",
  });
  if (!r.ok) {
    let msg = `Upload failed (HTTP ${r.status})`;
    try {
      const j = await r.json();
      if (j.error) msg = j.error;
    } catch {}
    throw new Error(msg);
  }
  return r.json();
},
```

If `api.post` (the existing client) handles multipart automatically, prefer that. Check by reading `ui/src/api/client.ts`. The `fetch` fallback above is robust if the existing client doesn't.

- [ ] **Step 3: Write the failing test**

Create `ui/src/__tests__/MemoryUploadButton.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const uploadMock = vi.hoisted(() => vi.fn(async () => ({ asset: { id: "a-1", fileName: "x.pdf" }, jobId: "j-1" })));

vi.mock("../api/memoryAssets", () => ({
  memoryAssetsApi: {
    upload: uploadMock,
    list: vi.fn(async () => []),
    contentUrl: () => "/test",
  },
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

import { MemoryUploadButton } from "../components/memory/MemoryUploadButton";

function renderButton(props?: Partial<React.ComponentProps<typeof MemoryUploadButton>>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryUploadButton
        companyId="co-1"
        departmentId="dept-1"
        folderPath="Engineering/Files"
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe("MemoryUploadButton (Phase 6.1c)", () => {
  beforeEach(() => uploadMock.mockClear());

  it("renders an Upload button", () => {
    renderButton();
    expect(screen.getByRole("button", { name: /upload/i })).toBeInTheDocument();
  });

  it("calls upload on file selection", async () => {
    const user = userEvent.setup();
    renderButton();
    const file = new File(["hi"], "x.pdf", { type: "application/pdf" });
    // Hidden input is queryable by type=file
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    await user.upload(input, file);
    await waitFor(() =>
      expect(uploadMock).toHaveBeenCalledWith("co-1", file, {
        departmentId: "dept-1",
        folderPath: "Engineering/Files",
      }),
    );
  });
});
```

- [ ] **Step 4: Implement the component**

Create `ui/src/components/memory/MemoryUploadButton.tsx`:

```typescript
import { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Upload, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { memoryAssetsApi } from "../../api/memoryAssets";
import { queryKeys } from "../../lib/queryKeys";
import { useToast } from "../../context/ToastContext";

interface MemoryUploadButtonProps {
  companyId: string;
  departmentId: string | null;
  folderPath: string;
}

export function MemoryUploadButton({
  companyId,
  departmentId,
  folderPath,
}: MemoryUploadButtonProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const { pushToast } = useToast();

  const uploadMutation = useMutation({
    mutationFn: (file: File) =>
      memoryAssetsApi.upload(companyId, file, {
        departmentId: departmentId ?? undefined,
        folderPath: folderPath || undefined,
      }),
    onSuccess: (res) => {
      pushToast({
        title: `Uploaded ${res.asset.fileName} — extraction queued`,
        tone: "success",
      });
      void qc.invalidateQueries({
        queryKey: queryKeys.memory.assets.list(companyId, {
          departmentId: departmentId ?? undefined,
          folderPath,
        }),
      });
      void qc.invalidateQueries({
        queryKey: queryKeys.memory.assets.list(companyId),
      });
    },
    onError: (err) =>
      pushToast({
        title: err instanceof Error ? err.message : "Upload failed",
        tone: "error",
      }),
  });

  function handlePick() {
    fileInputRef.current?.click();
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) {
      uploadMutation.mutate(f);
      // Reset so the same file can be re-uploaded after.
      e.target.value = "";
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={handlePick}
        disabled={uploadMutation.isPending}
        className="h-7 gap-1 text-xs"
      >
        {uploadMutation.isPending ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Upload className="h-3 w-3" />
        )}
        Upload
      </Button>
      <input
        ref={fileInputRef}
        type="file"
        hidden
        onChange={handleChange}
        accept=".pdf,.docx,.txt,.png,.jpg,.jpeg,.gif,.webp,.mp4,.webm,.mov,.pptx"
      />
    </>
  );
}
```

- [ ] **Step 5: Wire into the explorer toolbar**

Open `ui/src/pages/MemoryExplorer.tsx`. Above the `<ResizablePanelGroup>` (still inside the outer `<div>`), add a small toolbar row:

```typescript
import { MemoryUploadButton } from "../components/memory/MemoryUploadButton";

// Inside the JSX, just before <ResizablePanelGroup>:
<div className="flex items-center justify-end gap-2 px-3 py-2 border-b border-border bg-card/30">
  <MemoryUploadButton
    companyId={selectedCompanyId}
    departmentId={departmentId}
    folderPath={folderPath}
  />
</div>
```

- [ ] **Step 6: Run tests + typecheck**

```bash
pnpm --filter ui test MemoryUploadButton
pnpm --filter ui typecheck
```

Expected: PASS / 0 errors.

- [ ] **Step 7: Branch safety + commit**

```bash
git rev-parse --abbrev-ref HEAD
git add ui/src/api/memoryAssets.ts ui/src/components/memory/MemoryUploadButton.tsx ui/src/__tests__/MemoryUploadButton.test.tsx ui/src/pages/MemoryExplorer.tsx
git commit -m "feat(ui): add MemoryUploadButton + wire into explorer toolbar"
```

---

## Task 3: PDF viewer with react-pdf

**Files:**
- Modify: `ui/package.json` (add `react-pdf`)
- Create: `ui/src/components/memory/viewers/PdfFileViewer.tsx`
- Modify: `ui/src/components/memory/MemoryViewer.tsx` (route PDFs to the new viewer)

- [ ] **Step 1: Branch safety**

```bash
git rev-parse --abbrev-ref HEAD
```

- [ ] **Step 2: Install react-pdf**

```bash
pnpm --filter ui add react-pdf pdfjs-dist
```

If install fails, try `react-pdf-viewer` (alternative library) — same API patterns. Default: stick with `react-pdf`.

- [ ] **Step 3: Create the viewer**

Create `ui/src/components/memory/viewers/PdfFileViewer.tsx`:

```typescript
import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Document, Page, pdfjs } from "react-pdf";
import { ChevronLeft, ChevronRight, Loader2, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { MemoryAssetRecord } from "@armyofagents/shared";
import { memoryAssetsApi } from "../../../api/memoryAssets";
import { queryKeys } from "../../../lib/queryKeys";
import { ExtractsSidebar } from "../ExtractsSidebar";

// react-pdf needs a worker URL. Vite resolves it via the package's wasm-friendly worker.
import "react-pdf/dist/Page/TextLayer.css";
import "react-pdf/dist/Page/AnnotationLayer.css";
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

interface PdfFileViewerProps {
  companyId: string;
  assetId: string;
}

export function PdfFileViewer({ companyId, assetId }: PdfFileViewerProps) {
  const { data: asset } = useQuery({
    queryKey: queryKeys.memory.assets.detail(companyId, assetId),
    queryFn: () => memoryAssetsApi.get(companyId, assetId),
  });

  const [pageNum, setPageNum] = useState(1);
  const [numPages, setNumPages] = useState<number | null>(null);

  const fileUrl = useMemo(
    () => memoryAssetsApi.contentUrl(companyId, assetId),
    [companyId, assetId],
  );

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
        {/* toolbar */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border text-xs bg-card/30">
          <span className="font-medium truncate flex-1">{asset.fileName}</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setPageNum((p) => Math.max(1, p - 1))}
            disabled={pageNum <= 1}
            className="h-7 w-7 p-0"
            aria-label="Previous page"
          >
            <ChevronLeft className="h-3 w-3" />
          </Button>
          <span className="tabular-nums">
            {pageNum} / {numPages ?? "…"}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              setPageNum((p) => (numPages ? Math.min(numPages, p + 1) : p + 1))
            }
            disabled={numPages !== null && pageNum >= numPages}
            className="h-7 w-7 p-0"
            aria-label="Next page"
          >
            <ChevronRight className="h-3 w-3" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            asChild
            className="h-7 gap-1"
          >
            <a href={fileUrl} download={asset.fileName}>
              <Download className="h-3 w-3" />
              Download
            </a>
          </Button>
        </div>
        {/* page area */}
        <div className="flex-1 overflow-auto bg-muted/30 flex items-start justify-center py-4">
          <Document
            file={fileUrl}
            onLoadSuccess={({ numPages: n }) => setNumPages(n)}
            loading={
              <div className="p-8 text-xs text-muted-foreground">
                Loading PDF…
              </div>
            }
            error={
              <div className="p-8 text-xs text-destructive">
                Failed to load PDF.
              </div>
            }
          >
            <Page pageNumber={pageNum} width={680} />
          </Document>
        </div>
      </div>
      {asset.importJobId && (
        <ExtractsSidebar
          companyId={companyId}
          importJobId={asset.importJobId}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Tests for PdfFileViewer**

PDF.js doesn't render well in jsdom. Write a smoke test that mocks `react-pdf` to verify the viewer mounts + the toolbar renders:

```typescript
// ui/src/__tests__/PdfFileViewer.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("react-pdf", () => ({
  Document: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Page: ({ pageNumber }: { pageNumber: number }) => <div>page {pageNumber}</div>,
  pdfjs: { GlobalWorkerOptions: { workerSrc: "" } },
}));
vi.mock("../api/memoryAssets", () => ({
  memoryAssetsApi: {
    get: vi.fn(async () => ({
      id: "a-1",
      fileName: "x.pdf",
      mimeType: "application/pdf",
      importJobId: null,
    })),
    contentUrl: () => "/test",
    list: vi.fn(async () => []),
  },
}));
vi.mock("../api/memory", () => ({
  memoryApi: { list: vi.fn(async () => []) },
}));

import { PdfFileViewer } from "../components/memory/viewers/PdfFileViewer";

describe("PdfFileViewer", () => {
  it("renders toolbar with filename + page nav", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <PdfFileViewer companyId="co-1" assetId="a-1" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText("x.pdf")).toBeInTheDocument());
    expect(screen.getByLabelText("Previous page")).toBeInTheDocument();
    expect(screen.getByLabelText("Next page")).toBeInTheDocument();
  });
});
```

- [ ] **Step 5: Wire into MemoryViewer**

Open `ui/src/components/memory/MemoryViewer.tsx`. Replace the asset placeholder branch with a switch on the asset's MIME type. We need to fetch the asset to know its MIME — easiest pattern: do it inline in MemoryViewer with a small useQuery, then dispatch.

Replace the `selectedItemId && selectedItemType === "asset"` branch with:

```typescript
import { useQuery } from "@tanstack/react-query";
import { memoryAssetsApi } from "../../api/memoryAssets";
import { queryKeys } from "../../lib/queryKeys";
import { PdfFileViewer } from "./viewers/PdfFileViewer";
import { ImageFileViewer } from "./viewers/ImageFileViewer";
import { VideoFileViewer } from "./viewers/VideoFileViewer";
import { GenericFileViewer } from "./viewers/GenericFileViewer";

function AssetViewerSlot({ companyId, assetId }: { companyId: string; assetId: string }) {
  const { data: asset, isLoading } = useQuery({
    queryKey: queryKeys.memory.assets.detail(companyId, assetId),
    queryFn: () => memoryAssetsApi.get(companyId, assetId),
  });
  if (isLoading || !asset) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
        Loading…
      </div>
    );
  }
  const mt = asset.mimeType;
  if (mt === "application/pdf") {
    return <PdfFileViewer companyId={companyId} assetId={assetId} />;
  }
  if (mt.startsWith("image/")) {
    return <ImageFileViewer companyId={companyId} assetId={assetId} />;
  }
  if (mt.startsWith("video/")) {
    return <VideoFileViewer companyId={companyId} assetId={assetId} />;
  }
  return <GenericFileViewer companyId={companyId} assetId={assetId} />;
}
```

Then in the component body, replace the existing asset placeholder:

```typescript
if (selectedItemId && selectedItemType === "asset") {
  return <AssetViewerSlot companyId={companyId} assetId={selectedItemId} />;
}
```

- [ ] **Step 6: Run tests + typecheck**

```bash
pnpm --filter ui test PdfFileViewer
pnpm --filter ui typecheck
```

NOTE: PdfFileViewer imports ExtractsSidebar (Task 5) which doesn't exist yet — this commit may have a missing-import. Workaround: temporarily comment out the `<ExtractsSidebar>` usage in PdfFileViewer until Task 5 lands; uncomment when committing T5. OR: ship Tasks 3 + 4 + 5 together and commit only at the end.

Recommended: write Task 5 first OR include a stub ExtractsSidebar in this commit:

```typescript
// ui/src/components/memory/ExtractsSidebar.tsx (stub for T3 — full impl in T5)
export function ExtractsSidebar(_props: { companyId: string; importJobId: string }) {
  return (
    <div className="w-72 border-l border-border bg-card/30 px-3 py-2 text-xs text-muted-foreground">
      Extracts sidebar (Phase 6.1c T5)
    </div>
  );
}
```

Use the stub here so Task 3 commits cleanly. Replace the stub with the real component in Task 5.

- [ ] **Step 7: Branch safety + commit**

```bash
git rev-parse --abbrev-ref HEAD
git add ui/package.json pnpm-lock.yaml ui/src/components/memory/viewers/PdfFileViewer.tsx ui/src/components/memory/ExtractsSidebar.tsx ui/src/components/memory/MemoryViewer.tsx ui/src/__tests__/PdfFileViewer.test.tsx
git commit -m "feat(ui): add PdfFileViewer with react-pdf + ExtractsSidebar stub"
```

---

## Task 4: Image, Video, and Generic file viewers

**Files:**
- Create: `ui/src/components/memory/viewers/ImageFileViewer.tsx`
- Create: `ui/src/components/memory/viewers/VideoFileViewer.tsx`
- Create: `ui/src/components/memory/viewers/GenericFileViewer.tsx`

- [ ] **Step 1: Branch safety**

```bash
git rev-parse --abbrev-ref HEAD
```

- [ ] **Step 2: Create ImageFileViewer**

```typescript
// ui/src/components/memory/viewers/ImageFileViewer.tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ZoomIn, ZoomOut, Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { memoryAssetsApi } from "../../../api/memoryAssets";
import { queryKeys } from "../../../lib/queryKeys";
import { ExtractsSidebar } from "../ExtractsSidebar";

interface ImageFileViewerProps {
  companyId: string;
  assetId: string;
}

export function ImageFileViewer({ companyId, assetId }: ImageFileViewerProps) {
  const { data: asset } = useQuery({
    queryKey: queryKeys.memory.assets.detail(companyId, assetId),
    queryFn: () => memoryAssetsApi.get(companyId, assetId),
  });
  const [zoom, setZoom] = useState(1);
  const url = memoryAssetsApi.contentUrl(companyId, assetId);

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
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}
            className="h-7 w-7 p-0"
            aria-label="Zoom out"
          >
            <ZoomOut className="h-3 w-3" />
          </Button>
          <span className="tabular-nums">{Math.round(zoom * 100)}%</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setZoom((z) => Math.min(4, z + 0.25))}
            className="h-7 w-7 p-0"
            aria-label="Zoom in"
          >
            <ZoomIn className="h-3 w-3" />
          </Button>
          <Button size="sm" variant="ghost" asChild className="h-7 gap-1">
            <a href={url} download={asset.fileName}>
              <Download className="h-3 w-3" />
              Download
            </a>
          </Button>
        </div>
        <div className="flex-1 overflow-auto bg-muted/30 flex items-start justify-center py-4">
          <img
            src={url}
            alt={asset.fileName}
            style={{ transform: `scale(${zoom})`, transformOrigin: "center top" }}
            className="max-w-full"
          />
        </div>
      </div>
      {asset.importJobId && (
        <ExtractsSidebar companyId={companyId} importJobId={asset.importJobId} />
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create VideoFileViewer**

```typescript
// ui/src/components/memory/viewers/VideoFileViewer.tsx
import { useQuery } from "@tanstack/react-query";
import { Loader2, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { memoryAssetsApi } from "../../../api/memoryAssets";
import { queryKeys } from "../../../lib/queryKeys";
import { ExtractsSidebar } from "../ExtractsSidebar";

interface VideoFileViewerProps {
  companyId: string;
  assetId: string;
}

export function VideoFileViewer({ companyId, assetId }: VideoFileViewerProps) {
  const { data: asset } = useQuery({
    queryKey: queryKeys.memory.assets.detail(companyId, assetId),
    queryFn: () => memoryAssetsApi.get(companyId, assetId),
  });
  const url = memoryAssetsApi.contentUrl(companyId, assetId);

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
            <a href={url} download={asset.fileName}>
              <Download className="h-3 w-3" />
              Download
            </a>
          </Button>
        </div>
        <div className="flex-1 bg-black flex items-center justify-center">
          <video src={url} controls className="max-w-full max-h-full" />
        </div>
      </div>
      {asset.importJobId && (
        <ExtractsSidebar companyId={companyId} importJobId={asset.importJobId} />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Create GenericFileViewer**

```typescript
// ui/src/components/memory/viewers/GenericFileViewer.tsx
import { useQuery } from "@tanstack/react-query";
import { File as FileIcon, Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { memoryAssetsApi } from "../../../api/memoryAssets";
import { queryKeys } from "../../../lib/queryKeys";
import { ExtractsSidebar } from "../ExtractsSidebar";

interface GenericFileViewerProps {
  companyId: string;
  assetId: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function GenericFileViewer({ companyId, assetId }: GenericFileViewerProps) {
  const { data: asset } = useQuery({
    queryKey: queryKeys.memory.assets.detail(companyId, assetId),
    queryFn: () => memoryAssetsApi.get(companyId, assetId),
  });
  const url = memoryAssetsApi.contentUrl(companyId, assetId);

  if (!asset) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="h-full flex">
      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8">
        <FileIcon className="h-16 w-16 text-muted-foreground opacity-50" />
        <div className="text-lg font-medium">{asset.fileName}</div>
        <div className="text-xs text-muted-foreground">
          {asset.mimeType} · {formatBytes(asset.fileSize)}
        </div>
        <Button asChild>
          <a href={url} download={asset.fileName} className="gap-2">
            <Download className="h-4 w-4" />
            Download
          </a>
        </Button>
      </div>
      {asset.importJobId && (
        <ExtractsSidebar companyId={companyId} importJobId={asset.importJobId} />
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run typecheck + commit**

```bash
pnpm --filter ui typecheck
git rev-parse --abbrev-ref HEAD
git add ui/src/components/memory/viewers/ImageFileViewer.tsx ui/src/components/memory/viewers/VideoFileViewer.tsx ui/src/components/memory/viewers/GenericFileViewer.tsx
git commit -m "feat(ui): add Image, Video, and Generic file viewers"
```

---

## Task 5: Replace ExtractsSidebar stub with real implementation

**Files:**
- Modify: `ui/src/components/memory/ExtractsSidebar.tsx` (replace stub)
- Create: `ui/src/__tests__/ExtractsSidebar.test.tsx`

- [ ] **Step 1: Branch safety**

```bash
git rev-parse --abbrev-ref HEAD
```

- [ ] **Step 2: Replace the stub**

Replace the stub in `ui/src/components/memory/ExtractsSidebar.tsx`:

```typescript
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { FileText, Loader2 } from "lucide-react";
import { memoryApi } from "../../api/memory";
import { queryKeys } from "../../lib/queryKeys";
import { useCompany } from "../../context/CompanyContext";
import type { MemoryItem } from "@armyofagents/shared";
import { cn } from "@/lib/utils";

interface ExtractsSidebarProps {
  companyId: string;
  importJobId: string;
}

const STATUS_COLOR: Record<string, string> = {
  approved: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  pending: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  archived: "bg-gray-100 text-gray-800 dark:bg-gray-900/40 dark:text-gray-300",
  rejected: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
};

/**
 * Phase 6.1c — extracts sidebar shown on the right of a file viewer.
 * Lists memory items extracted from this asset, joined by importJobId.
 * Click a row → opens that .md item in the viewer (overrides current selection).
 */
export function ExtractsSidebar({ companyId, importJobId }: ExtractsSidebarProps) {
  const navigate = useNavigate();
  const { selectedCompany } = useCompany();
  const companyPrefix = selectedCompany?.issuePrefix ?? "";

  const { data, isLoading } = useQuery({
    queryKey: [...queryKeys.memory.list(companyId), { importJobId }],
    queryFn: () => memoryApi.list(companyId, {}),
    enabled: Boolean(companyId && importJobId),
  });

  const extracts = ((data ?? []) as MemoryItem[]).filter(
    (it) => (it as MemoryItem & { importJobId?: string }).importJobId === importJobId,
  );

  function openItem(itemId: string) {
    const params = new URLSearchParams(window.location.search);
    params.set("item", itemId);
    params.set("type", "memory_item");
    navigate(`/${companyPrefix}/memory/explore?${params.toString()}`);
  }

  return (
    <div className="w-72 border-l border-border bg-card/30 flex flex-col">
      <div className="px-3 py-2 border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-2">
        <FileText className="h-3 w-3" />
        <span>Extracts</span>
        <span className="flex-1" />
        <span className="tabular-nums">{extracts.length}</span>
      </div>
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="p-3 flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading…
          </div>
        ) : extracts.length === 0 ? (
          <div className="p-3 text-xs text-muted-foreground text-center">
            No memory items have been extracted from this file yet.
          </div>
        ) : (
          extracts.map((it) => {
            const i = it as MemoryItem & { folderPath?: string };
            return (
              <div
                key={it.id}
                onClick={() => openItem(it.id)}
                className="px-3 py-2 border-b border-border cursor-pointer hover:bg-muted/40"
              >
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-medium truncate flex-1">{it.title}</span>
                  {it.status && (
                    <span
                      className={cn(
                        "text-[10px] px-1.5 py-0.5 rounded font-medium uppercase tracking-wider",
                        STATUS_COLOR[it.status] ?? "bg-muted text-muted-foreground",
                      )}
                    >
                      {it.status}
                    </span>
                  )}
                </div>
                {i.folderPath && (
                  <div className="text-[10px] text-muted-foreground mt-1 truncate">
                    📁 {i.folderPath}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Test**

```typescript
// ui/src/__tests__/ExtractsSidebar.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/router");
  return { ...actual, useNavigate: () => vi.fn() };
});

vi.mock("../api/memory", () => ({
  memoryApi: {
    list: vi.fn(async () => [
      { id: "i-1", title: "Extract one", status: "approved", importJobId: "j-1", folderPath: "Engineering/Decisions" },
      { id: "i-2", title: "Extract two", status: "pending", importJobId: "j-1" },
      { id: "i-3", title: "Other item", status: "approved", importJobId: "j-99" },
    ]),
  },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { issuePrefix: "co1" } }),
}));

import { ExtractsSidebar } from "../components/memory/ExtractsSidebar";

describe("ExtractsSidebar", () => {
  it("filters items by importJobId and renders them", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ExtractsSidebar companyId="co-1" importJobId="j-1" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText("Extract one")).toBeInTheDocument());
    expect(screen.getByText("Extract two")).toBeInTheDocument();
    // The other one (j-99) should NOT appear.
    expect(screen.queryByText("Other item")).toBeNull();
  });
});
```

- [ ] **Step 4: Run tests + typecheck**

```bash
pnpm --filter ui test ExtractsSidebar
pnpm --filter ui typecheck
```

Expected: PASS / 0 errors.

- [ ] **Step 5: Branch safety + commit**

```bash
git rev-parse --abbrev-ref HEAD
git add ui/src/components/memory/ExtractsSidebar.tsx ui/src/__tests__/ExtractsSidebar.test.tsx
git commit -m "feat(ui): replace ExtractsSidebar stub with implementation that lists items by importJobId"
```

---

## Task 6: Browser smoke verification

**No code changes — purely verification.**

Smoke checklist:
1. Restart server + UI dev server.
2. Navigate to `/<companyPrefix>/memory/explore`.
3. Click into a folder (e.g. Engineering / Files). Click the **Upload** button. Pick a small PDF. Confirm:
   - The toast says "Uploaded X — extraction queued"
   - The file appears in the file list (after a refetch — may need ~1s)
4. Click the uploaded PDF. Confirm:
   - PDF.js renders the first page
   - The toolbar shows page X / Y, prev/next buttons, Download
   - The Extracts sidebar appears on the right with "0 / No memory items have been extracted from this file yet" — until the file-import worker finishes (15-60s)
5. Wait for extraction to complete (or upload a TXT for fastest extraction). Confirm the Extracts sidebar updates with the items.
6. Click an extracted item — confirm it navigates to the .md viewer with that item selected.
7. Upload an image (`.png` / `.jpg`). Confirm `ImageFileViewer` renders + zoom buttons work.
8. (Optional) Upload a video. Confirm `VideoFileViewer` plays.

---

## Verification — exit criteria for Phase 6.1c

After Tasks 1–5 are complete:

1. ✅ `pnpm -r typecheck` returns 0 errors.
2. ✅ `pnpm --filter ui test MemoryUploadButton PdfFileViewer ExtractsSidebar` returns 4+ PASS.
3. ✅ `pnpm --filter server test memory-assets-upload-routes` returns 2/2 PASS.
4. ✅ Full UI suite has no NEW regressions vs the post-Phase-6.1b baseline.
5. ✅ Full server suite has no NEW regressions vs the post-Phase-6.1b baseline.
6. ✅ Browser smoke checklist passes.
7. ✅ Branch `memory-phase-6-0` has 5 new commits ahead of `0b67c02`.

---

## What's NOT in this slice (Slice C.2 + later)

- Source-text drawer with PDF.js highlight on the .md side → Slice C.2
- Re-extract button on file viewer → Slice C.2
- DOCX rendering with mammoth → Slice C.2 (currently falls back to GenericFileViewer)
- PPTX slide grid → Slice C.2 (currently falls back to GenericFileViewer)
- Drag-and-drop upload → polish slice
- ⌘K quick switcher + global search → Slice D
- Home page → Slice D
