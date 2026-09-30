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

import { and, eq, isNull, lte, or } from "drizzle-orm";
import type { Readable } from "node:stream";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import type { Db } from "@armyofagents/db";
import { fileImportJobs, memoryItems } from "@armyofagents/db";
import type { StorageService } from "../storage/types.js";
import { extractionService, type ExtractedItem } from "./extraction.js";
import { logger } from "../middleware/logger.js";
import { buildMemoryInsert } from "./memory-projection.js";
import { getDbCapabilities } from "./db-capabilities.js";
import {
  SUPPORTED_MIME_TYPES,
  PLAIN_TEXT_MIME_TYPES,
  type SupportedMimeType,
} from "./file-import-mime-types.js";

const log = logger.child({ service: "file-import" });

// ── Constants ─────────────────────────────────────────────────────────────

export { SUPPORTED_MIME_TYPES, type SupportedMimeType };

export const WORKER_BATCH_SIZE = 3;
export const WORKER_INTERVAL_MS = 15_000;
export const MAX_RETRIES = 3;
export const RETRY_BACKOFF_MS = [15_000, 60_000, 240_000] as const;

// Chunking constants
const CHUNK_MIN_CHARS = 30;
const CHUNK_MERGE_THRESHOLD = 100;
const CHUNK_SPLIT_THRESHOLD = 1500;
const CHUNK_MAX_CHARS = 2000;
const TITLE_MAX_CHARS = 80;

// ── Helpers ───────────────────────────────────────────────────────────────

export async function streamToBuffer(stream: Readable): Promise<Buffer> {
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
  if (PLAIN_TEXT_MIME_TYPES.has(mimeType)) {
    return { text: buffer.toString("utf-8"), warnings: [] };
  }

  switch (mimeType) {
    case "application/pdf": {
      const parser = new PDFParse({ data: buffer });
      const result = await parser.getText();
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

  // Step 3: Merge consecutive short chunks (< 100 chars each)
  const merged: string[] = [];
  let buffer = "";
  for (const chunk of filtered) {
    if (buffer && chunk.length < CHUNK_MERGE_THRESHOLD) {
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

  // Step 5: Filter residual sub-minimum chunks (sentence splitter can emit these),
  // then map to memory item inserts
  return finalChunks
    .filter((c) => c.length >= CHUNK_MIN_CHARS)
    .map((chunk) => {
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
    } as MemoryItemInsert;
  });
}

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
  const extracted = await extractionService(db)
    .extractFromRawText(job.companyId, text)
    .catch(() => []);

  if (extracted.length > 0) {
    // Filter out "task" type — file imports create memory items, not issues
    const items = extracted
      .filter((item: ExtractedItem) => item.type !== "task")
      .filter((item: ExtractedItem) => item.description.trim().length > 0) // skip blank content
      .map((item: ExtractedItem): MemoryItemInsert => ({
        companyId: job.companyId,
        title: item.title,
        content: item.description,   // ExtractedItem uses 'description'; memory uses 'content'
        category: item.type,         // decision/insight/context/reference/preference
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

export function fileImportService(db: Db) {
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

    // Atomically insert memory items and mark done.
    // Prevents duplicate items if the server crashes between the two writes
    // (resetStuckJobs would reset to 'pending' and re-run the job).
    //
    // We use buildMemoryInsert (memory-projection.ts) instead of Drizzle's
    // .insert(memoryItems).values() because Drizzle 0.38 enumerates every
    // schema column in the INSERT (filling unspecified ones with DEFAULT) so
    // ON CONFLICT / RETURNING slots match. When pgvector is unavailable the
    // physical schema lacks the `embedding` column, and Drizzle's emitted SQL
    // 500s with "column embedding does not exist" even though we set no value.
    // buildMemoryInsert tracks the runtime capability and emits only the
    // columns that actually exist.
    const hasVector = getDbCapabilities().hasVectorSupport;
    await db.transaction(async (tx) => {
      for (const item of items) {
        await buildMemoryInsert(tx as unknown as Db, item as Record<string, unknown>, hasVector);
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
  } catch (err) {
    log.warn({ err, jobId: job.id, companyId: job.companyId }, "file import job failed");
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
