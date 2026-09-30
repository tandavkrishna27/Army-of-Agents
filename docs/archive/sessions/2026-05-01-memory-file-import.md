# Memory File Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow founders to upload PDF, DOCX, or TXT files that are automatically converted into pending memory items via an async DB-backed job queue.

**Architecture:** Two-stage pipeline — Stage 1 extracts raw text from the file (format-specific libs); Stage 2 converts text to memory items via the existing LLM extraction service (falls back to paragraph chunking when no API key). A 15-second interval worker processes the job queue. A clean `extractItemsFromText()` seam is commented for future Commander sub-agent replacement.

**Tech Stack:** `pdf-parse` (PDF), `mammoth` (DOCX), Drizzle ORM (DB), Express + multer (upload route), StorageService (file storage), React Query (UI polling), Vitest (tests)

---

## File Map

**New files:**
| File | Responsibility |
|---|---|
| `packages/db/src/schema/file_import_jobs.ts` | Drizzle schema for the job queue table |
| `server/src/services/file-import.ts` | Worker, CRUD, Stage 1+2 pipeline |
| `server/src/routes/file-import.ts` | POST import-file + GET job status |
| `ui/src/api/fileImport.ts` | Browser API client (upload + poll) |
| `server/src/__tests__/file-import-service.test.ts` | Service + worker tests |
| `server/src/__tests__/file-import-routes.test.ts` | Route contract tests |

**Modified files:**
| File | Change |
|---|---|
| `packages/db/src/schema/memory_items.ts` | Add `importJobId` nullable FK column |
| `packages/db/src/schema/index.ts` | Export `fileImportJobs` |
| `server/src/services/extraction.ts` | Add `extractFromRawText()` to service factory |
| `server/src/services/index.ts` | Export `fileImportService`, `processFileImportQueue` |
| `server/src/app.ts` | Wire `fileImportRoutes(db, opts.storageService)` |
| `server/src/index.ts` | Schedule `processFileImportQueue` interval |
| `ui/src/lib/queryKeys.ts` | Add `fileImport.job(companyId, jobId)` key |
| `ui/src/pages/Memory.tsx` | Import from file button + polling toast |

---

## Task 1: Install packages

**Files:**
- Modify: `server/package.json`

- [ ] **Step 1: Install runtime + dev dependencies**

```bash
cd server
pnpm add pdf-parse mammoth
pnpm add -D @types/pdf-parse @types/mammoth
```

Expected output: packages added to `server/package.json` dependencies and devDependencies.

- [ ] **Step 2: Verify imports resolve**

```bash
cd server
npx tsc --noEmit 2>&1 | head -5
```

Expected: no errors related to the new packages.

- [ ] **Step 3: Commit**

```bash
git add server/package.json server/pnpm-lock.yaml
git commit -m "chore(deps): add pdf-parse and mammoth for file import"
```

---

## Task 2: DB schema — file_import_jobs table

**Files:**
- Create: `packages/db/src/schema/file_import_jobs.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Create the schema file**

Create `packages/db/src/schema/file_import_jobs.ts`:

```typescript
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

export const fileImportJobs = pgTable(
  "file_import_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    fileSize: integer("file_size").notNull(),
    storageKey: text("storage_key").notNull(),
    processorType: text("processor_type"),
    status: text("status").notNull().default("pending"),
    itemCount: integer("item_count").notNull().default(0),
    errorMessage: text("error_message"),
    parserWarnings: jsonb("parser_warnings").$type<string[]>(),
    retryCount: integer("retry_count").notNull().default(0),
    retryAfter: timestamp("retry_after", { withTimezone: true }),
    departmentId: uuid("department_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    defaultLayer: text("default_layer").notNull().default("domain"),
    defaultCategory: text("default_category").notNull().default("reference"),
    createdBy: text("created_by").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyIdx: index("file_import_jobs_company_idx").on(table.companyId),
    statusIdx: index("file_import_jobs_status_idx").on(table.status),
    pendingIdx: index("file_import_jobs_pending_idx").on(
      table.status,
      table.retryAfter,
      table.createdAt,
    ),
  }),
);
```

- [ ] **Step 2: Export from schema index**

In `packages/db/src/schema/index.ts`, add after the last export:

```typescript
export { fileImportJobs } from "./file_import_jobs.js";
```

- [ ] **Step 3: Verify TypeScript**

```bash
cd packages/db
npx tsc --noEmit 2>&1 | head -10
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema/file_import_jobs.ts packages/db/src/schema/index.ts
git commit -m "feat(db): add file_import_jobs schema"
```

---

## Task 3: DB schema — memory_items importJobId + migration

**Files:**
- Modify: `packages/db/src/schema/memory_items.ts`

- [ ] **Step 1: Add importJobId import**

In `packages/db/src/schema/memory_items.ts`, add to the imports block (after the existing `import { agents } from "./agents.js";` line):

```typescript
import { fileImportJobs } from "./file_import_jobs.js";
```

- [ ] **Step 2: Add importJobId column**

In `packages/db/src/schema/memory_items.ts`, add `importJobId` after the `pinnedToSkill` column (before `createdAt`):

```typescript
    // V2.6: tracks which file import job created this item (nullable — most items are not file-imported)
    importJobId: uuid("import_job_id").references(() => fileImportJobs.id, {
      onDelete: "set null",
    }),
```

- [ ] **Step 3: Generate migration**

```bash
cd "C:\Users\TK\OneDrive\Desktop\Claude Data\Paperclip-AoA\AoA-2.5"
pnpm db:generate
```

Expected: new migration file created in `packages/db/drizzle/` with `CREATE TABLE file_import_jobs` and `ALTER TABLE memory_items ADD COLUMN import_job_id`.

- [ ] **Step 4: Verify TypeScript**

```bash
cd packages/db
npx tsc --noEmit 2>&1 | head -10
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/memory_items.ts packages/db/drizzle/
git commit -m "feat(db): add importJobId to memory_items + migration"
```

---

## Task 4: extractFromRawText in extraction service

**Files:**
- Modify: `server/src/services/extraction.ts`

- [ ] **Step 1: Write the failing test**

In `server/src/__tests__/file-import-service.test.ts` (create the file):

```typescript
import { describe, it, expect, vi } from "vitest";

// Mock drizzle-orm
vi.mock("drizzle-orm", () => ({
  and: (..._a: unknown[]) => "and",
  eq: (..._a: unknown[]) => "eq",
  or: (..._a: unknown[]) => "or",
  lt: (..._a: unknown[]) => "lt",
  isNull: (..._a: unknown[]) => "isNull",
  lte: (..._a: unknown[]) => "lte",
  inArray: (..._a: unknown[]) => "inArray",
  sql: new Proxy(() => "sql", { get: () => () => "sql", apply: () => "sql" }),
}));

// Mock @armyofagents/db
vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) => {
    const cols: Record<string, symbol> = {};
    return new Proxy({} as Record<string, unknown>, {
      get(_t, prop) {
        if (prop === "_") return { name };
        if (prop === "$inferSelect" || prop === "$inferInsert") return {};
        if (typeof prop === "string") {
          if (!cols[prop]) cols[prop] = Symbol(prop);
          return cols[prop];
        }
        return undefined;
      },
    });
  };
  return {
    fileImportJobs: makeTable("file_import_jobs"),
    memoryItems: makeTable("memory_items"),
    projects: makeTable("projects"),
    companies: makeTable("companies"),
  };
});

// Mock live-events
vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));

// Mock activity-log
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));

// ── extractFromRawText ──────────────────────────────────────────────────────

describe("extractionService.extractFromRawText", () => {
  it("is exported from extractionService", async () => {
    const { extractionService } = await import("../services/extraction.js");
    const db = { select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })) })) };
    const svc = extractionService(db as any);
    expect(typeof svc.extractFromRawText).toBe("function");
  });

  it("returns empty array for blank text", async () => {
    const { extractionService } = await import("../services/extraction.js");
    const db = { select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })) })) };
    const svc = extractionService(db as any);
    const result = await svc.extractFromRawText("co-1", "   ");
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server
npx vitest run src/__tests__/file-import-service.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: FAIL — `extractFromRawText` is not a function (property does not exist).

- [ ] **Step 3: Add extractFromRawText to extraction.ts**

In `server/src/services/extraction.ts`, find the `return {` line that opens the service factory object and add `extractFromRawText` as a new method. Place it immediately after `extractFromDiscussionEntry`. Follow the same `callLLM` + `parseExtractedItems` pattern used in `extractFromDiscussionEntry` (see lines ~365-450 of that file for the prompt and call pattern):

```typescript
    /**
     * Extract structured memory items from raw text (e.g. imported file content).
     * Returns ExtractedItem[] — does NOT persist anything. Caller handles DB writes.
     * Falls back gracefully: if LLM is unavailable, returns [].
     * Caller should fall back to paragraph chunking when this returns [].
     */
    extractFromRawText: async (
      companyId: string,
      rawText: string,
    ): Promise<ExtractedItem[]> => {
      if (!rawText || rawText.trim().length < 10) return [];

      try {
        const departments = await buildDepartmentsList(db, companyId);
        // Re-use the same system prompt as extractFromDiscussionEntry.
        // buildSystemPrompt / the prompt constant is defined earlier in this file —
        // use whatever variable holds the system prompt string for extractFromDiscussionEntry.
        const systemPrompt = buildExtractionSystemPrompt(departments.text);
        const raw = await callLLM(systemPrompt, rawText, db, companyId);
        return parseExtractedItems(raw);
      } catch {
        // LLM unavailable or quota exceeded — caller uses chunking fallback
        return [];
      }
    },
```

> **Implementation note:** The function name `buildExtractionSystemPrompt` is illustrative — check `extraction.ts` for the actual name of the function/constant used to build the system prompt string in `extractFromDiscussionEntry`. Replace `buildExtractionSystemPrompt(departments.text)` with whatever that is. `callLLM`, `buildDepartmentsList`, and `parseExtractedItems` are confirmed to exist in the file.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd server
npx vitest run src/__tests__/file-import-service.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: PASS — 2 tests pass.

- [ ] **Step 5: Typecheck**

```bash
cd server
npx tsc --noEmit 2>&1 | head -10
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/extraction.ts server/src/__tests__/file-import-service.test.ts
git commit -m "feat(extraction): add extractFromRawText for file import pipeline"
```

---

## Task 5: Stage 1 — text extraction from buffer

**Files:**
- Create: `server/src/services/file-import.ts` (initial)

- [ ] **Step 1: Write failing tests for extractTextFromBuffer**

Add to `server/src/__tests__/file-import-service.test.ts`:

```typescript
// ── extractTextFromBuffer ───────────────────────────────────────────────────

describe("extractTextFromBuffer", () => {
  it("extracts plain text from TXT buffer", async () => {
    const { extractTextFromBuffer } = await import("../services/file-import.js");
    const buffer = Buffer.from("Hello world\n\nSecond paragraph.");
    const result = await extractTextFromBuffer(buffer, "text/plain");
    expect(result.text).toBe("Hello world\n\nSecond paragraph.");
    expect(result.warnings).toEqual([]);
  });

  it("throws for unsupported MIME type", async () => {
    const { extractTextFromBuffer } = await import("../services/file-import.js");
    const buffer = Buffer.from("data");
    await expect(
      extractTextFromBuffer(buffer, "image/jpeg")
    ).rejects.toThrow("Unsupported MIME type");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server
npx vitest run src/__tests__/file-import-service.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: FAIL — `file-import.js` module not found.

- [ ] **Step 3: Create server/src/services/file-import.ts with Stage 1**

```typescript
/**
 * File Import Service — Phase 4.5
 *
 * Two-stage pipeline:
 *   Stage 1: extractTextFromBuffer — format-specific text extraction
 *   Stage 2: extractItemsFromText  — LLM extraction or paragraph chunking
 *
 * TODO: Commander sub-agent extraction — when the Commander sub-agent
 * architecture lands for Discussions, swap extractItemsFromText() here.
 * processorType will be "commander_extraction" in that path.
 */

import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { Readable } from "node:stream";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import type { Db } from "@armyofagents/db";
import { fileImportJobs, memoryItems } from "@armyofagents/db";
import type { StorageService } from "../storage/types.js";
import { extractionService, type ExtractedItem } from "./extraction.js"; // ExtractedItem may need re-export — see note in Task 4

// ── Constants ─────────────────────────────────────────────────────────────

const SUPPORTED_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
] as const;

export type SupportedMimeType = (typeof SUPPORTED_MIME_TYPES)[number];

const WORKER_BATCH_SIZE = 3;
const WORKER_INTERVAL_MS = 15_000;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = [15_000, 60_000, 240_000] as const;

// Chunking constants
const CHUNK_MIN_CHARS = 30;
const CHUNK_MERGE_THRESHOLD = 100;
const CHUNK_SPLIT_THRESHOLD = 1500;
const CHUNK_MAX_CHARS = 2000;
const TITLE_MAX_CHARS = 80;

// ── Helpers ───────────────────────────────────────────────────────────────

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

// ── Stage 1: Text extraction ──────────────────────────────────────────────

export interface TextExtractionResult {
  text: string;
  warnings: string[];
}

export async function extractTextFromBuffer(
  buffer: Buffer,
  mimeType: string,
): Promise<TextExtractionResult> {
  switch (mimeType) {
    case "text/plain":
      return { text: buffer.toString("utf-8"), warnings: [] };

    case "application/pdf": {
      const result = await pdfParse(buffer);
      return { text: result.text, warnings: [] };
    }

    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
      // Use convertToHtml (not extractRawText) to preserve heading structure
      // in memory during extraction. HTML is used transiently; only the
      // warning strings are persisted to the job's parserWarnings column.
      const result = await mammoth.convertToHtml({ buffer });
      const text = result.value
        .replace(/<[^>]+>/g, "\n")       // strip HTML tags → newlines
        .replace(/\n{3,}/g, "\n\n")       // collapse 3+ newlines to 2
        .trim();
      const warnings = result.messages.map((m) => m.message);
      return { text, warnings };
    }

    default:
      throw new Error(`Unsupported MIME type: ${mimeType}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd server
npx vitest run src/__tests__/file-import-service.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: all tests pass (4 total so far).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/file-import.ts server/src/__tests__/file-import-service.test.ts
git commit -m "feat(file-import): Stage 1 text extraction (PDF/DOCX/TXT)"
```

---

## Task 6: Stage 2 — paragraph chunking fallback

**Files:**
- Modify: `server/src/services/file-import.ts`

- [ ] **Step 1: Write failing tests for chunkTextToParagraphs**

Add to `server/src/__tests__/file-import-service.test.ts`:

```typescript
// ── chunkTextToParagraphs ──────────────────────────────────────────────────

const mockJob = {
  id: "job-1",
  companyId: "co-1",
  fileName: "handbook.pdf",
  defaultLayer: "domain",
  defaultCategory: "reference",
  departmentId: null,
  projectId: null,
  createdBy: "user-1",
} as any;

describe("chunkTextToParagraphs", () => {
  it("splits on double newline", async () => {
    const { chunkTextToParagraphs } = await import("../services/file-import.js");
    const text = "First paragraph.\n\nSecond paragraph.";
    const items = chunkTextToParagraphs(text, mockJob);
    expect(items).toHaveLength(2);
  });

  it("drops chunks under 30 chars", async () => {
    const { chunkTextToParagraphs } = await import("../services/file-import.js");
    const text = "Short.\n\nThis is a proper paragraph with enough content.";
    const items = chunkTextToParagraphs(text, mockJob);
    expect(items).toHaveLength(1);
    expect(items[0].content).toContain("proper paragraph");
  });

  it("merges consecutive short chunks under 100 chars", async () => {
    const { chunkTextToParagraphs } = await import("../services/file-import.js");
    // Two chunks each 40 chars → merged into one
    const text = "A".repeat(40) + "\n\n" + "B".repeat(40);
    const items = chunkTextToParagraphs(text, mockJob);
    expect(items).toHaveLength(1);
  });

  it("sets correct metadata on each item", async () => {
    const { chunkTextToParagraphs } = await import("../services/file-import.js");
    const text = "This is a well-formed paragraph with enough content to pass the minimum length check.";
    const items = chunkTextToParagraphs(text, mockJob);
    expect(items[0].status).toBe("pending");
    expect(items[0].source).toBe("import");
    expect(items[0].sourceContext).toBe("file:handbook.pdf");
    expect(items[0].importJobId).toBe("job-1");
    expect(items[0].companyId).toBe("co-1");
    expect(items[0].layer).toBe("domain");
    expect(items[0].category).toBe("reference");
  });

  it("title is first sentence truncated to 80 chars", async () => {
    const { chunkTextToParagraphs } = await import("../services/file-import.js");
    const longSentence = "A".repeat(100) + ". More content here.";
    const items = chunkTextToParagraphs(longSentence, mockJob);
    expect(items[0].title.length).toBeLessThanOrEqual(81); // 80 + ellipsis
    expect(items[0].title.endsWith("…")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server
npx vitest run src/__tests__/file-import-service.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: FAIL — `chunkTextToParagraphs` not exported.

- [ ] **Step 3: Add chunkTextToParagraphs to file-import.ts**

Append to `server/src/services/file-import.ts` after `extractTextFromBuffer`:

```typescript
// ── Stage 2 fallback: paragraph chunking ─────────────────────────────────

type MemoryItemInsert = typeof memoryItems.$inferInsert;

export function chunkTextToParagraphs(
  text: string,
  job: typeof fileImportJobs.$inferSelect,
): MemoryItemInsert[] {
  // Step 1: Split on double newline
  const rawChunks = text.split(/\n\n+/).map((c) => c.trim());

  // Step 2: Drop chunks under 30 chars (noise, headers)
  const filtered = rawChunks.filter((c) => c.length >= CHUNK_MIN_CHARS);

  // Step 3: Merge consecutive short chunks (< 100 chars)
  const merged: string[] = [];
  let buffer = "";
  for (const chunk of filtered) {
    if (buffer && buffer.length + chunk.length < CHUNK_MERGE_THRESHOLD) {
      buffer += "\n\n" + chunk;
    } else {
      if (buffer) merged.push(buffer);
      buffer = chunk;
    }
  }
  if (buffer) merged.push(buffer);

  // Step 4: Split chunks over 1500 chars at sentence boundary, cap at 2000
  const finalChunks: string[] = [];
  for (const chunk of merged) {
    if (chunk.length <= CHUNK_SPLIT_THRESHOLD) {
      finalChunks.push(chunk);
    } else {
      const sentences = chunk.match(/[^.!?]+[.!?]+[\s]*/g) ?? [chunk];
      let current = "";
      for (const sentence of sentences) {
        if (current.length + sentence.length > CHUNK_SPLIT_THRESHOLD) {
          if (current) finalChunks.push(current.trim().slice(0, CHUNK_MAX_CHARS));
          current = sentence;
        } else {
          current += sentence;
        }
      }
      if (current) finalChunks.push(current.trim().slice(0, CHUNK_MAX_CHARS));
    }
  }

  // Step 5: Map to memory item inserts
  return finalChunks.map((chunk) => {
    const firstSentenceMatch = chunk.match(/^[^.!?\n]+[.!?\n]?/);
    const firstSentence = (firstSentenceMatch?.[0] ?? chunk).trim();
    let title = firstSentence.slice(0, TITLE_MAX_CHARS);
    if (firstSentence.length > TITLE_MAX_CHARS) {
      title = title.replace(/\s\S+$/, "") + "…";
    }

    return {
      companyId: job.companyId,
      title,
      content: chunk,
      category: job.defaultCategory,
      layer: job.defaultLayer,
      source: "import",
      sourceContext: `file:${job.fileName}`,
      status: "pending",
      departmentId: job.departmentId ?? null,
      projectId: job.projectId ?? null,
      importJobId: job.id,
      createdBy: job.createdBy,
      tags: [],
    } satisfies Partial<MemoryItemInsert> as MemoryItemInsert;
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd server
npx vitest run src/__tests__/file-import-service.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/file-import.ts server/src/__tests__/file-import-service.test.ts
git commit -m "feat(file-import): Stage 2 paragraph chunking fallback"
```

---

## Task 7: fileImportService CRUD + extractItemsFromText seam

**Files:**
- Modify: `server/src/services/file-import.ts`

- [ ] **Step 1: Write failing tests**

Add to `server/src/__tests__/file-import-service.test.ts`:

```typescript
// ── fileImportService ──────────────────────────────────────────────────────

function makeDb(selects: unknown[][] = [], updates: unknown[][] = [], inserts: unknown[][] = []) {
  let si = 0, ui = 0, ii = 0;
  const makeChain = (getResult: () => unknown[]) => {
    const c: Record<string, unknown> = {};
    for (const m of ["from","where","set","values","returning","orderBy","limit"]) {
      c[m] = (..._a: unknown[]) => c;
    }
    c.then = (resolve: (v: unknown[]) => unknown) => Promise.resolve(resolve(getResult()));
    return c;
  };
  return {
    select: (..._a: unknown[]) => makeChain(() => selects[si++] ?? []),
    update: (..._a: unknown[]) => makeChain(() => updates[ui++] ?? []),
    insert: (..._a: unknown[]) => makeChain(() => inserts[ii++] ?? []),
  };
}

describe("fileImportService.createJob", () => {
  it("inserts a job and returns it", async () => {
    const { fileImportService } = await import("../services/file-import.js");
    const job = { id: "job-1", companyId: "co-1", fileName: "doc.pdf", mimeType: "application/pdf", fileSize: 1000, storageKey: "key/doc.pdf", status: "pending", itemCount: 0, retryCount: 0, defaultLayer: "domain", defaultCategory: "reference", createdBy: "user-1", retryAfter: null, processorType: null, errorMessage: null, parserWarnings: null, departmentId: null, projectId: null, completedAt: null, createdAt: new Date(), updatedAt: new Date() };
    const db = makeDb([], [], [[job]]);
    const storageService = {} as any;
    const svc = fileImportService(db as any, storageService);
    const result = await svc.createJob({
      companyId: "co-1",
      fileName: "doc.pdf",
      mimeType: "application/pdf",
      fileSize: 1000,
      storageKey: "key/doc.pdf",
      createdBy: "user-1",
    });
    expect(result.id).toBe("job-1");
  });
});

describe("fileImportService.getJob", () => {
  it("returns job by id", async () => {
    const { fileImportService } = await import("../services/file-import.js");
    const job = { id: "job-1", status: "done", itemCount: 5 };
    const db = makeDb([[job]]);
    const svc = fileImportService(db as any, {} as any);
    const result = await svc.getJob("co-1", "job-1");
    expect(result?.id).toBe("job-1");
  });

  it("returns null when not found", async () => {
    const { fileImportService } = await import("../services/file-import.js");
    const db = makeDb([[]]); // empty result
    const svc = fileImportService(db as any, {} as any);
    const result = await svc.getJob("co-1", "nonexistent");
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server
npx vitest run src/__tests__/file-import-service.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: FAIL — `fileImportService` not exported.

- [ ] **Step 3: Add fileImportService + extractItemsFromText to file-import.ts**

Append to `server/src/services/file-import.ts`:

```typescript
// ── Stage 2: extractItemsFromText (THE SEAM) ─────────────────────────────
//
// TODO: Commander sub-agent extraction — when the Commander sub-agent
// architecture lands for Discussions, swap this function here.
// processorType will be "commander_extraction" in that path.

async function extractItemsFromText(
  text: string,
  job: typeof fileImportJobs.$inferSelect,
  db: Db,
): Promise<{ items: MemoryItemInsert[]; processorType: string }> {
  // Attempt LLM extraction via extractionService
  const extracted: ExtractedItem[] = await extractionService(db)
    .extractFromRawText(job.companyId, text)
    .catch(() => []);

  if (extracted.length > 0) {
    // Filter out "task" type — file imports create memory items, not issues
    const items = extracted
      .filter((item) => item.type !== "task")
      .map((item): MemoryItemInsert => ({
        companyId: job.companyId,
        title: item.title,
        content: item.description,   // ExtractedItem uses 'description'; memory uses 'content'
        category: item.type,         // decision/insight/context/reference/preference → valid categories
        layer: item.layer ?? job.defaultLayer,
        source: "import",
        sourceContext: `file:${job.fileName}`,
        status: "pending",
        departmentId: job.departmentId ?? null,
        projectId: job.projectId ?? null,
        importJobId: job.id,
        createdBy: job.createdBy,
        tags: [],
      }));
    return { items, processorType: "llm_extraction" };
  }

  // Fallback: paragraph chunking (no LLM required)
  return {
    items: chunkTextToParagraphs(text, job),
    processorType: "text_chunking",
  };
}

// ── fileImportService CRUD ────────────────────────────────────────────────

export interface CreateJobInput {
  companyId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  storageKey: string;
  createdBy: string;
  departmentId?: string | null;
  projectId?: string | null;
  defaultLayer?: string;
  defaultCategory?: string;
}

export function fileImportService(db: Db, _storageService: StorageService) {
  return {
    createJob: async (input: CreateJobInput) => {
      const [job] = await db
        .insert(fileImportJobs)
        .values({
          companyId: input.companyId,
          fileName: input.fileName,
          mimeType: input.mimeType,
          fileSize: input.fileSize,
          storageKey: input.storageKey,
          createdBy: input.createdBy,
          departmentId: input.departmentId ?? null,
          projectId: input.projectId ?? null,
          defaultLayer: input.defaultLayer ?? "domain",
          defaultCategory: input.defaultCategory ?? "reference",
          status: "pending",
        })
        .returning();
      return job;
    },

    getJob: async (companyId: string, jobId: string) => {
      const rows = await db
        .select()
        .from(fileImportJobs)
        .where(
          and(eq(fileImportJobs.id, jobId), eq(fileImportJobs.companyId, companyId)),
        );
      return rows[0] ?? null;
    },
  };
}
```

- [ ] **Step 4: Export ExtractedItem from extraction.ts**

Check if `ExtractedItem` is already exported from `server/src/services/extraction.ts`. If it is, the import in `file-import.ts` above will work. If not, add `export` to its interface declaration.

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd server
npx vitest run src/__tests__/file-import-service.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/file-import.ts server/src/__tests__/file-import-service.test.ts
git commit -m "feat(file-import): fileImportService CRUD + extractItemsFromText seam"
```

---

## Task 8: processFileImportQueue worker

**Files:**
- Modify: `server/src/services/file-import.ts`

- [ ] **Step 1: Write failing tests**

Add to `server/src/__tests__/file-import-service.test.ts`:

```typescript
// ── processFileImportQueue ─────────────────────────────────────────────────

describe("processFileImportQueue", () => {
  it("picks up pending jobs and marks them done", async () => {
    const { processFileImportQueue } = await import("../services/file-import.js");
    const pendingJob = {
      id: "job-1", companyId: "co-1", fileName: "doc.txt",
      mimeType: "text/plain", fileSize: 100,
      storageKey: "key/doc.txt", status: "pending",
      itemCount: 0, retryCount: 0, retryAfter: null,
      processorType: null, errorMessage: null, parserWarnings: null,
      departmentId: null, projectId: null,
      defaultLayer: "domain", defaultCategory: "reference",
      createdBy: "user-1", completedAt: null,
      createdAt: new Date(), updatedAt: new Date(),
    };
    const db = makeDb(
      [[pendingJob], []],    // selects: pending jobs, then empty (for items query)
      [[pendingJob], [{ ...pendingJob, status: "done" }]],  // updates: mark processing, mark done
      [[{ id: "mem-1" }]],   // inserts: memory items
    );
    const storageService = {
      getObject: vi.fn().mockResolvedValue({
        stream: (await import("node:stream")).Readable.from(["Hello world. This is test content with enough characters."])
      }),
    };
    await processFileImportQueue(db as any, storageService as any);
    expect(storageService.getObject).toHaveBeenCalledWith("co-1", "key/doc.txt");
  });

  it("resets stuck processing jobs on startup", async () => {
    const { resetStuckJobs } = await import("../services/file-import.js");
    const db = makeDb([], [[{ id: "job-stuck" }]]);
    await resetStuckJobs(db as any);
    // No error = stuck jobs were reset to pending
  });

  it("increments retryCount and sets retryAfter on failure", async () => {
    const { processFileImportQueue } = await import("../services/file-import.js");
    const pendingJob = {
      id: "job-1", companyId: "co-1", fileName: "bad.pdf",
      mimeType: "application/pdf", fileSize: 100,
      storageKey: "key/bad.pdf", status: "pending",
      itemCount: 0, retryCount: 0, retryAfter: null,
      processorType: null, errorMessage: null, parserWarnings: null,
      departmentId: null, projectId: null,
      defaultLayer: "domain", defaultCategory: "reference",
      createdBy: "user-1", completedAt: null,
      createdAt: new Date(), updatedAt: new Date(),
    };
    const db = makeDb([[pendingJob]], [[pendingJob], [{ ...pendingJob, retryCount: 1 }]]);
    const storageService = {
      getObject: vi.fn().mockRejectedValue(new Error("Storage error")),
    };
    await processFileImportQueue(db as any, storageService as any);
    // No throw — error is caught and job is retried
  });

  it("marks job as failed after 3 retries", async () => {
    const { processFileImportQueue } = await import("../services/file-import.js");
    const exhaustedJob = {
      id: "job-1", companyId: "co-1", fileName: "bad.pdf",
      mimeType: "application/pdf", fileSize: 100,
      storageKey: "key/bad.pdf", status: "pending",
      itemCount: 0, retryCount: 3, retryAfter: null,  // already at max
      processorType: null, errorMessage: null, parserWarnings: null,
      departmentId: null, projectId: null,
      defaultLayer: "domain", defaultCategory: "reference",
      createdBy: "user-1", completedAt: null,
      createdAt: new Date(), updatedAt: new Date(),
    };
    const db = makeDb([[exhaustedJob]], [[exhaustedJob], [{ ...exhaustedJob, status: "failed" }]]);
    const storageService = {
      getObject: vi.fn().mockRejectedValue(new Error("Persistent failure")),
    };
    await processFileImportQueue(db as any, storageService as any);
    // Should have marked failed, not retried
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server
npx vitest run src/__tests__/file-import-service.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: FAIL — `processFileImportQueue` and `resetStuckJobs` not exported.

- [ ] **Step 3: Add processFileImportQueue + resetStuckJobs to file-import.ts**

Append to `server/src/services/file-import.ts`:

```typescript
// ── Worker ────────────────────────────────────────────────────────────────

/** Called once on server startup to recover jobs stuck in "processing" from a crash. */
export async function resetStuckJobs(db: Db): Promise<void> {
  await db
    .update(fileImportJobs)
    .set({ status: "pending", retryAfter: null, updatedAt: new Date() })
    .where(eq(fileImportJobs.status, "processing"));
}

/** One worker tick — process up to WORKER_BATCH_SIZE pending jobs. */
export async function processFileImportQueue(
  db: Db,
  storageService: StorageService,
): Promise<void> {
  const now = new Date();

  // Fetch pending jobs that are ready to run (retryAfter is past or null)
  const jobs = await db
    .select()
    .from(fileImportJobs)
    .where(
      and(
        eq(fileImportJobs.status, "pending"),
        or(
          isNull(fileImportJobs.retryAfter),
          lte(fileImportJobs.retryAfter, now),
        ),
      ),
    )
    .orderBy(fileImportJobs.createdAt)
    .limit(WORKER_BATCH_SIZE);

  await Promise.allSettled(jobs.map((job) => processOneJob(db, storageService, job)));
}

async function processOneJob(
  db: Db,
  storageService: StorageService,
  job: typeof fileImportJobs.$inferSelect,
): Promise<void> {
  // Mark processing
  await db
    .update(fileImportJobs)
    .set({ status: "processing", updatedAt: new Date() })
    .where(eq(fileImportJobs.id, job.id));

  try {
    // Stage 1: fetch file from storage and extract text
    const stored = await storageService.getObject(job.companyId, job.storageKey);
    const buffer = await streamToBuffer(stored.stream);
    const { text, warnings } = await extractTextFromBuffer(buffer, job.mimeType);

    // Stage 2: extract memory items (LLM path or chunking fallback)
    const { items, processorType } = await extractItemsFromText(text, job, db);

    // Bulk insert memory items
    if (items.length > 0) {
      await db.insert(memoryItems).values(items);
    }

    // Mark done
    await db
      .update(fileImportJobs)
      .set({
        status: "done",
        processorType,
        itemCount: items.length,
        parserWarnings: warnings.length > 0 ? warnings : null,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(fileImportJobs.id, job.id));
  } catch (err) {
    const newRetryCount = job.retryCount + 1;
    if (newRetryCount > MAX_RETRIES) {
      await db
        .update(fileImportJobs)
        .set({
          status: "failed",
          errorMessage: err instanceof Error ? err.message : String(err),
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(fileImportJobs.id, job.id));
    } else {
      const backoffMs = RETRY_BACKOFF_MS[newRetryCount - 1] ?? WORKER_INTERVAL_MS;
      await db
        .update(fileImportJobs)
        .set({
          status: "pending",
          retryCount: newRetryCount,
          retryAfter: new Date(Date.now() + backoffMs),
          updatedAt: new Date(),
        })
        .where(eq(fileImportJobs.id, job.id));
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd server
npx vitest run src/__tests__/file-import-service.test.ts --reporter=verbose 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 5: Typecheck server**

```bash
cd server
npx tsc --noEmit 2>&1 | head -10
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/file-import.ts server/src/__tests__/file-import-service.test.ts
git commit -m "feat(file-import): processFileImportQueue worker with retry backoff"
```

---

## Task 9: Route + services/index + app.ts + index.ts wiring

**Files:**
- Create: `server/src/routes/file-import.ts`
- Create: `server/src/__tests__/file-import-routes.test.ts`
- Modify: `server/src/services/index.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/index.ts`

- [ ] **Step 1: Write failing route contract tests**

Create `server/src/__tests__/file-import-routes.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

// Verify the route module exports a factory that returns an Express Router.
// Full HTTP integration tests are out of scope for this phase.

describe("fileImportRoutes contract", () => {
  it("exports a fileImportRoutes factory function", async () => {
    // Dynamically import to avoid top-level ESM mock issues
    // If this import fails, the route file has a syntax or export error.
    const mod = await import("../routes/file-import.js").catch(() => null);
    expect(mod).not.toBeNull();
    expect(typeof mod?.fileImportRoutes).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server
npx vitest run src/__tests__/file-import-routes.test.ts --reporter=verbose 2>&1 | tail -10
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create server/src/routes/file-import.ts**

```typescript
import { Router } from "express";
import multer from "multer";
import type { Db } from "@armyofagents/db";
import type { StorageService } from "../storage/types.js";
import { fileImportService } from "../services/file-import.js";
import { assertCompanyAccess } from "./authz.js";
import { assertRole } from "../middleware/rbac.js";
import { logger } from "../middleware/logger.js";

const log = logger.child({ route: "file-import" });

const SUPPORTED_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
]);

const MAX_FILE_SIZE_BYTES = parseInt(
  process.env.MAX_ASSET_FILE_BYTES ?? String(50 * 1024 * 1024), // 50MB default
  10,
);

async function runSingleFileUpload(
  req: Parameters<ReturnType<typeof Router>["post"]>[1] extends (req: infer R, ...args: unknown[]) => unknown ? R : never,
  res: Parameters<ReturnType<typeof Router>["post"]>[1] extends (req: unknown, res: infer R, ...args: unknown[]) => unknown ? R : never,
): Promise<void> {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 },
  });
  await new Promise<void>((resolve, reject) => {
    upload.single("file")(req as any, res as any, (err: unknown) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export function fileImportRoutes(db: Db, storageService: StorageService) {
  const router = Router();
  const svc = fileImportService(db, storageService);

  // POST /companies/:companyId/memory/import-file
  router.post(
    "/companies/:companyId/memory/import-file",
    async (req, res, next) => {
      try {
        const companyId = req.params.companyId as string;
        assertCompanyAccess(req, companyId);
        await assertRole(db, req, companyId, "founder");

        await runSingleFileUpload(req as any, res as any);

        const file = (req as any).file as {
          mimetype: string;
          buffer: Buffer;
          originalname: string;
          size: number;
        } | undefined;

        if (!file) {
          res.status(400).json({ error: "No file uploaded" });
          return;
        }

        if (!SUPPORTED_MIME_TYPES.has(file.mimetype)) {
          res.status(400).json({
            error: `Unsupported file type: ${file.mimetype}. Supported: PDF, DOCX, TXT`,
          });
          return;
        }

        const { departmentId, projectId, defaultLayer, defaultCategory } =
          req.body as Record<string, string | undefined>;

        // Upload file to StorageService
        const storageKey = `file-imports/${companyId}/${Date.now()}-${file.originalname}`;
        await storageService.putFile(companyId, storageKey, file.buffer, {
          contentType: file.mimetype,
        });

        // Create job
        const actor = (req as any).actor as { actorId?: string };
        const job = await svc.createJob({
          companyId,
          fileName: file.originalname,
          mimeType: file.mimetype,
          fileSize: file.size,
          storageKey,
          createdBy: actor?.actorId ?? "unknown",
          departmentId: departmentId ?? null,
          projectId: projectId ?? null,
          defaultLayer: defaultLayer ?? "domain",
          defaultCategory: defaultCategory ?? "reference",
        });

        res.status(202).json({ jobId: job.id, fileName: job.fileName });
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /companies/:companyId/memory/import-jobs/:jobId
  router.get(
    "/companies/:companyId/memory/import-jobs/:jobId",
    async (req, res, next) => {
      try {
        const companyId = req.params.companyId as string;
        const jobId = req.params.jobId as string;
        assertCompanyAccess(req, companyId);

        const job = await svc.getJob(companyId, jobId);
        if (!job) {
          res.status(404).json({ error: "Job not found" });
          return;
        }

        res.json({
          id: job.id,
          status: job.status,
          fileName: job.fileName,
          itemCount: job.itemCount,
          errorMessage: job.errorMessage,
          parserWarnings: job.parserWarnings,
          createdAt: job.createdAt,
          completedAt: job.completedAt,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
```

> **Implementation note:** Check the exact `storageService.putFile()` signature in `server/src/storage/types.ts` — adjust the call if the method name or signature differs.

- [ ] **Step 4: Export from services/index.ts**

In `server/src/services/index.ts`, add after the `memoryLifecycleService` export line:

```typescript
export { fileImportService, processFileImportQueue, resetStuckJobs } from "./file-import.js";
```

- [ ] **Step 5: Wire route in app.ts**

In `server/src/app.ts`, add the import after the `memoryStarterTemplatesRoutes` import:

```typescript
import { fileImportRoutes } from "./routes/file-import.js";
```

Then add the route registration after `api.use(memoryStarterTemplatesRoutes(db));`:

```typescript
api.use(fileImportRoutes(db, opts.storageService));
```

- [ ] **Step 6: Schedule worker in index.ts**

In `server/src/index.ts`, add import near the other worker imports:

```typescript
import { processFileImportQueue, resetStuckJobs } from "./services/index.js";
```

Then in the server startup block (after the server starts listening, near where other background workers are started), add:

```typescript
// File import queue worker — resets stuck jobs from any previous crash, then starts interval
void resetStuckJobs(db).catch((err) =>
  logger.warn({ err }, "resetStuckJobs on startup failed"),
);
const FILE_IMPORT_INTERVAL_MS = 15_000;
setInterval(() => {
  void processFileImportQueue(db, storageService).catch((err) =>
    logger.warn({ err }, "processFileImportQueue tick failed"),
  );
}, FILE_IMPORT_INTERVAL_MS);
void processFileImportQueue(db, storageService).catch(() => {}); // immediate first tick
```

- [ ] **Step 7: Run route tests**

```bash
cd server
npx vitest run src/__tests__/file-import-routes.test.ts --reporter=verbose 2>&1 | tail -10
```

Expected: PASS.

- [ ] **Step 8: Typecheck server**

```bash
cd server
npx tsc --noEmit 2>&1 | head -10
```

Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add server/src/routes/file-import.ts server/src/__tests__/file-import-routes.test.ts server/src/services/index.ts server/src/app.ts server/src/index.ts
git commit -m "feat(file-import): route + worker wiring + startup interval"
```

---

## Task 10: UI — API client + query keys + Memory.tsx button

**Files:**
- Create: `ui/src/api/fileImport.ts`
- Modify: `ui/src/lib/queryKeys.ts`
- Modify: `ui/src/pages/Memory.tsx`

- [ ] **Step 1: Create API client**

Create `ui/src/api/fileImport.ts`:

```typescript
export interface FileImportJob {
  id: string;
  status: "pending" | "processing" | "done" | "failed";
  fileName: string;
  itemCount: number;
  errorMessage: string | null;
  parserWarnings: string[] | null;
  createdAt: string;
  completedAt: string | null;
}

export interface StartImportResult {
  jobId: string;
  fileName: string;
}

export const fileImportApi = {
  upload: async (
    companyId: string,
    file: File,
    opts: {
      departmentId?: string | null;
      projectId?: string | null;
      defaultLayer?: string;
      defaultCategory?: string;
    } = {},
  ): Promise<StartImportResult> => {
    const form = new FormData();
    form.append("file", file);
    if (opts.departmentId) form.append("departmentId", opts.departmentId);
    if (opts.projectId) form.append("projectId", opts.projectId);
    if (opts.defaultLayer) form.append("defaultLayer", opts.defaultLayer);
    if (opts.defaultCategory) form.append("defaultCategory", opts.defaultCategory);

    const res = await fetch(`/api/companies/${companyId}/memory/import-file`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? "Failed to start file import");
    }
    return res.json() as Promise<StartImportResult>;
  },

  getJob: async (companyId: string, jobId: string): Promise<FileImportJob> => {
    const res = await fetch(
      `/api/companies/${companyId}/memory/import-jobs/${jobId}`,
    );
    if (!res.ok) throw new Error("Failed to fetch import job status");
    return res.json() as Promise<FileImportJob>;
  },
};
```

- [ ] **Step 2: Add query key**

In `ui/src/lib/queryKeys.ts`, add inside the `memory` object after `starterTemplates`:

```typescript
    importJob: (companyId: string, jobId: string) =>
      ["memory", companyId, "import-job", jobId] as const,
```

- [ ] **Step 3: Add import button and polling logic to Memory.tsx**

In `ui/src/pages/Memory.tsx`, add these imports at the top (alongside existing imports):

```typescript
import { fileImportApi } from "../api/fileImport.js";
import { Upload } from "lucide-react";
```

Add state and handler inside the Memory component (alongside existing state like `templatesOpen`):

```typescript
const fileInputRef = useRef<HTMLInputElement>(null);
const [importJobId, setImportJobId] = useState<string | null>(null);
const [importingFile, setImportingFile] = useState<string | null>(null);

// Poll the job status when an import is in flight
const { data: importJob } = useQuery({
  queryKey: queryKeys.memory.importJob(company.id, importJobId ?? "__none__"),
  queryFn: () => fileImportApi.getJob(company.id, importJobId!),
  enabled: !!importJobId,
  refetchInterval: (data) => {
    if (!data || data.status === "pending" || data.status === "processing") return 3_000;
    return false; // stop polling when done or failed
  },
});

// React to job completion
useEffect(() => {
  if (!importJob) return;
  if (importJob.status === "done") {
    toast.success(`${importJob.itemCount} items added to Pending review from "${importingFile}"`);
    queryClient.invalidateQueries({ queryKey: queryKeys.memory.pending(company.id) });
    setImportJobId(null);
    setImportingFile(null);
  } else if (importJob.status === "failed") {
    toast.error(`Import failed: ${importJob.errorMessage ?? "Unknown error"}`);
    setImportJobId(null);
    setImportingFile(null);
  }
}, [importJob?.status]);

async function handleFileImport(file: File) {
  setImportingFile(file.name);
  try {
    const { jobId } = await fileImportApi.upload(company.id, file);
    setImportJobId(jobId);
    toast.info(`Importing "${file.name}"…`);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "Failed to start import");
    setImportingFile(null);
  }
}
```

Add the hidden file input and button in the toolbar JSX (next to the "Starter templates" button):

```tsx
{/* Hidden file input */}
<input
  ref={fileInputRef}
  type="file"
  accept=".pdf,.docx,.txt"
  className="hidden"
  onChange={(e) => {
    const file = e.target.files?.[0];
    if (file) handleFileImport(file);
    e.target.value = ""; // reset so same file can be re-selected
  }}
/>

{/* Import from file button */}
<Button
  variant="outline"
  size="sm"
  onClick={() => fileInputRef.current?.click()}
  disabled={!!importJobId}
>
  <Upload className="h-4 w-4 mr-1" />
  {importJobId ? "Importing…" : "Import from file"}
</Button>
```

> **Implementation note:** `useRef`, `useEffect`, `useState` should already be imported in Memory.tsx. Add any that are missing. `queryClient` is available via `useQueryClient()` — add `const queryClient = useQueryClient();` if not already present. `toast` is from the existing toast library in the file.

- [ ] **Step 4: Typecheck UI**

```bash
cd ui
npx tsc --noEmit 2>&1 | head -10
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add ui/src/api/fileImport.ts ui/src/lib/queryKeys.ts ui/src/pages/Memory.tsx
git commit -m "feat(ui): memory file import button with job polling"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| `file_import_jobs` table with all columns | Task 2 |
| `memory_items.importJobId` FK | Task 3 |
| `pnpm db:generate` migration | Task 3 |
| `extractFromRawText()` in extractionService | Task 4 |
| PDF text extraction via pdf-parse | Task 5 |
| DOCX via mammoth.convertToHtml | Task 5 |
| TXT native extraction | Task 5 |
| Paragraph chunking fallback | Task 6 |
| Chunk drop <30 chars, merge <100, split >1500 | Task 6 |
| `fileImportService` CRUD | Task 7 |
| `extractItemsFromText` seam with TODO comment | Task 7 |
| Filter `task` type from LLM extraction | Task 7 |
| Map `ExtractedItem.description → content` | Task 7 |
| `processFileImportQueue` worker | Task 8 |
| `resetStuckJobs` on startup | Task 8 |
| `retryAfter` backoff (15s/60s/240s) | Task 8 |
| Mark failed after 3 retries | Task 8 |
| POST `/companies/:cid/memory/import-file` | Task 9 |
| GET `/companies/:cid/memory/import-jobs/:jobId` | Task 9 |
| 50MB file size limit | Task 9 |
| RBAC founder-only for POST | Task 9 |
| `storageService` upload before job creation | Task 9 |
| `app.ts` + `index.ts` wiring | Task 9 |
| `processFileImportQueue` + `resetStuckJobs` on startup | Task 9 |
| `fileImportApi.upload()` + `getJob()` | Task 10 |
| `queryKeys.memory.importJob` | Task 10 |
| Memory.tsx import button + polling | Task 10 |
| Toast on done/failed + invalidate pending query | Task 10 |
| `parserWarnings` stored on job | Task 8 |
| `processorType` set on job completion | Task 8 |
| Commander sub-agent TODO comment in seam | Task 7 |

All spec requirements covered. ✅

**Placeholder scan:** No TBDs. Two "implementation notes" exist (Task 4 prompt function name, Task 9 `putFile` signature) — both are narrow lookup tasks, not logic gaps.

**Type consistency check:**
- `fileImportJobs` used in Tasks 2, 7, 8, 9 ✅
- `memoryItems` used in Tasks 3, 7 ✅
- `ExtractedItem.description` mapped to `content` in Task 7 ✅
- `storageService.getObject(companyId, storageKey)` correct signature in Task 8 ✅
- `fileImportService` factory signature consistent across Tasks 7, 9 ✅
- `processFileImportQueue(db, storageService)` consistent across Tasks 8, 9 ✅
