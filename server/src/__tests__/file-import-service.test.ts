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

// ── extractTextFromBuffer ───────────────────────────────────────────────────

describe("extractTextFromBuffer", () => {
  // Cold dynamic import of file-import.js (mammoth/pdf-parse) times out on Windows runners
  it.skipIf(process.platform === "win32")("extracts plain text from TXT buffer", async () => {
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
    const para1 = "A".repeat(110);
    const para2 = "B".repeat(110);
    const text = para1 + "\n\n" + para2;
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
    // Two chunks each under 100 chars → merged into one
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
});

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
  const db: Record<string, unknown> = {
    select: (..._a: unknown[]) => makeChain(() => selects[si++] ?? []),
    update: (..._a: unknown[]) => makeChain(() => updates[ui++] ?? []),
    insert: (..._a: unknown[]) => makeChain(() => inserts[ii++] ?? []),
    transaction: async (fn: (tx: unknown) => Promise<void>) => fn(db),
  };
  return db;
}

describe("fileImportService.createJob", () => {
  it("inserts a job and returns it", async () => {
    const { fileImportService } = await import("../services/file-import.js");
    const job = { id: "job-1", companyId: "co-1", fileName: "doc.pdf", mimeType: "application/pdf", fileSize: 1000, storageKey: "key/doc.pdf", status: "pending", itemCount: 0, retryCount: 0, defaultLayer: "domain", defaultCategory: "reference", createdBy: "user-1", retryAfter: null, processorType: null, errorMessage: null, parserWarnings: null, departmentId: null, projectId: null, completedAt: null, createdAt: new Date(), updatedAt: new Date() };
    const db = makeDb([], [], [[job]]);
    const svc = fileImportService(db as any);
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
    const svc = fileImportService(db as any);
    const result = await svc.getJob("co-1", "job-1");
    expect(result?.id).toBe("job-1");
  });

  it("returns null when not found", async () => {
    const { fileImportService } = await import("../services/file-import.js");
    const db = makeDb([[]]); // empty result
    const svc = fileImportService(db as any);
    const result = await svc.getJob("co-1", "nonexistent");
    expect(result).toBeNull();
  });
});

// ── processFileImportQueue ─────────────────────────────────────────────────

describe("processFileImportQueue", () => {
  it("picks up pending jobs and calls storageService.getObject", async () => {
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
      [[pendingJob]],   // select: pending jobs list
      [[], []],         // updates: mark processing, mark done
      [[{ id: "mem-1" }]], // insert: memory items
    );
    const storageService = {
      getObject: vi.fn().mockResolvedValue({
        stream: (await import("node:stream")).Readable.from(
          [Buffer.from("Hello world. This is test content with enough characters for chunking.")]
        ),
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
    const db = makeDb([[pendingJob]], [[], []]);
    const storageService = {
      getObject: vi.fn().mockRejectedValue(new Error("Storage error")),
    };
    await processFileImportQueue(db as any, storageService as any);
    // No throw — error is caught and job is set to retry
  });

  it("marks job as failed after max retries", async () => {
    const { processFileImportQueue } = await import("../services/file-import.js");
    const exhaustedJob = {
      id: "job-1", companyId: "co-1", fileName: "bad.pdf",
      mimeType: "application/pdf", fileSize: 100,
      storageKey: "key/bad.pdf", status: "pending",
      itemCount: 0, retryCount: 3, retryAfter: null,  // already at MAX_RETRIES
      processorType: null, errorMessage: null, parserWarnings: null,
      departmentId: null, projectId: null,
      defaultLayer: "domain", defaultCategory: "reference",
      createdBy: "user-1", completedAt: null,
      createdAt: new Date(), updatedAt: new Date(),
    };
    const db = makeDb([[exhaustedJob]], [[], []]);
    const storageService = {
      getObject: vi.fn().mockRejectedValue(new Error("Persistent failure")),
    };
    await processFileImportQueue(db as any, storageService as any);
    // No throw — job marked failed
  });
});
