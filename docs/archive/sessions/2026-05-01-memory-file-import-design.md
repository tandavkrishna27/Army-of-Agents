# Memory File Import — Design Spec
**Date:** 2026-05-01
**Phase:** 4.5
**Status:** Approved

---

## Overview

Founders can upload files (PDF, DOCX, TXT) and have their content automatically converted into pending memory items for review. The pipeline is fully async (DB-backed job queue), uses the existing LLM extraction service for rich item quality, falls back to paragraph chunking when no API key is configured, and is designed with a clean seam for future Commander sub-agent integration.

---

## Goals

- Upload a file → items appear in the Memory Pending tab for founder review
- Works for large files (async, no request timeout risk)
- Follows existing codebase patterns (StorageService, extractionService, processEmbeddingQueue)
- Table and pipeline designed to accommodate future file types (images, video, Excel, PPT) without schema changes
- Clean seam for Commander sub-agent extraction when that architecture lands

## Non-Goals (deferred)

- Image OCR, video transcription, Excel/PPT parsing — file type support is expanded later
- Commander sub-agent extraction — provision made, not implemented
- Re-processing failed imports from the UI
- Bulk import (multiple files in one request)

---

## Architecture

### Two-stage pipeline

```
Stage 1: Text extraction (mechanical, format-specific)
  buffer + mimeType → raw text string
  Handles: PDF (pdf-parse), DOCX (mammoth.convertToHtml), TXT (native)

Stage 2: Memory item extraction (semantic, pluggable — THE SEAM)
  raw text + job metadata → pending memory items
  Path A: LLM available → extractionService (same as Discussion pipeline)
  Path B: LLM unavailable → paragraph chunking fallback
  Future: Commander sub-agent → swap extractItemsFromText() here
```

Stage 2 is encapsulated in a single function `extractItemsFromText(text, job, db)`.
When the Commander sub-agent architecture lands for Discussions, it slots in here too.

---

## Database

### New table: `file_import_jobs`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `companyId` | uuid FK → companies | cascade delete |
| `fileName` | text | original filename shown in UI |
| `mimeType` | text | standard MIME type — generic for all future file types |
| `fileSize` | integer | bytes — for UI display + monitoring |
| `storageKey` | text | path in StorageService (not raw bytes in DB) |
| `processorType` | text nullable | set by worker on pickup: `llm_extraction` \| `text_chunking` \| `commander_extraction` (future) |
| `status` | text | `pending` → `processing` → `done` \| `failed` |
| `itemCount` | integer default 0 | number of memory items created |
| `errorMessage` | text nullable | set on failure |
| `parserWarnings` | jsonb nullable | mammoth conversion warnings, PDF structure notes |
| `retryCount` | integer default 0 | incremented on each failure |
| `retryAfter` | timestamp nullable | set on failure; worker skips jobs where retryAfter > NOW() |
| `departmentId` | uuid nullable FK → projects | scope for created items |
| `projectId` | uuid nullable FK → projects | scope for created items |
| `defaultLayer` | text default `domain` | overridable per import |
| `defaultCategory` | text default `reference` | overridable per import |
| `createdBy` | text | userId who uploaded |
| `completedAt` | timestamp nullable | set when status → done or failed |
| `createdAt` | timestamp | |
| `updatedAt` | timestamp | |

**Why `mimeType` not `fileType`:** Standard MIME types work for every file format without maintaining a custom enum. Worker routes on MIME type to select the right processor.

**Why `storageKey` not `bytea`:** Follows existing asset upload pattern. Keeps DB lean. File remains accessible for potential re-processing.

**Why `projectId` + `departmentId`:** Mirrors `memory_items` scope fields for consistency. Import scoped to a project creates project-scoped items.

**Why `parserWarnings`:** Mammoth returns an array of warning strings for unsupported DOCX elements (embedded objects, custom styles, etc.). Only these small strings are stored — NOT the raw HTML output, which is used transiently in memory during Stage 1 and discarded. Surfaces in UI so founder knows "this import had unsupported elements."

**Why `completedAt`:** Cleaner than inferring from `updatedAt`. Enables monitoring ("how long did this import take?") and future cleanup jobs.

### Modified table: `memory_items`

New column: `importJobId uuid nullable references file_import_jobs(id) on delete set null`

Enables: traceability ("show all items from this import"), future bulk-reject by job, rollback support.

**Migration:** Both schema changes require `pnpm db:generate` to produce a Drizzle migration file. No raw SQL — Drizzle only (per CLAUDE.md rule #1).

---

## API Routes

### `POST /companies/:companyId/memory/import-file`

Accepts `multipart/form-data`:
- `file` — the file (required)
- `departmentId` — uuid (optional)
- `projectId` — uuid (optional)
- `defaultLayer` — string (optional, default `domain`)
- `defaultCategory` — string (optional, default `reference`)

Validation:
- MIME type must be supported: `application/pdf`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `text/plain`
- File size limit: 50MB (env-configurable, matches existing asset limit)
- RBAC: founder only

Flow:
1. Upload file to StorageService
2. Insert `file_import_jobs` row with `status: "pending"`
3. Return `202 { jobId, fileName }`

### `GET /companies/:companyId/memory/import-jobs/:jobId`

Returns: `{ id, status, fileName, itemCount, errorMessage, parserWarnings, createdAt, completedAt }`

Used by UI for polling.

---

## Worker

**File:** `server/src/services/file-import.ts`

**Interval:** 15 seconds. Note: `processEmbeddingQueue` is defined in the codebase but not currently scheduled on any interval in production. This worker establishes the first actively-scheduled background job of this type — the interval is wired in `index.ts` explicitly.

**Concurrency:** 3 jobs per tick

**Retry policy:** max 3 attempts with exponential backoff via `retryAfter` timestamp column
- Attempt 1 failure → `retryAfter = NOW() + 15s`, `retryCount = 1`
- Attempt 2 failure → `retryAfter = NOW() + 60s`, `retryCount = 2`
- Attempt 3 failure → `status = "failed"`, `errorMessage` set, `retryCount = 3`
- Worker query: `WHERE status = 'pending' AND (retryAfter IS NULL OR retryAfter <= NOW())`

**Stuck job recovery:** On worker startup, any job in `processing` status is reset to `pending` with `retryAfter = NULL` (handles server crash mid-import).

### Worker tick pseudocode

```
startup: UPDATE file_import_jobs SET status='pending' WHERE status='processing'

tick:
  jobs = SELECT * FROM file_import_jobs
         WHERE status='pending' ORDER BY createdAt ASC LIMIT 3

  for each job:
    mark processing
    try:
      fileBuffer = storageService.getObject(job.companyId, job.storageKey)  // actual signature
      text = extractTextFromBuffer(fileBuffer, job.mimeType)
      processorType = selectProcessorType(llmAvailable)  // llm_extraction or text_chunking
      items = extractItemsFromText(text, job, db)        // THE SEAM
      bulk insert items into memory_items with importJobId
      mark done, set completedAt, set itemCount
    catch:
      increment retryCount
      if retryCount >= 3: mark failed, set errorMessage, set completedAt
      else: mark pending, set retryAfter = NOW() + backoff(retryCount)
```

---

## Stage 1 — Text Extraction

| MIME type | Library | Method |
|---|---|---|
| `application/pdf` | `pdf-parse` | `parse(buffer).then(r => r.text)` |
| `application/vnd...docx` | `mammoth` | `convertToHtml(buffer)` → `text.replace(/<[^>]+>/g, '\n')` + whitespace normalization, warnings → `parserWarnings` |
| `text/plain` | native | `buffer.toString("utf-8")` |

Mammoth uses `convertToHtml()` (not `extractRawText()`) so heading structure is available in the HTML before stripping — this HTML is used in-memory during Stage 1 only and is NOT stored in the DB. Only mammoth's warning strings array is persisted to `parserWarnings`. Future processors that need the HTML can re-run mammoth from the stored file (via storageKey).

---

## Stage 2 — Item Extraction (The Seam)

**Function:** `extractItemsFromText(text, job, db)`

```typescript
// TODO: Commander sub-agent extraction — swap this function when
// the Commander sub-agent architecture lands for Discussions.
// processorType will be "commander_extraction" in that path.
async function extractItemsFromText(text, job, db) {
  // LLM availability: getProviderApiKey() from internal-agent/providers
  // (same function used by extractionService internally — not resolveApiKey
  //  which is used by the embeddings worker for a different provider path)
  const apiKey = await getProviderApiKey(db, job.companyId);
  if (apiKey) {
    // Path A: new extractFromRawText() method added to extractionService
    // (extraction.ts currently only accepts Discussion entries — we add
    //  a lower-level extractFromRawText(text, opts) that the Discussion
    //  path and this path both call into)
    return extractionService(db).extractFromRawText(text, {
      companyId: job.companyId,
      departmentId: job.departmentId,
    });
  }

  // Path B: paragraph chunking fallback (no API key required)
  return chunkTextToParagraphs(text, job);
}
```

**`extractionService` change required:** Add `extractFromRawText(text, opts)` to `server/src/services/extraction.ts`. The existing `extractFromDiscussionEntry()` becomes a thin wrapper that passes entry text into `extractFromRawText()`. No breaking change.

**Paragraph chunking rules (fallback):**
1. Split on double newline
2. Drop chunks under 30 chars (headers, noise)
3. Merge consecutive chunks under 100 chars
4. Split chunks over 1500 chars at sentence boundary
5. Cap hard at 2000 chars
6. Title = first sentence (max 80 chars, trimmed at word boundary + `…`)

**Items created (both paths):**
- `status: "pending"`, `source: "import"`
- `sourceContext: "file:<fileName>"`
- `importJobId`, `companyId`, `departmentId`, `projectId` from job
- `category`, `layer` from `job.defaultCategory` / `job.defaultLayer`
  (LLM path may override per-item based on content)

---

## Packages to Install (server)

```
pdf-parse
mammoth
@types/pdf-parse  (dev)
@types/mammoth    (dev)
```

---

## Service Exports

`server/src/services/file-import.ts` exports:
- `fileImportService(db, storageService)` — CRUD on `file_import_jobs`
- `processFileImportQueue(db, storageService)` — worker function
- `extractTextFromBuffer(buffer, mimeType)` — Stage 1
- `extractItemsFromText(text, job, db)` — Stage 2 seam

`server/src/services/index.ts` — add:
```typescript
export { fileImportService, processFileImportQueue } from "./file-import.js";
```

---

## Startup Wiring

`server/src/index.ts` — alongside `processEmbeddingQueue`:
```typescript
const FILE_IMPORT_INTERVAL_MS = 15_000;
setInterval(() => {
  void processFileImportQueue(db, storageService)
    .catch(err => logger.warn({ err }, "file import queue tick failed"));
}, FILE_IMPORT_INTERVAL_MS);
void processFileImportQueue(db, storageService).catch(() => {}); // immediate on startup
```

`server/src/app.ts` — add route:
```typescript
import { fileImportRoutes } from "./routes/file-import.js";
api.use(fileImportRoutes(db, storageService));
```

`storageService` is already threaded through `app.ts` — no new plumbing needed.

---

## UI

**Location:** `Memory.tsx` toolbar — new "Import from file" button next to "Starter templates"

**Flow:**
```
Click "Import from file"
  → native file picker (accept=".pdf,.docx,.txt")
  → optional: department/project scope picker
  → optional: layer override (default: domain)
  → POST /companies/:cid/memory/import-file
  → toast: "Importing filename.pdf…" with spinner

Poll GET .../import-jobs/:jobId every 3s
  → processing → keep polling
  → done       → toast: "23 items added to Pending review"
                  invalidate memory.pending query key
  → failed     → toast error: errorMessage
```

**New files:**
- `ui/src/api/fileImport.ts` — `upload()` + `getJob()`
- Query key: `queryKeys.fileImport.job(companyId, jobId)`

**No new page** — everything inline in Memory.tsx. Imported items surface in Pending tab naturally.

**Client-side guards:**
- File > 50MB → reject before upload
- Unsupported type → file picker `accept` attribute + server 400 fallback

---

## Future Processor Types

The `processorType` column reserves these slots:

| processorType | File types | When |
|---|---|---|
| `llm_extraction` | PDF, DOCX, TXT | Now |
| `text_chunking` | PDF, DOCX, TXT (fallback) | Now |
| `commander_extraction` | Any | When Commander sub-agent lands |
| `ocr` | Images (JPEG, PNG, WEBP) | Phase N |
| `transcription` | Audio/Video (MP4, MP3) | Phase N |
| `spreadsheet_parse` | Excel, CSV | Phase N |
| `slide_extraction` | PPT, PPTX | Phase N |

Each new processor type gets its own `extractItemsFromText` branch — no schema changes required.

---

## Testing

- `server/src/__tests__/file-import-service.test.ts`
  - Worker: picks up pending jobs, marks done, increments retryCount on failure, resets stuck jobs on startup
  - Text extraction: PDF text extraction, DOCX HTML stripping, TXT passthrough
  - Chunking: paragraph split, short chunk merge, long chunk split, 30-char minimum
  - Item shape: correct fields, importJobId set, status pending

- `server/src/__tests__/file-import-routes.test.ts`
  - POST: rejects unsupported MIME types, enforces file size limit, returns 202 with jobId
  - GET: returns correct job status shape

---

## Out of Scope

- Re-processing a failed job from the UI
- Deleting an import job + its items
- Multi-file batch upload
- Progress percentage (only status polling)
- Webhook/push notification on completion (polling is sufficient for Phase 4.5)
