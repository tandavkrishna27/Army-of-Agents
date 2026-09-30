/**
 * memory-write.ts — Shared write+index path for memory items (Task W3).
 *
 * Every memory write (create, content/title update, approve) routes through
 * `enqueueMemoryEmbedding` to ensure coverage of the embedding queue. The
 * shared helper:
 *   - guards on pgvector availability (no-op when vector support is absent),
 *   - deduplicates against live ('pending'|'processing') queue rows so
 *     multiple write events on the same item don't pile up queue entries,
 *   - is best-effort: enqueue failure is caught and logged, never thrown to
 *     the caller (the memory write must succeed regardless of queue health).
 *
 * `writeMemoryAndIndex` is the public entry point for Task 9 crew/MCP tools —
 * it calls `memoryService(db).create(...)` then enqueues, returning the row.
 */

import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { embeddingQueue, memoryItems } from "@armyofagents/db";
import { getDbCapabilities } from "./db-capabilities.js";
import { memoryService } from "./memory.js";
import { orgHierarchyService } from "./org-hierarchy.js";
import { buildMemoryReviewHubEmit, emitHubItem } from "./hub-source-producers.js";
import { logger } from "../middleware/logger.js";

const log = logger.child({ service: "memory-write" });

/** Minimal shape of a memory item needed to build the embedding input text. */
interface MemoryItemLike {
  id: string;
  title?: string | null;
  content?: string | null;
}

/**
 * Enqueue an embedding job for a memory item.
 *
 * Best-effort: never throws into the caller. Returns silently on any guard
 * hit (no vector support, empty text, duplicate live row) or error.
 *
 * @param db  Database connection (or transaction handle)
 * @param companyId  Company that owns the memory item
 * @param item  The memory item row (at minimum {id, title?, content?})
 * @param tx  Optional Drizzle transaction handle — use when called inside a
 *            transaction so the dedup SELECT and INSERT are on the same
 *            connection and see the correct isolation snapshot.
 */
export async function enqueueMemoryEmbedding(
  db: Db,
  companyId: string,
  item: MemoryItemLike,
  tx?: Db,
): Promise<void> {
  const handle = tx ?? db;

  try {
    // Guard 1: pgvector must be present (the embedding column only exists on
    // installations that ran migration 0038 on a vector-capable PG).
    if (!getDbCapabilities().hasVectorSupport) {
      return;
    }

    // Guard 2: compose input text; skip if nothing to embed.
    const inputText = [item.title, item.content].filter(Boolean).join("\n");
    if (!inputText) {
      return;
    }

    // Guard 3: dedup against a PENDING row only (P2, Codex).
    // A memory title/content edit while a row is still queued would otherwise
    // leave the row's inputText at the pre-edit content — and since
    // memoryService.update nulls the stored embedding and relies on this helper
    // for re-indexing, the worker would complete with a stale vector.
    //   - A 'pending' row hasn't been claimed yet, so we can safely REFRESH its
    //     inputText in place (no duplicate, latest content wins).
    //   - A 'processing' row has ALREADY been claimed: the worker copied the old
    //     inputText and will unconditionally write that vector and mark the row
    //     'completed'. Refreshing it would be lost. So we DON'T dedupe against
    //     processing rows — we insert a fresh 'pending' row, which the worker
    //     picks up after the in-flight embed finishes, re-embedding the new text.
    const existingPending = await (handle as any)
      .select({ id: embeddingQueue.id })
      .from(embeddingQueue)
      .where(
        and(
          eq(embeddingQueue.targetTable, "memory_items"),
          eq(embeddingQueue.targetId, item.id),
          eq(embeddingQueue.targetColumn, "embedding"),
          eq(embeddingQueue.status, "pending"),
        ),
      )
      .limit(1);

    if (existingPending.length > 0) {
      // Refreshing the input means this row now represents NEW content, so give
      // it a fresh retry budget (P2, Codex): if the row was mid transient-retry
      // (nonzero attempts + old error), keeping that count would make the worker
      // dead-letter the new text after a single further failure. Reset attempts
      // + error + nextRetryAt so the edited content gets full retries.
      await (handle as any)
        .update(embeddingQueue)
        .set({
          inputText,
          attempts: 0,
          error: null,
          nextRetryAt: null,
          updatedAt: new Date(),
        })
        .where(eq(embeddingQueue.id, existingPending[0].id));
      return;
    }

    // No pending row (none at all, or only an in-flight 'processing' one) —
    // insert a fresh pending row so the latest content is embedded.
    await (handle as any)
      .insert(embeddingQueue)
      .values({
        companyId,
        targetTable: "memory_items",
        targetId: item.id,
        targetColumn: "embedding",
        inputText,
        status: "pending",
      });
  } catch (err: unknown) {
    // Best-effort: log the warning and swallow — enqueue failure must never
    // break the memory write that triggered this call.
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ itemId: item.id, companyId, err: msg }, "enqueueMemoryEmbedding: non-fatal enqueue failure");
  }
}

/**
 * Count the founder-gated pending memory items for a company.
 *
 * Predicate (IDENTICAL to reconcileMemoryReview in hub-items.ts so the emit
 * count and the reconcile count can never disagree):
 *   status = 'pending' AND source <> 'founder' AND (layer IS NULL OR layer <> 'working').
 *
 * The `layer` column is NULLABLE — `ne(layer,'working')` alone silently drops
 * NULL-layer rows and undercounts, so the `or(isNull(layer), ne(...))` form is
 * REQUIRED. Founder-authored memory is auto-approved (never pending) and working
 * memory is ephemeral/auto-created, so both are excluded from the review signpost.
 */
async function countPendingMemory(db: Db, companyId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(memoryItems)
    .where(
      and(
        eq(memoryItems.companyId, companyId),
        eq(memoryItems.status, "pending"),
        ne(memoryItems.source, "founder"),
        or(isNull(memoryItems.layer), ne(memoryItems.layer, "working")),
      ),
    );
  return Number(row?.count ?? 0);
}

/**
 * Create a memory item and immediately enqueue it for embedding.
 *
 * This is the public entry point that Task 9 crew/MCP wrappers should call
 * instead of `memoryService(db).create(...)` directly. Using this function
 * guarantees that every newly created memory item enters the embedding queue,
 * closing the RAG coverage gap where `create` previously never enqueued.
 *
 * @param db  Database connection
 * @param companyId  Owning company
 * @param data  Memory item fields (excluding companyId — it is injected here)
 * @param tx  Optional transaction handle, forwarded to both the insert and
 *            the enqueue (dedup SELECT + INSERT share the same tx snapshot).
 */
export async function writeMemoryAndIndex(
  db: Db,
  companyId: string,
  data: Omit<typeof memoryItems.$inferInsert, "companyId">,
  tx?: Db,
): Promise<Awaited<ReturnType<ReturnType<typeof memoryService>["create"]>>> {
  const svc = memoryService(db);
  const row = await svc.create(companyId, data, tx as any);
  // enqueueMemoryEmbedding is also called inside `create` (via memory.ts wiring),
  // but the dedup guard ensures no double-insert occurs. We call it here too so
  // that callers of `writeMemoryAndIndex` that bypass the wired path still get
  // coverage — and the dedup makes this a safe no-op if create already queued it.
  if (row) {
    await enqueueMemoryEmbedding(db, companyId, row, tx);
  }

  // SCOPING LIMIT (M3b): this signpost fires ONLY for writes that go through
  // writeMemoryAndIndex — the crew `write_memory` (Librarian) and MCP
  // `memory.write` tools (the primary paths for this feature, which work
  // correctly). Pending memory created via memoryService.create + a direct
  // enqueueMemoryEmbedding — MCP suggest_memory / memory.retain, the Commander
  // memory tool, and agent-proposal creates in thread-scope-versions.ts /
  // suggestions.ts — BYPASSES this chokepoint and does NOT emit here; such a row
  // surfaces only when a later writeMemoryAndIndex write re-emits the company
  // aggregate. Consistent with the spec's chokepoint choice, but a real coverage
  // limit: broadening the emit to the shared create path is a tracked follow-up
  // (needs a guard on the create row's status/source/layer). Do NOT silently
  // assume every pending write signposts.
  //
  // Signpost founder-gated pending memory in the Inbox (memory_review, Mem T4).
  // ONE hub row per company; the count is the total founder-gated pending memory
  // across ALL scopes. Guard on this specific write leaving a founder-gated item
  // in `pending`:
  //   - status === "pending"   (auto-approved founder writes never signpost)
  //   - source !== "founder"    (the founder's own writes are already approved)
  //   - layer !== "working"     (ephemeral, auto-created — never founder-gated)
  // NOTE: the guard uses plain `!==`, so a NULL layer is `!== "working"` → true
  // and DOES signpost — intentional, matching the count predicate's or(isNull…)
  // form. Best-effort: a hub failure must NEVER fail the memory write. We pass
  // `tx ?? db` to both the count and the emit so an in-transaction caller stays
  // on the same snapshot (forward-safety; no caller threads a tx today).
  if (row && row.status === "pending" && row.source !== "founder" && row.layer !== "working") {
    const conn = tx ?? db;
    try {
      const founder = await orgHierarchyService(conn).getFounderUserId(companyId);
      const count = await countPendingMemory(conn, companyId);
      await emitHubItem(
        conn,
        buildMemoryReviewHubEmit({ companyId, count, ownerUserId: founder }),
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ itemId: row.id, companyId, err: msg }, "memory_review emit failed (non-fatal)");
    }
  }

  return row;
}
