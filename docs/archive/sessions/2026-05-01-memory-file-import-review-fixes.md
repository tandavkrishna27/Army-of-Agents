# Memory File Import — Code Review Fixes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 7 real issues identified in the Phase 4.5 code review — data quality bugs, silent error swallowing, structural duplication, a transaction safety hole, and missing route tests.

**Architecture:** All fixes are in existing files. No new files. Five cohesive tasks ordered so structural fixes (I1 import) land before the route tests that depend on them. TDD where the fix is observable through a unit test; direct implementation where the fix is a side-effect (logging) or internal function.

**Tech Stack:** TypeScript, Vitest, supertest (already installed), Drizzle ORM, Express 5.x

---

## File Map

| File | Issues Addressed |
|---|---|
| `server/src/services/file-import.ts` | C2 (empty description), C3 (post-split short chunks), I2 (per-job error log), I6 (transaction) |
| `server/src/services/extraction.ts` | C1 (silent LLM errors) |
| `server/src/services/index.ts` | S3 (export WORKER_INTERVAL_MS) |
| `server/src/routes/file-import.ts` | I1 (DRY MIME types) |
| `server/src/index.ts` | S3 (consume WORKER_INTERVAL_MS from service) |
| `server/src/__tests__/file-import-service.test.ts` | C3 test, I6 mock update |
| `server/src/__tests__/file-import-routes.test.ts` | I7 (4 meaningful route tests) |

---

## Background you must read before starting

Read these files in full before touching any code:

- `server/src/services/file-import.ts` — the main service (stages 1 + 2, worker, CRUD)
- `server/src/services/extraction.ts` — `extractFromRawText` is at the bottom (~line 654)
- `server/src/services/index.ts` — check current exports
- `server/src/routes/file-import.ts` — route handlers
- `server/src/index.ts` — worker wiring, `FILE_IMPORT_INTERVAL_MS` constant (~line 600)
- `server/src/__tests__/file-import-service.test.ts` — existing tests + `makeDb` helper
- `server/src/__tests__/file-import-routes.test.ts` — currently a single contract test

Run `pnpm test --filter @armyofagents/server` from repo root before starting so you see the green baseline.

---

## Task 1: Fix C3 — Post-split chunks can be shorter than 30 chars

**The bug:** In `chunkTextToParagraphs`, the sentence-splitter path pushes chunks into `finalChunks` without checking the 30-char minimum. If the last sentence of a long paragraph is very short (e.g., `"OK."`), it becomes a 3-char memory item.

**Files:**
- Modify: `server/src/services/file-import.ts` (lines ~124–165, `chunkTextToParagraphs`)
- Modify: `server/src/__tests__/file-import-service.test.ts` (add one test to the `chunkTextToParagraphs` suite)

- [ ] **Step 1: Write the failing test**

Add this test inside the existing `describe("chunkTextToParagraphs", ...)` block in `server/src/__tests__/file-import-service.test.ts`, after the existing `"title is first sentence truncated to 80 chars"` test:

```typescript
it("does not emit chunks shorter than 30 chars after sentence splitting", async () => {
  const { chunkTextToParagraphs } = await import("../services/file-import.js");
  // Construct a paragraph whose first "sentence" is 1502 chars so the splitter kicks in,
  // followed by the short sentence "OK." (3 chars).
  // Without the fix, "OK." becomes a standalone 3-char chunk.
  const longSentence = "A".repeat(1501) + ".";
  const text = longSentence + " OK.";
  const items = chunkTextToParagraphs(text, mockJob);
  expect(items.every((item) => String(item.content).length >= 30)).toBe(true);
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
pnpm test --filter @armyofagents/server file-import-service
```

Expected: FAIL — "OK." chunk has length 3, assertion fails.

- [ ] **Step 3: Implement the fix**

In `server/src/services/file-import.ts`, the final return in `chunkTextToParagraphs` currently reads:

```typescript
  // Step 5: Map to memory item inserts
  return finalChunks.map((chunk) => {
```

Change it to:

```typescript
  // Step 5: Filter residual sub-minimum chunks (sentence splitter can emit these),
  // then map to memory item inserts
  return finalChunks
    .filter((c) => c.length >= CHUNK_MIN_CHARS)
    .map((chunk) => {
```

No other changes in this function.

- [ ] **Step 4: Run the test to confirm it passes**

```bash
pnpm test --filter @armyofagents/server file-import-service
```

Expected: all tests in the file PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/file-import.ts server/src/__tests__/file-import-service.test.ts
git commit -m "fix(file-import): drop sub-30-char chunks produced by sentence splitter"
```

---

## Task 2: Fix C2 + C1 + I2 — Data quality and logging

Three small fixes across two files. No new tests needed (all are side-effects or in internal functions).

**C2** — LLM items with an empty `description` produce memory items with blank `content`.
**C1** — `extractFromRawText` silently swallows all errors; ops sees nothing when LLM fails.
**I2** — `processOneJob` has no per-job error log; DB gets `errorMessage` but the server log is silent.

**Files:**
- Modify: `server/src/services/file-import.ts`
- Modify: `server/src/services/extraction.ts`

- [ ] **Step 1: Fix C2 — filter empty-description items in `extractItemsFromText`**

In `server/src/services/file-import.ts`, find the `extractItemsFromText` function (~line 174). Inside the `if (extracted.length > 0)` block, the items mapping currently reads:

```typescript
    const items = extracted
      .filter((item: ExtractedItem) => item.type !== "task")
      .map((item: ExtractedItem): MemoryItemInsert => ({
```

Change it to:

```typescript
    const items = extracted
      .filter((item: ExtractedItem) => item.type !== "task")
      .filter((item: ExtractedItem) => item.description.trim().length > 0) // skip blank content
      .map((item: ExtractedItem): MemoryItemInsert => ({
```

- [ ] **Step 2: Fix I2 — add logger to `file-import.ts` and log per-job failures**

`file-import.ts` currently has no logger. Add the import at the top of the file, after the existing imports:

```typescript
import { logger } from "../middleware/logger.js";

const log = logger.child({ service: "file-import" });
```

Then, in `processOneJob`, the `catch (err)` block currently starts:

```typescript
  } catch (err) {
    const newRetryCount = job.retryCount + 1;
```

Change it to:

```typescript
  } catch (err) {
    log.warn({ err, jobId: job.id, companyId: job.companyId }, "file import job failed");
    const newRetryCount = job.retryCount + 1;
```

- [ ] **Step 3: Fix C1 — log LLM failures in `extractFromRawText`**

In `server/src/services/extraction.ts`, find the `extractFromRawText` method (~line 654). The catch block currently reads:

```typescript
      } catch {
        // LLM unavailable or quota exceeded — caller uses chunking fallback
        return [];
      }
```

Change it to:

```typescript
      } catch (err) {
        // LLM unavailable or quota exceeded — caller falls back to paragraph chunking
        logger.warn({ err, companyId }, "extractFromRawText: LLM call failed, falling back to chunking");
        return [];
      }
```

`logger` is already imported at the top of `extraction.ts` — no import change needed.

- [ ] **Step 4: Run tests**

```bash
pnpm test --filter @armyofagents/server
```

Expected: all tests PASS (these are side-effect changes with no behavioural difference to tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/file-import.ts server/src/services/extraction.ts
git commit -m "fix(file-import): filter blank-content items, add per-job and LLM failure logging"
```

---

## Task 3: Fix I1 + S3 — DRY MIME types and interval constant

**I1** — `SUPPORTED_MIME_TYPES` is defined twice: once as a readonly array in the service, and again as a local `Set` in the route. Adding a new MIME type in the service won't automatically update the route validation.

**S3** — `FILE_IMPORT_INTERVAL_MS = 15_000` is declared in `index.ts` instead of being imported from the service which already exports `WORKER_INTERVAL_MS = 15_000`. A drift in the service constant won't be picked up.

**Files:**
- Modify: `server/src/services/index.ts` (add export)
- Modify: `server/src/routes/file-import.ts` (import from service, drop local Set)
- Modify: `server/src/index.ts` (import from service, drop local constant)

- [ ] **Step 1: Export `WORKER_INTERVAL_MS` from `server/src/services/index.ts`**

Find the file-import line in `server/src/services/index.ts`:

```typescript
export { fileImportService, processFileImportQueue, resetStuckJobs } from "./file-import.js";
```

Change it to:

```typescript
export { fileImportService, processFileImportQueue, resetStuckJobs, WORKER_INTERVAL_MS } from "./file-import.js";
```

- [ ] **Step 2: Fix I1 — import MIME types from service in the route**

In `server/src/routes/file-import.ts`, at the top of the file there is currently a local Set:

```typescript
const SUPPORTED_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
]);
```

Remove that block entirely. Add `SUPPORTED_MIME_TYPES` to the existing service import:

```typescript
import { fileImportService, SUPPORTED_MIME_TYPES } from "../services/file-import.js";
```

Then add a module-level Set derived from the imported array (place it right after the import block, before `const MAX_FILE_SIZE_BYTES`):

```typescript
const SUPPORTED_MIME_TYPES_SET = new Set<string>(SUPPORTED_MIME_TYPES);
```

Update the MIME check in the POST handler (currently `!SUPPORTED_MIME_TYPES.has(file.mimetype)`) to:

```typescript
        if (!SUPPORTED_MIME_TYPES_SET.has(file.mimetype)) {
```

- [ ] **Step 3: Fix S3 — import `WORKER_INTERVAL_MS` in `server/src/index.ts`**

Find the existing import near the top of `server/src/index.ts`:

```typescript
import { heartbeatService, routineService, processFileImportQueue, resetStuckJobs } from "./services/index.js";
```

Change it to:

```typescript
import { heartbeatService, routineService, processFileImportQueue, resetStuckJobs, WORKER_INTERVAL_MS } from "./services/index.js";
```

Then find the local constant declaration (~line 600):

```typescript
const FILE_IMPORT_INTERVAL_MS = 15_000;
```

Delete that line. Find the `setInterval` call that references it:

```typescript
}, FILE_IMPORT_INTERVAL_MS);
```

Change it to:

```typescript
}, WORKER_INTERVAL_MS);
```

- [ ] **Step 4: Type-check and run tests**

```bash
pnpm typecheck --filter @armyofagents/server
pnpm test --filter @armyofagents/server
```

Expected: 0 type errors, all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/index.ts server/src/routes/file-import.ts server/src/index.ts
git commit -m "fix(file-import): DRY MIME types and interval constant — import from service"
```

---

## Task 4: Fix I6 — Wrap item insert + job status update in a transaction

**The bug:** In `processOneJob`, if `db.insert(memoryItems)` succeeds but the `db.update` to set `status: "done"` fails (e.g., transient DB error), the job stays stuck in `"processing"`. On next server restart, `resetStuckJobs` resets it to `"pending"` and the worker re-runs it — inserting duplicate memory items.

**Fix:** Wrap the insert + final update in `db.transaction()`.

**Note on tests:** The existing `makeDb` mock does not have a `transaction` method. Adding it requires updating `makeDb` in the test file. The new `transaction` implementation just delegates to the mock db itself (no real rollback) — this is sufficient to verify the happy path still works.

**Files:**
- Modify: `server/src/services/file-import.ts` (wrap insert + done-update in transaction)
- Modify: `server/src/__tests__/file-import-service.test.ts` (add `transaction` to `makeDb`)

- [ ] **Step 1: Update `makeDb` to support transactions**

In `server/src/__tests__/file-import-service.test.ts`, find the `makeDb` function (~line 147). It currently returns an object literal. Restructure it to a named variable with a `transaction` method:

Replace the entire `makeDb` function with:

```typescript
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
  const db: Record<string, unknown> = {
    select: (..._a: unknown[]) => makeChain(() => selects[si++] ?? []),
    update: (..._a: unknown[]) => makeChain(() => updates[ui++] ?? []),
    insert: (..._a: unknown[]) => makeChain(() => inserts[ii++] ?? []),
    transaction: async (fn: (tx: unknown) => Promise<void>) => fn(db),
  };
  return db;
}
```

The key addition is the `transaction` method: it calls the callback with the same `db` as the transaction context, so all the sequence-based insert/update mocks still work in order.

- [ ] **Step 2: Run the existing tests to confirm the mock change has no regressions**

```bash
pnpm test --filter @armyofagents/server file-import-service
```

Expected: all tests PASS (the transaction method is new but no existing test calls it yet).

- [ ] **Step 3: Wrap insert + done-update in a transaction in `processOneJob`**

In `server/src/services/file-import.ts`, find the success path in `processOneJob`. It currently reads:

```typescript
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
```

Replace it with:

```typescript
    // Atomically insert memory items and mark done — prevents duplicate items
    // if the server crashes between the two writes.
    await db.transaction(async (tx) => {
      if (items.length > 0) {
        await tx.insert(memoryItems).values(items);
      }
      await tx
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
    });
```

Note: `tx` is the transaction handle. The Drizzle transaction API provides it with the same `insert`/`update`/`select` methods as `db`.

- [ ] **Step 4: Run all tests**

```bash
pnpm test --filter @armyofagents/server
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/file-import.ts server/src/__tests__/file-import-service.test.ts
git commit -m "fix(file-import): wrap item insert + job status update in transaction"
```

---

## Task 5: Fix I7 — Add meaningful route tests

The current `file-import-routes.test.ts` has a single contract test (factory function check). The spec requires tests for: MIME rejection, happy-path 202, GET job shape, and 404 on missing job.

This task replaces the existing test file with a proper suite using `supertest` (already a dev dependency).

**Key mocking:** The route imports `assertCompanyAccess` and `getActorInfo` from `./authz.js`, `assertRole` from `../middleware/rbac.js`, and `fileImportService` + `SUPPORTED_MIME_TYPES` from `../services/file-import.js`. All four are mocked.

**Files:**
- Modify: `server/src/__tests__/file-import-routes.test.ts`

- [ ] **Step 1: Verify supertest is installed**

```bash
ls server/node_modules/supertest
```

Expected: directory exists (already a dev dep per package.json).

- [ ] **Step 2: Replace the test file contents**

Overwrite `server/src/__tests__/file-import-routes.test.ts` with:

```typescript
import { describe, it, expect, vi } from "vitest";
import express from "express";
import supertest from "supertest";

// ── Mocks (hoisted by vitest before any imports) ───────────────────────────

vi.mock("../routes/authz.js", () => ({
  assertCompanyAccess: vi.fn(),
  getActorInfo: vi.fn(() => ({ actorId: "user-1", actorType: "user" })),
}));

vi.mock("../middleware/rbac.js", () => ({
  assertRole: vi.fn().mockResolvedValue(undefined),
}));

const mockCreateJob = vi.fn().mockResolvedValue({ id: "job-1", fileName: "doc.pdf" });
const mockGetJob = vi.fn().mockResolvedValue({
  id: "job-1",
  status: "done",
  fileName: "doc.pdf",
  itemCount: 5,
  errorMessage: null,
  parserWarnings: null,
  createdAt: new Date("2025-01-01T00:00:00Z"),
  completedAt: new Date("2025-01-01T00:01:00Z"),
});

vi.mock("../services/file-import.js", () => ({
  SUPPORTED_MIME_TYPES: [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/plain",
  ],
  fileImportService: vi.fn(() => ({
    createJob: mockCreateJob,
    getJob: mockGetJob,
  })),
}));

// ── Test helpers ───────────────────────────────────────────────────────────

const mockStorageService = {
  putFile: vi.fn().mockResolvedValue({ objectKey: "imports/123-doc.pdf" }),
};

async function makeApp() {
  const { fileImportRoutes } = await import("../routes/file-import.js");
  const app = express();
  app.use(fileImportRoutes({} as any, mockStorageService as any));
  return app;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("fileImportRoutes contract", () => {
  it("exports a fileImportRoutes factory function", async () => {
    const mod = await import("../routes/file-import.js");
    expect(typeof mod.fileImportRoutes).toBe("function");
  });
});

describe("POST /companies/:companyId/memory/import-file", () => {
  it("rejects unsupported MIME type with 400", async () => {
    const app = await makeApp();
    const res = await supertest(app)
      .post("/companies/co-1/memory/import-file")
      .attach("file", Buffer.from("fake image data"), {
        filename: "photo.gif",
        contentType: "image/gif",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unsupported file type/);
  });

  it("returns 202 with jobId and fileName on valid PDF upload", async () => {
    const app = await makeApp();
    const res = await supertest(app)
      .post("/companies/co-1/memory/import-file")
      .attach("file", Buffer.from("PDF content here."), {
        filename: "doc.pdf",
        contentType: "application/pdf",
      });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ jobId: "job-1", fileName: "doc.pdf" });
  });

  it("returns 400 when no file is attached", async () => {
    const app = await makeApp();
    // .field() sends a valid multipart request with no file attachment;
    // multer processes it fine and req.file is undefined → route returns 400.
    const res = await supertest(app)
      .post("/companies/co-1/memory/import-file")
      .field("unused", "value");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No file/);
  });
});

describe("GET /companies/:companyId/memory/import-jobs/:jobId", () => {
  it("returns the correct job status shape", async () => {
    const app = await makeApp();
    const res = await supertest(app).get(
      "/companies/co-1/memory/import-jobs/job-1",
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "job-1",
      status: "done",
      fileName: "doc.pdf",
      itemCount: 5,
      errorMessage: null,
      parserWarnings: null,
    });
    expect(res.body.createdAt).toBeDefined();
    expect(res.body.completedAt).toBeDefined();
  });

  it("returns 404 when the job does not exist", async () => {
    mockGetJob.mockResolvedValueOnce(null);
    const app = await makeApp();
    const res = await supertest(app).get(
      "/companies/co-1/memory/import-jobs/nonexistent",
    );
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 3: Run the new tests to confirm they pass**

```bash
pnpm test --filter @armyofagents/server file-import-routes
```

Expected: 6 tests PASS (1 contract + 3 POST + 2 GET).

- [ ] **Step 4: Run the full test suite**

```bash
pnpm test --filter @armyofagents/server
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/__tests__/file-import-routes.test.ts
git commit -m "test(file-import): add route tests — MIME rejection, 202, GET shape, 404"
```

---

## Self-Review Checklist

- [ ] C1: `extraction.ts` catch block logs with `logger.warn`
- [ ] C2: Empty `description` items filtered before mapping to `content`
- [ ] C3: `finalChunks.filter(c => c.length >= CHUNK_MIN_CHARS)` in place + test covers it
- [ ] I1: Route imports `SUPPORTED_MIME_TYPES` from service, no local Set
- [ ] I2: `file-import.ts` has `logger` import + `log.warn` in `processOneJob` catch
- [ ] I6: `db.transaction()` wraps insert + done-update in `processOneJob` + `makeDb` has `transaction`
- [ ] I7: Route tests cover MIME rejection, 202 response, GET shape, 404
- [ ] S3: `WORKER_INTERVAL_MS` imported from service in `index.ts`; local `FILE_IMPORT_INTERVAL_MS` deleted
- [ ] All tests pass: `pnpm test --filter @armyofagents/server`
- [ ] No type errors: `pnpm typecheck --filter @armyofagents/server`
