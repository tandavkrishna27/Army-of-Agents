import { pgTable, uuid, text, timestamp, integer, index } from "drizzle-orm/pg-core";

/**
 * Write-behind embedding queue (Task B1, Decision D2).
 *
 * Writers enqueue (text, target_table, target_id, target_column) rows
 * synchronously; a background worker pulls pending rows and generates
 * embeddings via OpenAI, then UPDATEs the target row's vector column.
 *
 * This decouples app insert latency from OpenAI API health: a
 * memory_item write returns in <10ms regardless of OpenAI being slow
 * or down. Find-similar queries may return stale results for a few
 * seconds while the backlog drains — acceptable per locked design
 * decision D2.
 *
 * `target_table` values currently supported: 'memory_items',
 * 'discussions', 'discussion_extracted_items'. `target_column` is the
 * snake_case vector column name on that table (e.g. 'embedding' or
 * 'summary_embedding'). FKs are intentionally omitted — the worker
 * resolves the table mapping at app level, and a failed UPDATE simply
 * fails the queue row rather than cascading.
 */
export const embeddingQueue = pgTable(
  "embedding_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // 'memory_items' | 'discussions' | 'discussion_extracted_items'
    targetTable: text("target_table").notNull(),
    targetId: uuid("target_id").notNull(),
    // e.g. 'embedding' | 'summary_embedding'
    targetColumn: text("target_column").notNull(),
    inputText: text("input_text").notNull(),
    // 'pending' | 'processing' | 'completed' | 'failed'
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    // Nullable — populated on new enqueues; backfilled for existing rows.
    // Lets the worker resolve a per-company OpenAI key (Task 10).
    companyId: uuid("company_id"),
    // Nullable — null means eligible immediately. Set by the worker for
    // exponential back-off retry scheduling (Task 11).
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    statusIdx: index("embedding_queue_status_idx").on(table.status, table.createdAt),
    targetIdx: index("embedding_queue_target_idx").on(table.targetTable, table.targetId),
    // Compound index for the worker's pick-next-eligible query:
    // WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= now())
    pendingDueIdx: index("embedding_queue_pending_due_idx").on(table.status, table.nextRetryAt),
  }),
);
