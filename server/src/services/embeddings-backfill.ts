import { eq, isNull, isNotNull, and, inArray, notInArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  embeddingQueue,
  memoryItems,
  discussions,
  discussionEntries,
  discussionExtractedItems,
} from "@armyofagents/db";
import { getDbCapabilities } from "./db-capabilities.js";
import { enqueueMemoryEmbedding } from "./memory-write.js";
import { logger } from "../middleware/logger.js";

type Db = NodePgDatabase<Record<string, never>>;

/**
 * Backfill `embedding_queue.company_id` for rows that pre-date the keyless
 * initiative (Task 4, keyless-except-embeddings).
 *
 * For each supported targetTable value, derives the owning company by joining
 * through to the source entity. Rows that cannot resolve (orphaned, unknown
 * targetTable) are left NULL — the worker will fall back to the env-level key.
 *
 * Idempotent: only touches rows where company_id IS NULL. Safe to run on every
 * boot — second run updates 0 rows.
 */
export async function backfillQueueCompanyIds(db: Db): Promise<{ updated: number }> {
  let totalUpdated = 0;

  // -------------------------------------------------------------------------
  // 1. memory_items: embedding_queue.target_id → memory_items.id → company_id
  // -------------------------------------------------------------------------
  const miRows = await db
    .select({
      queueId: embeddingQueue.id,
      companyId: memoryItems.companyId,
    })
    .from(embeddingQueue)
    .innerJoin(memoryItems, eq(memoryItems.id, embeddingQueue.targetId))
    .where(
      and(
        isNull(embeddingQueue.companyId),
        eq(embeddingQueue.targetTable, "memory_items"),
      ),
    );

  for (const row of miRows) {
    await db
      .update(embeddingQueue)
      .set({ companyId: row.companyId })
      .where(eq(embeddingQueue.id, row.queueId));
  }
  totalUpdated += miRows.length;

  // -------------------------------------------------------------------------
  // 2. discussions: embedding_queue.target_id → discussions.id → company_id
  // -------------------------------------------------------------------------
  const discRows = await db
    .select({
      queueId: embeddingQueue.id,
      companyId: discussions.companyId,
    })
    .from(embeddingQueue)
    .innerJoin(discussions, eq(discussions.id, embeddingQueue.targetId))
    .where(
      and(
        isNull(embeddingQueue.companyId),
        eq(embeddingQueue.targetTable, "discussions"),
      ),
    );

  for (const row of discRows) {
    await db
      .update(embeddingQueue)
      .set({ companyId: row.companyId })
      .where(eq(embeddingQueue.id, row.queueId));
  }
  totalUpdated += discRows.length;

  // -------------------------------------------------------------------------
  // 3. discussion_extracted_items:
  //    embedding_queue.target_id → discussion_extracted_items.id
  //      → discussion_entries.id (via discussionEntryId)
  //        → discussions.id (via discussionId)
  //          → discussions.company_id
  // -------------------------------------------------------------------------
  const deiRows = await db
    .select({
      queueId: embeddingQueue.id,
      companyId: discussions.companyId,
    })
    .from(embeddingQueue)
    .innerJoin(
      discussionExtractedItems,
      eq(discussionExtractedItems.id, embeddingQueue.targetId),
    )
    .innerJoin(
      discussionEntries,
      eq(discussionEntries.id, discussionExtractedItems.discussionEntryId),
    )
    .innerJoin(discussions, eq(discussions.id, discussionEntries.discussionId))
    .where(
      and(
        isNull(embeddingQueue.companyId),
        eq(embeddingQueue.targetTable, "discussion_extracted_items"),
      ),
    );

  for (const row of deiRows) {
    await db
      .update(embeddingQueue)
      .set({ companyId: row.companyId })
      .where(eq(embeddingQueue.id, row.queueId));
  }
  totalUpdated += deiRows.length;

  return { updated: totalUpdated };
}

const log = logger.child({ service: "embeddings-backfill" });

/** Status values that represent a "live" (in-flight) queue row. */
const LIVE_STATUSES = ["pending", "processing"] as const;

/**
 * Re-index a single company's embedding queue:
 *   1. Reset all `failed` rows for the company back to `pending` (clear
 *      next_retry_at, attempts, error) so the worker will retry them.
 *   2. Enqueue memory_items that have no embedding and no live queue row.
 *
 * Returns counts of what was done. No-op (returns zeros) when pgvector is
 * not available. Idempotent: safe to call multiple times.
 */
export async function reindexCompany(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  companyId: string,
): Promise<{ requeuedFailed: number; enqueuedMissing: number }> {
  if (!getDbCapabilities().hasVectorSupport) {
    return { requeuedFailed: 0, enqueuedMissing: 0 };
  }

  // --- 1. Requeue NON-STALE failed rows --------------------------------------
  // Only requeue a failed row when its target has NO other completed/live
  // (pending|processing) queue row (P2, Codex). A sibling completed/live row
  // means the target was already (re)indexed by a NEWER row — e.g. the item was
  // edited after this failure and re-embedded — so this failed row carries STALE
  // inputText, and requeuing it would overwrite the current vector with obsolete
  // content. The /memory/reindex-failed route applies the same predicate.
  const failedRows = await db
    .select({
      id: embeddingQueue.id,
      targetTable: embeddingQueue.targetTable,
      targetId: embeddingQueue.targetId,
      targetColumn: embeddingQueue.targetColumn,
      createdAt: embeddingQueue.createdAt,
    })
    .from(embeddingQueue)
    .where(
      and(
        eq(embeddingQueue.companyId, companyId),
        eq(embeddingQueue.status, "failed"),
      ),
    );

  const supersedingRows = await db
    .select({
      targetTable: embeddingQueue.targetTable,
      targetId: embeddingQueue.targetId,
      targetColumn: embeddingQueue.targetColumn,
      createdAt: embeddingQueue.createdAt,
    })
    .from(embeddingQueue)
    .where(
      and(
        eq(embeddingQueue.companyId, companyId),
        inArray(embeddingQueue.status, ["completed", "pending", "processing"]),
      ),
    );

  const targetKey = (r: {
    targetTable: string;
    targetId: string;
    targetColumn: string;
  }) => JSON.stringify([r.targetTable, r.targetId, r.targetColumn]);
  // Recency-aware suppression (P2, Codex): suppress a failed row ONLY if a
  // completed/live sibling is NEWER than it. If the failed row is the newest
  // attempt (e.g. an OLD completed row for pre-edit content + a LATER edit's row
  // that failed), it must still be requeued — otherwise the stored vector stays
  // stale while the item reports indexed.
  const ms = (v: unknown) => (v ? new Date(v as string | Date).getTime() : 0);
  const newestSiblingByTarget = new Map<string, number>();
  for (const s of supersedingRows as Array<{
    targetTable: string;
    targetId: string;
    targetColumn: string;
    createdAt: unknown;
  }>) {
    const k = targetKey(s);
    const t = ms(s.createdAt);
    const prev = newestSiblingByTarget.get(k);
    if (prev === undefined || t > prev) newestSiblingByTarget.set(k, t);
  }
  const requeueableIds = (
    failedRows as Array<{
      id: string;
      targetTable: string;
      targetId: string;
      targetColumn: string;
      createdAt: unknown;
    }>
  )
    .filter((r) => {
      const newestSibling = newestSiblingByTarget.get(targetKey(r));
      return newestSibling === undefined || ms(r.createdAt) >= newestSibling;
    })
    .map((r) => r.id);

  const requeuedFailed = requeueableIds.length;

  if (requeuedFailed > 0) {
    await db
      .update(embeddingQueue)
      .set({
        status: "pending",
        nextRetryAt: null,
        attempts: 0,
        error: null,
      })
      .where(inArray(embeddingQueue.id, requeueableIds));
  }

  // --- 1b. Clear deferred backoff on live pending rows ----------------------
  // No-key and open-circuit rows are left 'pending' with a FUTURE nextRetryAt
  // (anti-starvation backoff). They are "live", so step 2 below excludes them
  // and step 1 only touches 'failed' rows — without this they'd stay ineligible
  // until the backoff expires even though a key was just added/rotated. Clear
  // nextRetryAt so adding the key drains the backlog immediately (P3, Codex).
  await db
    .update(embeddingQueue)
    .set({ nextRetryAt: null })
    .where(
      and(
        eq(embeddingQueue.companyId, companyId),
        eq(embeddingQueue.status, "pending"),
        isNotNull(embeddingQueue.nextRetryAt),
      ),
    );

  // --- 2. Enqueue missing memory_items --------------------------------------
  // Find memory_items for this company where embedding IS NULL and there is
  // no live (pending|processing) queue row already.
  const liveQueueRows = await db
    .select({ targetId: embeddingQueue.targetId })
    .from(embeddingQueue)
    .where(
      and(
        eq(embeddingQueue.companyId, companyId),
        eq(embeddingQueue.targetTable, "memory_items"),
        eq(embeddingQueue.targetColumn, "embedding"),
        inArray(embeddingQueue.status, [...LIVE_STATUSES]),
      ),
    );

  const liveTargetIds = liveQueueRows.map((r: { targetId: string }) => r.targetId);

  // Build the WHERE clause for null-embedding items excluding live targets.
  const missingEmbeddingFilter =
    liveTargetIds.length > 0
      ? and(
          eq(memoryItems.companyId, companyId),
          isNull((memoryItems as any).embedding),
          notInArray(memoryItems.id, liveTargetIds),
        )
      : and(
          eq(memoryItems.companyId, companyId),
          isNull((memoryItems as any).embedding),
        );

  const missingItems = await db
    .select({ id: memoryItems.id, title: memoryItems.title, content: memoryItems.content })
    .from(memoryItems)
    .where(missingEmbeddingFilter);

  let enqueuedMissing = 0;
  for (const item of missingItems) {
    await enqueueMemoryEmbedding(db, companyId, item);
    enqueuedMissing++;
  }

  return { requeuedFailed, enqueuedMissing };
}

/**
 * Re-index EVERY memory_item for a company (founder-only bulk op, Task 6).
 *
 * Unlike {@link reindexCompany} (which drains only missing/failed rows and
 * auto-fires on key add/rotate), this re-embeds the company's ENTIRE memory —
 * the explicit "Re-index all" button in Settings → Memory. Use after a model
 * change or a vector reset, when even already-indexed items should be redone.
 *
 * Dedup-safe (Rev 3): a blind bulk insert would create a SECOND `pending` row
 * for every item that already has a live one (the per-item
 * {@link enqueueMemoryEmbedding} refreshes in place — memory-write.ts). So we
 * first collect the set of memory targetIds that already have a live
 * (`pending`|`processing`) embedding_queue row and EXCLUDE them — the same
 * predicate {@link reindexCompany} uses for its superseding-row check. The
 * remaining items are inserted in one (chunked) bulk INSERT, never a per-item
 * loop (avoids N+1). The worker (circuit-breaker + backoff) paces the actual
 * provider calls.
 *
 * No-op (returns `{ enqueued: 0 }`) when pgvector is not available.
 */
export async function reindexAllCompany(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  companyId: string,
): Promise<{ enqueued: number }> {
  if (!getDbCapabilities().hasVectorSupport) {
    return { enqueued: 0 };
  }

  // All memory_items for the company.
  const items = await db
    .select({
      id: memoryItems.id,
      title: memoryItems.title,
      content: memoryItems.content,
    })
    .from(memoryItems)
    .where(eq(memoryItems.companyId, companyId));

  if (items.length === 0) {
    return { enqueued: 0 };
  }

  // Items that already have a live (pending|processing) queue row — same
  // predicate reindexCompany uses — must be excluded so we don't pile up a
  // duplicate pending row alongside the in-flight one.
  const liveQueueRows = await db
    .select({ targetId: embeddingQueue.targetId })
    .from(embeddingQueue)
    .where(
      and(
        eq(embeddingQueue.companyId, companyId),
        eq(embeddingQueue.targetTable, "memory_items"),
        eq(embeddingQueue.targetColumn, "embedding"),
        inArray(embeddingQueue.status, [...LIVE_STATUSES]),
      ),
    );

  const liveTargetIds = new Set(
    liveQueueRows.map((r: { targetId: string }) => r.targetId),
  );

  // Compose inputText exactly as enqueueMemoryEmbedding does (title\ncontent),
  // skip items with nothing to embed, and drop those with a live row.
  const rows = (
    items as Array<{ id: string; title?: string | null; content?: string | null }>
  )
    .filter((item) => !liveTargetIds.has(item.id))
    .map((item) => ({
      id: item.id,
      inputText: [item.title, item.content].filter(Boolean).join("\n"),
    }))
    .filter((r) => r.inputText.length > 0)
    .map((r) => ({
      companyId,
      targetTable: "memory_items" as const,
      targetId: r.id,
      targetColumn: "embedding" as const,
      inputText: r.inputText,
      status: "pending" as const,
    }));

  if (rows.length === 0) {
    return { enqueued: 0 };
  }

  // Bulk insert, chunked to keep a single statement's parameter count bounded.
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.insert(embeddingQueue).values(rows.slice(i, i + CHUNK));
  }

  log.info(
    { companyId, enqueued: rows.length },
    "reindexAllCompany: enqueued full-company re-embed",
  );

  return { enqueued: rows.length };
}

/**
 * Global reconciliation sweep: find null-vector memory_items across ALL
 * companies that lack a live queue row and enqueue them.
 *
 * Belt-and-suspenders for rows that were never enqueued (e.g. created before
 * the write-path hook was wired, or inserted via a migration). Idempotent:
 * the dedup guard in `enqueueMemoryEmbedding` ensures no double-inserts.
 *
 * No-op when pgvector is not available.
 */
export async function reconcileNullVectors(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
): Promise<{ enqueued: number }> {
  if (!getDbCapabilities().hasVectorSupport) {
    return { enqueued: 0 };
  }

  // Exclude items that already have a pending/processing OR failed queue row
  // (P2, Codex). Including 'failed' keeps dead-lettered items dead: an item whose
  // embedding exhausted retries / hit a row-permanent error must NOT be silently
  // resurrected with a fresh pending row every sweep (that resets the retry
  // budget and re-hammers the provider). Such items stay failed until a manual
  // re-index (/memory/:id/reindex or /memory/reindex-failed) explicitly retries.
  const excludedRows = await db
    .select({ targetId: embeddingQueue.targetId })
    .from(embeddingQueue)
    .where(
      and(
        eq(embeddingQueue.targetTable, "memory_items"),
        eq(embeddingQueue.targetColumn, "embedding"),
        inArray(embeddingQueue.status, [...LIVE_STATUSES, "failed"]),
      ),
    );

  const excludedTargetIds = excludedRows.map((r: { targetId: string }) => r.targetId);

  const missingFilter =
    excludedTargetIds.length > 0
      ? and(
          isNull((memoryItems as any).embedding),
          notInArray(memoryItems.id, excludedTargetIds),
        )
      : isNull((memoryItems as any).embedding);

  // Fetch items with their companyId so we can enqueue per-company.
  const missingItems = await db
    .select({
      id: memoryItems.id,
      companyId: memoryItems.companyId,
      title: memoryItems.title,
      content: memoryItems.content,
    })
    .from(memoryItems)
    .where(missingFilter);

  let enqueued = 0;
  for (const item of missingItems) {
    if (!item.companyId) continue; // orphaned row — skip
    await enqueueMemoryEmbedding(db, item.companyId, item);
    enqueued++;
  }

  if (enqueued > 0) {
    log.info({ enqueued }, "reconcileNullVectors: enqueued missing embeddings");
  }

  return { enqueued };
}
