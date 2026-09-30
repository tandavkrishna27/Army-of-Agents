import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { assets } from "./assets.js";
import { memoryItems } from "./memory_items.js";
import { artifacts } from "./artifacts.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { memoryExtractionBatches } from "./memory_extraction_batches.js";

/**
 * Extraction job tracking: bridges raw artifacts to memory_items.content.
 *
 * Flow:
 *   1. Founder uploads file → asset + artifact + memory_item (status=pending) created
 *   2. memory_extractions row inserted (status=queued)
 *   3. Worker picks up:
 *      - Free types (pdf, docx, url, audio): runs library / Whisper-CLI directly
 *      - Paid types (image, video): invokes memory-curator sub-agent (Phase 8)
 *   4. progressJson updated as stages complete (especially for compound jobs)
 *   5. extractedText written to memory_items.content; embedding queued
 *   6. resultMemoryItemId populated; status → succeeded
 *
 * Failure: errorMessage populated, status → failed. Founder can Retry,
 * Adjust&Retry, or Skip indexing (mark item unsearchable, keep as artifact).
 *
 * progressJson shape (compound jobs like video):
 *   {
 *     stage: "transcribing",
 *     stagePercent: 35,
 *     stagesCompleted: ["upload", "extract_audio"],
 *     stagesRemaining: ["transcribe", "extract_keyframes", "caption_keyframes", "embed"],
 *     estimatedSecondsRemaining?: 240
 *   }
 *
 * curatorRunId: when extraction was performed by a memory-curator sub-agent run,
 * this links to the heartbeat run for cost attribution + debugging.
 */
export const memoryExtractions = pgTable(
  "memory_extractions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    batchId: uuid("batch_id").references(() => memoryExtractionBatches.id, { onDelete: "set null" }),
    status: text("status").notNull().default("queued"),
    inputType: text("input_type").notNull(),
    inputAssetId: uuid("input_asset_id").references(() => assets.id, { onDelete: "set null" }),
    inputUrl: text("input_url"),
    /** Which extractor produced the output. e.g. "pdf-parse", "mammoth", "readability",
     *  "whisper-cli", "memory-curator-v1". */
    extractor: text("extractor"),
    extractedText: text("extracted_text"),
    extractedMetadata: jsonb("extracted_metadata").$type<Record<string, unknown>>(),
    progressJson: jsonb("progress_json").$type<{
      stage?: string;
      stagePercent?: number;
      stagesCompleted?: string[];
      stagesRemaining?: string[];
      estimatedSecondsRemaining?: number;
    }>(),
    /** Heartbeat run that performed the extraction (for curator-based extractors). */
    curatorRunId: uuid("curator_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    errorMessage: text("error_message"),
    retryCount: integer("retry_count").notNull().default(0),
    resultMemoryItemId: uuid("result_memory_item_id").references(() => memoryItems.id, { onDelete: "set null" }),
    resultArtifactId: uuid("result_artifact_id").references(() => artifacts.id, { onDelete: "set null" }),
    createdBy: text("created_by").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("memory_extractions_company_status_idx").on(table.companyId, table.status),
    batchIdx: index("memory_extractions_batch_idx").on(table.batchId),
    resultMemoryItemIdx: index("memory_extractions_result_memory_item_idx").on(table.resultMemoryItemId),
    companyCreatedIdx: index("memory_extractions_company_created_idx").on(table.companyId, table.createdAt),
  }),
);
