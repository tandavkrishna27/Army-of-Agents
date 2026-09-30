import { and, eq, ilike, or, sql, desc, isNull, gt, inArray, type SQL } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { agents, embeddingQueue, memoryItems, memoryItemVersions, memoryRetrievals, suggestions } from "@armyofagents/db";
import { MEMORY_ITEM_LAYERS, normalizeMemoryFolderPath } from "@armyofagents/shared";
import { generateEmbedding } from "./embeddings.js";
import { enqueueMemoryEmbedding } from "./memory-write.js";
import { hubItemsService } from "./hub-items.js";
// Query-side key resolution MUST match the write-side worker + resolveSemanticAvailable:
// getProviderApiKey resolves the per-company llm:openai secret AND falls back to env
// OPENAI_API_KEY. The old resolveApiKey had no env fallback, so env-only installs
// indexed vectors (worker) but could never embed the QUERY → semantic recall silently
// fell back to keyword while the UI reported semantic available (P2, Codex).
import { getProviderApiKey } from "./internal-agent/providers/index.js";
import { logger } from "../middleware/logger.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { getDbCapabilities } from "./db-capabilities.js";
import { buildMemoryInsert, memoryItemsSelection } from "./memory-projection.js";
import { publishLiveEvent } from "./live-events.js";
import { deriveIndexStatus } from "./memory-index-status.js";
const log = logger.child({ service: "memory" });

/** Validate embedding values are all finite numbers and format for pgvector. */
function toVectorString(embedding: number[]): string {
  for (let i = 0; i < embedding.length; i++) {
    if (!Number.isFinite(embedding[i])) {
      throw new Error(`Invalid embedding value at index ${i}: ${embedding[i]}`);
    }
  }
  return `[${embedding.join(",")}]`;
}

export interface MemoryFilters {
  category?: string;
  status?: string;
  source?: string;
  departmentId?: string;
  projectId?: string;
  layer?: string;
  tags?: string[];
  search?: string;
  /**
   * RBAC WHERE conditions (from `memoryAccessConditions`) AND-ed into the query
   * so a scoped actor can never list memory it isn't entitled to. Empty/undefined
   * leaves the list unfiltered (the prior behavior for board/founder callers).
   */
  accessConditions?: SQL[];
}

export interface SemanticSearchFilters {
  layer?: string;
  departmentId?: string;
  limit?: number;
}

export interface FindSimilarScope {
  companyId: string;
  departmentId?: string;
  layer?: string;
  /**
   * RBAC WHERE conditions (from `memoryAccessConditions`) AND-ed into both the
   * semantic and text-overlap-fallback fetches so an agent actor can never see
   * a candidate row it isn't entitled to (U2a). Empty/undefined leaves the
   * search unfiltered (board/founder callers, unchanged behavior).
   */
  accessConditions?: SQL[];
}

// Multi-pathway retrieval: combines semantic + keyword + temporal
// pathways via reciprocal rank fusion (RRF), then re-weights by trust
// signals (validationCount, accessedAt, lastValidatedAt).
//
// Each pathway returns up to PATHWAY_FETCH_LIMIT items. RRF gives
// stable ranking even when pathways disagree, then trust-weight nudges
// validated items above unvalidated peers.
const RRF_K = 60;
const PATHWAY_FETCH_LIMIT = 50;
const VALIDATION_BOOST_WEIGHT = 0.1;
const ACCESSED_DECAY_DAYS = 30;
const ACCESSED_BOOST_WEIGHT = 0.05;
const VALIDATED_DECAY_DAYS = 60;
const VALIDATED_BOOST_WEIGHT = 0.05;

export interface MultiPathSearchFilters {
  /** Restrict to items in this layer (identity / domain / active_context / working). */
  layer?: string;
  /** Restrict to items scoped to this department (project of type 'department'). */
  departmentId?: string;
  /** Restrict to items scoped to this project (project of type 'project'). */
  projectId?: string;
  /** Restrict to items scoped to this goal. */
  goalId?: string;
  /** Restrict to items in this category. */
  category?: string;
  /** Final top-K to return after RRF + trust weighting. Default 10. */
  limit?: number;
  /** Toggle individual pathways. All true by default. */
  enableSemantic?: boolean;
  enableKeyword?: boolean;
  enableTemporal?: boolean;
  /**
   * RBAC WHERE conditions (from `memoryAccessConditions`) AND-ed into every
   * pathway so a scoped actor can never rank — nor leak — memory it isn't
   * entitled to. Empty/undefined leaves the search unfiltered (founder board).
   */
  accessConditions?: SQL[];
}

export interface SearchAuditCandidatesFilters {
  layer?: string;
  limit?: number;
}

export interface MultiPathSearchResult {
  id: string;
  companyId: string;
  title: string;
  content: string;
  category: string;
  source: string;
  status: string;
  tags: string[] | null;
  departmentId: string | null;
  projectId: string | null;
  goalId: string | null;
  taskId: string | null;
  conversationId: string | null;
  createdBy: string;
  layer: string | null;
  visibility: string;
  expiresAt: Date | null;
  priority: number;
  validationCount: number;
  agentId: string | null;
  ownerType: string | null;
  ownerId: string | null;
  invalidatedAt: Date | null;
  pinnedToSkill: boolean;
  createdAt: Date;
  updatedAt: Date;
  /** Sum of 1/(60+rank) across pathways that returned this item. */
  rrfScore: number;
  /** rrfScore × trustWeight (validation + recency boost). Final ranking key. */
  finalScore: number;
  /** Cosine 1-distance from semantic pathway, or null if not present in semantic results. */
  similarity: number | null;
  semanticRank: number | null;
  keywordRank: number | null;
  temporalRank: number | null;
}

function isValidLayer(layer: string | null | undefined): boolean {
  return !!layer && MEMORY_ITEM_LAYERS.includes(layer as (typeof MEMORY_ITEM_LAYERS)[number]);
}

// ─── Index-status enrichment helpers (Task W5) ────────────────────────────────

/**
 * Batch-fetch the latest embedding_queue status for a set of memory item IDs.
 * Uses a single query (no N+1): selects all rows for the given IDs then keeps
 * the most recently created row per targetId.
 *
 * Returns a Map: targetId → latest queue status string.
 * IDs with no queue row are absent from the map (callers treat as null).
 */
async function batchFetchQueueStatuses(
  db: Db,
  ids: string[],
): Promise<Map<string, "pending" | "processing" | "completed" | "failed">> {
  if (ids.length === 0) return new Map();

  // One query: fetch all queue rows for these items ordered newest-first.
  // We then keep only the first-seen row per targetId (= latest by createdAt).
  const rows = await db
    .select({
      targetId: embeddingQueue.targetId,
      status: embeddingQueue.status,
    })
    .from(embeddingQueue)
    .where(
      and(
        eq(embeddingQueue.targetTable, "memory_items"),
        inArray(embeddingQueue.targetId, ids),
      ),
    )
    .orderBy(desc(embeddingQueue.createdAt));

  const result = new Map<string, "pending" | "processing" | "completed" | "failed">();
  for (const row of rows) {
    if (!result.has(row.targetId)) {
      result.set(
        row.targetId,
        row.status as "pending" | "processing" | "completed" | "failed",
      );
    }
  }
  return result;
}

/**
 * Determine whether the embedding column IS NOT NULL for a given item row.
 * When pgvector is absent, the embedding column doesn't exist so always false.
 * When it exists, the row's `embedding` field is a non-null value if set.
 *
 * `memoryItemsSelection()` includes the `embedding` column only when
 * `hasVectorSupport` is true; otherwise the field is absent on the row.
 * We rely on that: if the field is present and truthy, the vector exists.
 */
function rowHasVector(row: Record<string, unknown>): boolean {
  return row.embedding != null;
}


// Best-effort: recompute/close the company's memory_review Inbox signpost after a
// memory item leaves 'pending' — approve, reject, a status-changing update, or a
// delete of a pending row. This is the SERVICE-level chokepoint every such route
// funnels through (PATCH /:id → update, the approve/reject routes → approve/reject,
// DELETE → remove), so we hook here rather than per-route and never miss a path.
// Publish/restore/version-approve deliberately do NOT call this: they mutate
// memory_item_versions or move an ARCHIVED item to approved — neither changes a
// parent item's `pending` status, so the founder-gated pending count is unaffected.
// A hub failure must NEVER fail the memory mutation that triggered it.
async function signpostMemoryReview(db: Db, companyId: string): Promise<void> {
  try {
    await hubItemsService(db).reconcile(companyId, { sourceType: "memory" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ companyId, err: msg }, "memory_review reconcile failed (non-fatal)");
  }
}

export function memoryService(db: Db) {
  return {
    list: async (companyId: string, filters: MemoryFilters = {}) => {
      const conditions = [eq(memoryItems.companyId, companyId)];

      if (filters.category) {
        conditions.push(eq(memoryItems.category, filters.category));
      }
      if (filters.status) {
        conditions.push(eq(memoryItems.status, filters.status));
      }
      if (filters.source) {
        conditions.push(eq(memoryItems.source, filters.source));
      }
      if (filters.departmentId) {
        conditions.push(eq(memoryItems.departmentId, filters.departmentId));
      }
      if (filters.projectId) {
        conditions.push(eq(memoryItems.projectId, filters.projectId));
      }
      if (filters.layer) {
        conditions.push(eq(memoryItems.layer, filters.layer));
      }
      if (filters.search) {
        conditions.push(
          or(
            ilike(memoryItems.title, `%${filters.search}%`),
            ilike(memoryItems.content, `%${filters.search}%`),
          )!,
        );
      }
      if (filters.tags && filters.tags.length > 0) {
        // Check if any of the requested tags exist in the JSONB tags array
        for (const tag of filters.tags) {
          conditions.push(sql`${memoryItems.tags} @> ${JSON.stringify([tag])}::jsonb`);
        }
      }
      // RBAC gate (P1-T5): AND the caller's access conditions into the list so a
      // scoped actor never sees memory outside its entitlement. Resolves goal/task
      // scope in-SQL via the project_goals junction + issues.projectId.
      if (filters.accessConditions?.length) conditions.push(...filters.accessConditions);

      const rows = await db.select(memoryItemsSelection()).from(memoryItems).where(and(...conditions));
      // Enrich with per-item indexStatus (Task W5 — additive field, array contract preserved).
      // semanticAvailable lives at the route level — call resolveSemanticAvailable() there.
      const queueStatuses = await batchFetchQueueStatuses(
        db,
        rows.map((r) => (r as Record<string, unknown>).id as string),
      );
      return rows.map((item) => ({
        // Spread the TYPED row (not a Record<string,unknown> cast) so the base
        // MemoryItem fields survive in the result type — object spread drops a
        // spread source's index signature, which would erase layer/status/etc.
        ...item,
        indexStatus: deriveIndexStatus({
          hasVector: rowHasVector(item as Record<string, unknown>),
          queueStatus:
            queueStatuses.get((item as { id: string }).id) ?? null,
        }),
      }));
    },

    searchAuditCandidates: (companyId: string, query: string, filters: SearchAuditCandidatesFilters = {}) => {
      const trimmed = query.trim();
      if (!trimmed) return Promise.resolve([]);

      const conditions = [
        eq(memoryItems.companyId, companyId),
        or(
          ilike(memoryItems.title, `%${trimmed}%`),
          ilike(memoryItems.content, `%${trimmed}%`),
        )!,
      ];
      if (filters.layer) {
        conditions.push(eq(memoryItems.layer, filters.layer));
      }

      return db
        .select(memoryItemsSelection())
        .from(memoryItems)
        .where(and(...conditions))
        .orderBy(desc(memoryItems.priority), desc(memoryItems.updatedAt))
        .limit(Math.min(filters.limit ?? 50, 100));
    },

    getById: async (companyId: string, id: string, accessConditions?: SQL[]) => {
      // RBAC gate (P1-T5): the optional accessConditions (from
      // `memoryAccessConditions`) are AND-ed into the WHERE so a by-id read
      // resolves goal/task scope in-SQL — a row the actor can't see returns null
      // (not a post-fetch-only decision, which would leak goal/task-scoped rows).
      const rows = await db
        .select(memoryItemsSelection())
        .from(memoryItems)
        .where(
          and(
            eq(memoryItems.id, id),
            eq(memoryItems.companyId, companyId),
            ...(accessConditions ?? []),
          ),
        );
      const row = rows[0] ?? null;
      if (!row) return null;
      // Enrich with per-item indexStatus (Task W5 — additive field, same outer shape).
      const queueStatuses = await batchFetchQueueStatuses(db, [id]);
      return {
        // Spread the TYPED row (see list() note) so base fields survive.
        ...row,
        indexStatus: deriveIndexStatus({
          hasVector: rowHasVector(row as Record<string, unknown>),
          queueStatus: queueStatuses.get(id) ?? null,
        }),
      };
    },

    create: (
      companyId: string,
      data: Omit<typeof memoryItems.$inferInsert, "companyId">,
      tx?: Parameters<Parameters<typeof db.transaction>[0]>[0],
    ) => {
      // Critical rule #6: Founder-created items are auto-approved; all others default to pending
      // Respect explicit status when provided (e.g. from brief approval where founder has already approved)
      if (data.source === "agent") {
        if (!isValidLayer(data.layer)) {
          throw badRequest("Agent memory suggestions must include a valid layer");
        }
        if (!data.sourceContext?.trim()) {
          throw badRequest("sourceContext is required for agent memory suggestions");
        }
      }
      const status = data.source === "agent"
        ? "pending"
        : (data.status ?? (data.source === "founder" ? "approved" : "pending"));
      // Drizzle 0.38's .insert(table).values({...}) enumerates EVERY schema
      // column — including `embedding` — and fills unspecified ones with SQL
      // DEFAULT. On installs without pgvector, the `embedding` column doesn't
      // exist (migration 0038 creates it conditionally), so Drizzle's column
      // list references a non-existent column and postgres errors.
      //
      // Work around this by building the insert via a raw sql template that
      // omits `embedding` when pgvector is absent. The RETURNING projection
      // stays in sync via memoryItemsSelection().
      const caps = getDbCapabilities();
      const values: Record<string, unknown> = { ...data, companyId, status };
      if (caps.hasVectorSupport) {
        values.embedding = null;
      }
      return buildMemoryInsert((tx ?? db) as Db, values, caps.hasVectorSupport).then(
        async (rows) => {
          const row = rows[0];
          // Status-agnostic: enqueue immediately regardless of pending/approved.
          // Dedup guard in enqueueMemoryEmbedding ensures no double-insert.
          if (row) {
            await enqueueMemoryEmbedding(db, companyId, row, tx as unknown as Db | undefined);
          }
          return row;
        },
      );
    },

    update: (companyId: string, id: string, data: Partial<typeof memoryItems.$inferInsert>) => {
      // If content or title changed, invalidate embedding so background worker
      // regenerates it. Only touch the column when pgvector is present.
      const caps = getDbCapabilities();
      const hasContentChange = data.content !== undefined || data.title !== undefined;
      // A status/layer/source edit can move an item into or out of the
      // founder-gated pending set → recompute the Inbox signpost. Plain content
      // edits keep the count unchanged, so we skip the reconcile to avoid churn.
      const affectsPendingCount =
        data.status !== undefined || data.layer !== undefined || data.source !== undefined;
      const setData: Record<string, unknown> = { ...data, updatedAt: new Date() };
      if (hasContentChange && caps.hasVectorSupport) {
        setData.embedding = null;
      }
      return db
        .update(memoryItems)
        .set(setData)
        .where(and(eq(memoryItems.id, id), eq(memoryItems.companyId, companyId)))
        .returning(memoryItemsSelection(caps.hasVectorSupport))
        .then(async (rows) => {
          const row = rows[0] ?? null;
          // Re-index when content/title changed — dedup guard prevents
          // double-insert if the item is already pending in the queue.
          if (row && hasContentChange) {
            await enqueueMemoryEmbedding(db, companyId, row);
          }
          if (row && affectsPendingCount) {
            await signpostMemoryReview(db, companyId);
          }
          return row;
        });
    },

    remove: (companyId: string, id: string) =>
      db
        .delete(memoryItems)
        .where(and(eq(memoryItems.id, id), eq(memoryItems.companyId, companyId)))
        .returning(memoryItemsSelection())
        .then(async (rows) => {
          const row = rows[0] ?? null;
          // Deleting a pending item shrinks the founder-gated count → recompute
          // the Inbox signpost (only when the removed row was actually pending).
          if (row && row.status === "pending") {
            await signpostMemoryReview(db, companyId);
          }
          return row;
        }),

    approve: (companyId: string, id: string) =>
      db
        .update(memoryItems)
        .set({ status: "approved", updatedAt: new Date() })
        .where(and(eq(memoryItems.id, id), eq(memoryItems.companyId, companyId)))
        .returning(memoryItemsSelection())
        .then(async (rows) => {
          const row = rows[0] ?? null;
          // Enqueue (deduped) — covers items that were created on installs
          // where the create-enqueue was skipped (e.g. no pgvector at create
          // time, or items that pre-date this wiring).
          if (row) {
            await enqueueMemoryEmbedding(db, companyId, row);
          }
          // The item just left 'pending' → recompute/close the Inbox signpost.
          await signpostMemoryReview(db, companyId);
          return row;
        }),

    reject: (companyId: string, id: string) =>
      db
        .update(memoryItems)
        .set({ status: "rejected", updatedAt: new Date() })
        .where(and(eq(memoryItems.id, id), eq(memoryItems.companyId, companyId)))
        .returning(memoryItemsSelection())
        .then(async (rows) => {
          const row = rows[0] ?? null;
          // The item just left 'pending' → recompute/close the Inbox signpost.
          await signpostMemoryReview(db, companyId);
          return row;
        }),

    /**
     * Semantic search: embed the query text and find memory items by cosine similarity.
     * Falls back to text-based ilike search when embeddings are unavailable (no API key).
     */
    searchSemantic: async (
      companyId: string,
      query: string,
      filters: SemanticSearchFilters = {},
    ) => {
      const limit = filters.limit ?? 10;
      const caps = getDbCapabilities();

      // Try to get API key for embedding generation. Skip entirely when
      // pgvector isn't installed — the embedding column doesn't exist so
      // cosine-distance SQL would 500; fall through to text search.
      let apiKey: string | null = null;
      if (caps.hasVectorSupport) {
        try {
          apiKey = await getProviderApiKey(db, companyId, "openai");
        } catch {
          // No API key — fall back to text search
        }
      }

      if (apiKey) {
        try {
          const queryEmbedding = await generateEmbedding(query, apiKey);
          const vectorStr = toVectorString(queryEmbedding);

          const conditions = [
            eq(memoryItems.companyId, companyId),
            eq(memoryItems.status, "approved"),
            sql`${memoryItems.embedding} IS NOT NULL`,
            // A-M5: drop expired active_context (other layers leave expiresAt null).
            or(isNull(memoryItems.expiresAt), gt(memoryItems.expiresAt, sql`now()`))!,
          ];

          if (filters.layer) {
            conditions.push(eq(memoryItems.layer, filters.layer));
          }
          if (filters.departmentId) {
            conditions.push(eq(memoryItems.departmentId, filters.departmentId));
          }

          const results = await db
            .select({
              id: memoryItems.id,
              companyId: memoryItems.companyId,
              title: memoryItems.title,
              content: memoryItems.content,
              category: memoryItems.category,
              source: memoryItems.source,
              status: memoryItems.status,
              tags: memoryItems.tags,
              departmentId: memoryItems.departmentId,
              projectId: memoryItems.projectId,
              layer: memoryItems.layer,
              priority: memoryItems.priority,
              similarity: sql<number>`1 - (${memoryItems.embedding} <=> ${vectorStr}::vector)`.as("similarity"),
              createdAt: memoryItems.createdAt,
              updatedAt: memoryItems.updatedAt,
            })
            .from(memoryItems)
            .where(and(...conditions))
            .orderBy(sql`${memoryItems.embedding} <=> ${vectorStr}::vector`)
            .limit(limit);

          return results;
        } catch (err: any) {
          log.warn({ error: err.message }, "Semantic search failed, falling back to text search");
        }
      }

      // Fallback: text-based search
      const conditions = [
        eq(memoryItems.companyId, companyId),
        eq(memoryItems.status, "approved"),
        // A-M5: drop expired active_context (other layers leave expiresAt null).
        or(isNull(memoryItems.expiresAt), gt(memoryItems.expiresAt, sql`now()`))!,
        or(
          ilike(memoryItems.title, `%${query}%`),
          ilike(memoryItems.content, `%${query}%`),
        )!,
      ];

      if (filters.layer) {
        conditions.push(eq(memoryItems.layer, filters.layer));
      }
      if (filters.departmentId) {
        conditions.push(eq(memoryItems.departmentId, filters.departmentId));
      }

      const textResults = await db
        .select({
          id: memoryItems.id,
          companyId: memoryItems.companyId,
          title: memoryItems.title,
          content: memoryItems.content,
          category: memoryItems.category,
          source: memoryItems.source,
          status: memoryItems.status,
          tags: memoryItems.tags,
          departmentId: memoryItems.departmentId,
          projectId: memoryItems.projectId,
          layer: memoryItems.layer,
          priority: memoryItems.priority,
          similarity: sql<number>`NULL`.as("similarity"),
          createdAt: memoryItems.createdAt,
          updatedAt: memoryItems.updatedAt,
        })
        .from(memoryItems)
        .where(and(...conditions))
        .orderBy(desc(memoryItems.priority), desc(memoryItems.updatedAt))
        .limit(limit);

      return textResults;
    },

    /**
     * Multi-pathway memory search.
     *
     * Runs SEMANTIC + KEYWORD + TEMPORAL pathways in parallel against
     * memory_items, merges results via reciprocal rank fusion (RRF),
     * then re-weights each item by trust signals (validationCount,
     * accessedAt, lastValidatedAt) before returning the final top-K.
     *
     * Pathway behavior:
     *  - SEMANTIC: pgvector cosine distance. Skipped when pgvector is
     *    unavailable or the company has no OpenAI key (graceful degrade
     *    to keyword + temporal).
     *  - KEYWORD: ilike on title + content. Skipped when query is empty.
     *  - TEMPORAL: ranks by validation count + decayed recency (accessed
     *    + lastValidated). Independent of query text.
     *
     * RRF formula: score(item) = Σ_pathways 1 / (RRF_K + rank_in_pathway)
     * Final score: rrfScore × (1 + validationBonus + accessedBonus + validatedBonus)
     *
     * Cost: 3 parallel queries (one of which may also hit OpenAI for
     * embedding the query). p50 ~150ms.
     *
     * Scope filters (departmentId, projectId, goalId, layer, category) apply
     * BEFORE search runs. RBAC is enforced in-SQL via `accessConditions`
     * (from `memoryAccessConditions`) AND-ed into every pathway; the caller
     * still runs `filterMemoryForActor` over the results as a safety net.
     */
    searchMultiPath: async (
      companyId: string,
      query: string,
      filters: MultiPathSearchFilters = {},
    ): Promise<MultiPathSearchResult[]> => {
      const limit = filters.limit ?? 10;

      const buildConditions = () => {
        const conds = [
          eq(memoryItems.companyId, companyId),
          eq(memoryItems.status, "approved"),
          // A-M5: never serve expired active_context memory. Only active_context
          // sets expiresAt; other layers leave it null and isNull keeps those.
          // Use the DB clock (sql`now()`) so server/db time skew can't leak rows.
          or(isNull(memoryItems.expiresAt), gt(memoryItems.expiresAt, sql`now()`))!,
        ];
        if (filters.layer) conds.push(eq(memoryItems.layer, filters.layer));
        if (filters.category) conds.push(eq(memoryItems.category, filters.category));
        // Scope filters narrow to the run's dept/project/goal, but company-wide /
        // fully-unscoped memory (the scope column IS NULL) is always relevant and must
        // never be excluded by a scope filter (Decision #119). So each scope match is
        // "= the run's scope OR the row is unscoped on that column".
        if (filters.departmentId)
          conds.push(or(eq(memoryItems.departmentId, filters.departmentId), isNull(memoryItems.departmentId))!);
        if (filters.projectId)
          conds.push(or(eq(memoryItems.projectId, filters.projectId), isNull(memoryItems.projectId))!);
        if (filters.goalId)
          conds.push(or(eq(memoryItems.goalId, filters.goalId), isNull(memoryItems.goalId))!);
        // RBAC gate (P1-T2): AND the actor's access conditions into every pathway.
        if (filters.accessConditions?.length) conds.push(...filters.accessConditions);
        return conds;
      };

      const projection = {
        id: memoryItems.id,
        companyId: memoryItems.companyId,
        title: memoryItems.title,
        content: memoryItems.content,
        category: memoryItems.category,
        source: memoryItems.source,
        status: memoryItems.status,
        tags: memoryItems.tags,
        departmentId: memoryItems.departmentId,
        projectId: memoryItems.projectId,
        goalId: memoryItems.goalId,
        taskId: memoryItems.taskId,
        conversationId: memoryItems.conversationId,
        createdBy: memoryItems.createdBy,
        layer: memoryItems.layer,
        visibility: memoryItems.visibility,
        expiresAt: memoryItems.expiresAt,
        priority: memoryItems.priority,
        validationCount: memoryItems.validationCount,
        agentId: memoryItems.agentId,
        // Ownership + invalidation columns feed the post-fetch RBAC safety net
        // (filterMemoryForActor) that guards the searchMultiPath results.
        ownerType: memoryItems.ownerType,
        ownerId: memoryItems.ownerId,
        invalidatedAt: memoryItems.invalidatedAt,
        pinnedToSkill: memoryItems.pinnedToSkill,
        accessedAt: memoryItems.accessedAt,
        lastValidatedAt: memoryItems.lastValidatedAt,
        createdAt: memoryItems.createdAt,
        updatedAt: memoryItems.updatedAt,
      };

      // ── Pathway 1: SEMANTIC ─────────────────────────────────────
      const runSemantic = async (): Promise<Array<Record<string, unknown>>> => {
        if (filters.enableSemantic === false) return [];
        const caps = getDbCapabilities();
        if (!caps.hasVectorSupport) return [];

        let apiKey: string | null = null;
        try {
          apiKey = await getProviderApiKey(db, companyId, "openai");
        } catch {
          return [];
        }
        if (!apiKey) return [];

        try {
          const queryEmbedding = await generateEmbedding(query, apiKey);
          const vectorStr = toVectorString(queryEmbedding);

          const conds = buildConditions();
          conds.push(sql`${memoryItems.embedding} IS NOT NULL`);

          return await db
            .select({
              ...projection,
              similarity: sql<number>`1 - (${memoryItems.embedding} <=> ${vectorStr}::vector)`.as(
                "similarity",
              ),
            })
            .from(memoryItems)
            .where(and(...conds))
            .orderBy(sql`${memoryItems.embedding} <=> ${vectorStr}::vector`)
            .limit(PATHWAY_FETCH_LIMIT);
        } catch (err: unknown) {
          log.warn(
            { error: err instanceof Error ? err.message : String(err) },
            "Semantic pathway failed in multi-path search; continuing with keyword + temporal",
          );
          return [];
        }
      };

      // ── Pathway 2: KEYWORD (ilike) ──────────────────────────────
      const runKeyword = async (): Promise<Array<Record<string, unknown>>> => {
        if (filters.enableKeyword === false) return [];
        const trimmed = query.trim();
        if (!trimmed) return [];

        const conds = buildConditions();
        conds.push(
          or(
            ilike(memoryItems.title, `%${trimmed}%`),
            ilike(memoryItems.content, `%${trimmed}%`),
          )!,
        );

        return await db
          .select(projection)
          .from(memoryItems)
          .where(and(...conds))
          .orderBy(desc(memoryItems.priority), desc(memoryItems.updatedAt))
          .limit(PATHWAY_FETCH_LIMIT);
      };

      // ── Pathway 3: TEMPORAL (recency + validation) ──────────────
      const runTemporal = async (): Promise<Array<Record<string, unknown>>> => {
        if (filters.enableTemporal === false) return [];
        const conds = buildConditions();

        return await db
          .select(projection)
          .from(memoryItems)
          .where(and(...conds))
          .orderBy(
            sql`(LN(1 + ${memoryItems.validationCount}) * 0.4 +
                 EXP(-EXTRACT(EPOCH FROM (NOW() - COALESCE(${memoryItems.accessedAt}, ${memoryItems.updatedAt}))) / ${ACCESSED_DECAY_DAYS * 86400}) * 0.3 +
                 EXP(-EXTRACT(EPOCH FROM (NOW() - COALESCE(${memoryItems.lastValidatedAt}, ${memoryItems.updatedAt}))) / ${VALIDATED_DECAY_DAYS * 86400}) * 0.3) DESC`,
          )
          .limit(PATHWAY_FETCH_LIMIT);
      };

      const [semanticRows, keywordRows, temporalRows] = await Promise.all([
        runSemantic(),
        runKeyword(),
        runTemporal(),
      ]);

      // ── RRF merge ───────────────────────────────────────────────
      interface MergedEntry {
        item: Record<string, unknown>;
        rrfScore: number;
        similarity: number | null;
        semanticRank: number | null;
        keywordRank: number | null;
        temporalRank: number | null;
      }
      const merged = new Map<string, MergedEntry>();

      const accumulate = (
        rows: Array<Record<string, unknown>>,
        pathway: "semantic" | "keyword" | "temporal",
      ) => {
        rows.forEach((row, idx) => {
          const id = String(row.id);
          const rank = idx + 1;
          const contribution = 1 / (RRF_K + rank);
          let entry = merged.get(id);
          if (!entry) {
            entry = {
              item: row,
              rrfScore: 0,
              similarity: null,
              semanticRank: null,
              keywordRank: null,
              temporalRank: null,
            };
            merged.set(id, entry);
          }
          entry.rrfScore += contribution;
          if (pathway === "semantic") {
            entry.semanticRank = rank;
            const sim = (row as { similarity?: unknown }).similarity;
            entry.similarity = typeof sim === "number" ? sim : null;
          } else if (pathway === "keyword") {
            entry.keywordRank = rank;
          } else {
            entry.temporalRank = rank;
          }
        });
      };

      accumulate(semanticRows, "semantic");
      accumulate(keywordRows, "keyword");
      accumulate(temporalRows, "temporal");

      // ── Trust weighting ─────────────────────────────────────────
      const now = Date.now();
      const accessedDecayMs = ACCESSED_DECAY_DAYS * 86400 * 1000;
      const validatedDecayMs = VALIDATED_DECAY_DAYS * 86400 * 1000;

      const results: MultiPathSearchResult[] = [];
      for (const entry of merged.values()) {
        const item = entry.item as Record<string, unknown>;
        const validationCount = typeof item.validationCount === "number" ? item.validationCount : 1;
        const validationBonus = Math.log(1 + validationCount) * VALIDATION_BOOST_WEIGHT;

        const accessedAt = item.accessedAt instanceof Date ? item.accessedAt : null;
        const accessedBonus = accessedAt
          ? Math.exp(-(now - accessedAt.getTime()) / accessedDecayMs) * ACCESSED_BOOST_WEIGHT
          : 0;

        const lastValidatedAt = item.lastValidatedAt instanceof Date ? item.lastValidatedAt : null;
        const validatedBonus = lastValidatedAt
          ? Math.exp(-(now - lastValidatedAt.getTime()) / validatedDecayMs) * VALIDATED_BOOST_WEIGHT
          : 0;

        const trustWeight = 1 + validationBonus + accessedBonus + validatedBonus;

        results.push({
          id: String(item.id),
          companyId: String(item.companyId),
          title: String(item.title),
          content: String(item.content),
          category: String(item.category),
          source: String(item.source),
          status: String(item.status),
          tags: (item.tags as string[] | null) ?? null,
          departmentId: (item.departmentId as string | null) ?? null,
          projectId: (item.projectId as string | null) ?? null,
          goalId: (item.goalId as string | null) ?? null,
          taskId: (item.taskId as string | null) ?? null,
          conversationId: (item.conversationId as string | null) ?? null,
          createdBy: String(item.createdBy),
          layer: (item.layer as string | null) ?? null,
          visibility: String(item.visibility),
          expiresAt: (item.expiresAt as Date | null) ?? null,
          priority: typeof item.priority === "number" ? item.priority : 0,
          validationCount,
          agentId: (item.agentId as string | null) ?? null,
          ownerType: (item.ownerType as string | null) ?? null,
          ownerId: (item.ownerId as string | null) ?? null,
          invalidatedAt: (item.invalidatedAt as Date | null) ?? null,
          pinnedToSkill: Boolean(item.pinnedToSkill),
          createdAt: item.createdAt as Date,
          updatedAt: item.updatedAt as Date,
          rrfScore: entry.rrfScore,
          finalScore: entry.rrfScore * trustWeight,
          similarity: entry.similarity,
          semanticRank: entry.semanticRank,
          keywordRank: entry.keywordRank,
          temporalRank: entry.temporalRank,
        });
      }

      results.sort((a, b) => b.finalScore - a.finalScore);
      return results.slice(0, limit);
    },

    /**
     * Find memory items with cosine similarity > 0.85 to the given content.
     * Used for dedup detection by the brief pipeline and manual checks.
     * Falls back to text-based overlap when embeddings are unavailable.
     */
    findSimilarItems: async (content: string, scope: FindSimilarScope) => {
      const SIMILARITY_THRESHOLD = 0.85;
      const caps = getDbCapabilities();

      let apiKey: string | null = null;
      if (caps.hasVectorSupport) {
        try {
          apiKey = await getProviderApiKey(db, scope.companyId, "openai");
        } catch {
          // No API key — fall back to text search
        }
      }

      if (apiKey) {
        try {
          const contentEmbedding = await generateEmbedding(content, apiKey);
          const vectorStr = toVectorString(contentEmbedding);

          const conditions = [
            eq(memoryItems.companyId, scope.companyId),
            eq(memoryItems.status, "approved"),
            sql`${memoryItems.embedding} IS NOT NULL`,
            sql`1 - (${memoryItems.embedding} <=> ${vectorStr}::vector) > ${SIMILARITY_THRESHOLD}`,
          ];

          if (scope.departmentId) {
            conditions.push(eq(memoryItems.departmentId, scope.departmentId));
          }
          if (scope.layer) {
            conditions.push(eq(memoryItems.layer, scope.layer));
          }
          // RBAC gate (U2a): AND the actor's access conditions into the fetch so
          // an agent actor's candidate set never includes memory it can't see.
          if (scope.accessConditions?.length) conditions.push(...scope.accessConditions);

          const results = await db
            .select({
              id: memoryItems.id,
              companyId: memoryItems.companyId,
              title: memoryItems.title,
              content: memoryItems.content,
              category: memoryItems.category,
              source: memoryItems.source,
              status: memoryItems.status,
              tags: memoryItems.tags,
              departmentId: memoryItems.departmentId,
              projectId: memoryItems.projectId,
              layer: memoryItems.layer,
              priority: memoryItems.priority,
              similarity: sql<number>`1 - (${memoryItems.embedding} <=> ${vectorStr}::vector)`.as("similarity"),
              createdAt: memoryItems.createdAt,
              updatedAt: memoryItems.updatedAt,
            })
            .from(memoryItems)
            .where(and(...conditions))
            .orderBy(sql`${memoryItems.embedding} <=> ${vectorStr}::vector`)
            .limit(20);

          return results;
        } catch (err: any) {
          log.warn({ error: err.message }, "Similarity search failed, falling back to text overlap");
        }
      }

      // Fallback: text-based search using word overlap
      // Find items that share significant word overlap (>60%) with the content
      const words = content
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2);
      if (words.length === 0) return [];

      // Use ilike to find potential matches, then filter by word overlap in-app
      const uniqueWords = [...new Set(words)];
      const searchTerms = uniqueWords.slice(0, 5); // Use top 5 unique words

      const conditions = [
        eq(memoryItems.companyId, scope.companyId),
        eq(memoryItems.status, "approved"),
      ];

      if (scope.departmentId) {
        conditions.push(eq(memoryItems.departmentId, scope.departmentId));
      }
      if (scope.layer) {
        conditions.push(eq(memoryItems.layer, scope.layer));
      }
      // RBAC gate (U2a): AND the actor's access conditions into the fallback
      // fetch too, so the text-overlap path can't leak what the vector path
      // gates.
      if (scope.accessConditions?.length) conditions.push(...scope.accessConditions);

      // Find candidates matching any search term
      const termConditions = searchTerms.map((term) =>
        or(
          ilike(memoryItems.title, `%${term}%`),
          ilike(memoryItems.content, `%${term}%`),
        )!,
      );

      const candidates = await db
        .select({
          id: memoryItems.id,
          companyId: memoryItems.companyId,
          title: memoryItems.title,
          content: memoryItems.content,
          category: memoryItems.category,
          source: memoryItems.source,
          status: memoryItems.status,
          tags: memoryItems.tags,
          departmentId: memoryItems.departmentId,
          projectId: memoryItems.projectId,
          layer: memoryItems.layer,
          priority: memoryItems.priority,
          createdAt: memoryItems.createdAt,
          updatedAt: memoryItems.updatedAt,
        })
        .from(memoryItems)
        .where(and(...conditions, or(...termConditions)))
        .limit(50);

      // Filter by word overlap > 60%
      return candidates
        .map((item) => {
          const itemWords = new Set(
            `${item.title} ${item.content}`
              .toLowerCase()
              .split(/\s+/)
              .filter((w) => w.length > 2),
          );
          const overlap = uniqueWords.filter((w) => itemWords.has(w)).length;
          const overlapRatio = overlap / uniqueWords.length;
          return { ...item, similarity: overlapRatio as number };
        })
        .filter((item) => item.similarity > 0.6)
        .sort((a, b) => b.similarity - a.similarity);
    },

    // ── Version management ──────────────────────────────────────────────

    getVersionHistory: (memoryItemId: string) =>
      db
        .select()
        .from(memoryItemVersions)
        .where(eq(memoryItemVersions.memoryItemId, memoryItemId))
        .orderBy(desc(memoryItemVersions.versionNumber)),

    suggestUpdate: async (
      companyId: string,
      memoryItemId: string,
      content: string,
      sourceContext: string,
      agentId: string,
    ) => {
      if (!content.trim()) {
        throw badRequest("content is required");
      }
      if (!sourceContext.trim()) {
        throw badRequest("sourceContext is required");
      }

      const item = await db
        .select(memoryItemsSelection())
        .from(memoryItems)
        .where(and(eq(memoryItems.id, memoryItemId), eq(memoryItems.companyId, companyId)))
        .then((rows) => rows[0] ?? null);

      if (!item) {
        throw notFound("Memory item not found");
      }
      if (item.status !== "approved") {
        throw conflict("Memory item must be approved before agents can suggest updates");
      }

      // A-M6 — version-number allocation must be conflict-safe. Two different
      // agents both pass the per-agent pending dedup, both read the same max
      // version, and both insert max+1 → the unique index
      // (memory_item_id, version_number) raises 23505 (an unhandled 500).
      // Serialize allocation: lock the PARENT memory_items row FOR UPDATE, then
      // run the dedup check + max-version read + insert inside the same tx so a
      // concurrent caller blocks until we commit and reads our committed state.
      // The dedup MUST be inside the lock — locking only the max read would
      // still let two callers act on stale pre-lock dedup decisions.
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select id from memory_items where id = ${memoryItemId} and company_id = ${companyId} for update`,
        );

        const existingPending = await tx
          .select()
          .from(memoryItemVersions)
          .where(
            and(
              eq(memoryItemVersions.memoryItemId, memoryItemId),
              eq(memoryItemVersions.status, "pending"),
              eq(memoryItemVersions.createdBy, agentId),
            ),
          )
          .then((rows) => rows[0] ?? null);

        if (existingPending) {
          return tx
            .update(memoryItemVersions)
            .set({ content })
            .where(eq(memoryItemVersions.id, existingPending.id))
            .returning()
            .then((rows) => rows[0]);
        }

        const latest = await tx
          .select({ versionNumber: memoryItemVersions.versionNumber })
          .from(memoryItemVersions)
          .where(eq(memoryItemVersions.memoryItemId, memoryItemId))
          .orderBy(desc(memoryItemVersions.versionNumber))
          .limit(1)
          .then((rows) => rows[0]?.versionNumber ?? 0);

        return tx
          .insert(memoryItemVersions)
          .values({
            memoryItemId,
            versionNumber: latest + 1,
            content,
            status: "pending",
            createdBy: agentId,
          })
          .returning()
          .then((rows) => rows[0]);
      });
    },

    approveSuggestedVersion: async (companyId: string, memoryItemId: string, versionId: string) => {
      const item = await db
        .select(memoryItemsSelection())
        .from(memoryItems)
        .where(and(eq(memoryItems.id, memoryItemId), eq(memoryItems.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!item) {
        throw notFound("Memory item not found");
      }

      const version = await db
        .select()
        .from(memoryItemVersions)
        .where(
          and(
            eq(memoryItemVersions.id, versionId),
            eq(memoryItemVersions.memoryItemId, memoryItemId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!version) {
        throw notFound("Memory version not found");
      }
      if (version.status !== "pending") {
        throw conflict("Only pending versions can be approved");
      }

      return db.transaction(async (tx) => {
        if (item.currentVersionId && item.currentVersionId !== version.id) {
          await tx
            .update(memoryItemVersions)
            .set({ status: "archived" })
            .where(eq(memoryItemVersions.id, item.currentVersionId));
        }

        const approved = await tx
          .update(memoryItemVersions)
          .set({ status: "approved" })
          .where(eq(memoryItemVersions.id, version.id))
          .returning()
          .then((rows) => rows[0]);

        await tx
          .update(memoryItems)
          .set({
            content: version.content,
            currentVersionId: version.id,
            updatedAt: new Date(),
          })
          .where(eq(memoryItems.id, memoryItemId));

        return approved;
      });
    },

    rejectSuggestedVersion: async (companyId: string, memoryItemId: string, versionId: string) => {
      const item = await db
        .select({ id: memoryItems.id })
        .from(memoryItems)
        .where(and(eq(memoryItems.id, memoryItemId), eq(memoryItems.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!item) {
        throw notFound("Memory item not found");
      }

      const version = await db
        .update(memoryItemVersions)
        .set({ status: "rejected" })
        .where(
          and(
            eq(memoryItemVersions.id, versionId),
            eq(memoryItemVersions.memoryItemId, memoryItemId),
            eq(memoryItemVersions.status, "pending"),
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null);

      if (!version) {
        throw notFound("Pending memory version not found");
      }

      return version;
    },

    saveDraft: async (companyId: string, memoryItemId: string, content: string, createdBy: string) => {
      const item = await db
        .select(memoryItemsSelection())
        .from(memoryItems)
        .where(and(eq(memoryItems.id, memoryItemId), eq(memoryItems.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!item) return null;

      // A-M6 — serialize version-number allocation. Lock the PARENT
      // memory_items row FOR UPDATE, then run the per-user draft dedup +
      // max-version read + insert inside the same tx. Without the lock two
      // different users both pass the per-user draft dedup and both insert
      // max+1, colliding on the unique (memory_item_id, version_number) index
      // → 23505 (an unhandled 500). The dedup MUST be inside the lock so a
      // concurrent caller can't act on a stale pre-lock decision.
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select id from memory_items where id = ${memoryItemId} and company_id = ${companyId} for update`,
        );

        // Check for existing draft by this user (against the now-locked state).
        const existingDraft = await tx
          .select()
          .from(memoryItemVersions)
          .where(
            and(
              eq(memoryItemVersions.memoryItemId, memoryItemId),
              eq(memoryItemVersions.status, "draft"),
              eq(memoryItemVersions.createdBy, createdBy),
            ),
          )
          .then((rows) => rows[0] ?? null);

        if (existingDraft) {
          // Update existing draft
          return tx
            .update(memoryItemVersions)
            .set({ content })
            .where(eq(memoryItemVersions.id, existingDraft.id))
            .returning()
            .then((rows) => rows[0]);
        }

        // Find the latest version number (inside the lock, so it reflects any
        // version a concurrent caller just committed).
        const latest = await tx
          .select({ versionNumber: memoryItemVersions.versionNumber })
          .from(memoryItemVersions)
          .where(eq(memoryItemVersions.memoryItemId, memoryItemId))
          .orderBy(desc(memoryItemVersions.versionNumber))
          .limit(1)
          .then((rows) => rows[0]?.versionNumber ?? 0);

        // Create new draft version
        return tx
          .insert(memoryItemVersions)
          .values({
            memoryItemId,
            versionNumber: latest + 1,
            content,
            status: "draft",
            createdBy,
          })
          .returning()
          .then((rows) => rows[0]);
      });
    },

    publishDraft: async (companyId: string, memoryItemId: string, createdBy: string) => {
      const item = await db
        .select(memoryItemsSelection())
        .from(memoryItems)
        .where(and(eq(memoryItems.id, memoryItemId), eq(memoryItems.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!item) return null;

      // Find the draft version by this user
      const draft = await db
        .select()
        .from(memoryItemVersions)
        .where(
          and(
            eq(memoryItemVersions.memoryItemId, memoryItemId),
            eq(memoryItemVersions.status, "draft"),
            eq(memoryItemVersions.createdBy, createdBy),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!draft) return null;

      // Wrap all mutations in a transaction for consistency
      return db.transaction(async (tx) => {
        // Archive the current approved version if any
        if (item.currentVersionId) {
          await tx
            .update(memoryItemVersions)
            .set({ status: "archived" })
            .where(eq(memoryItemVersions.id, item.currentVersionId));
        }

        // Publish the draft
        const published = await tx
          .update(memoryItemVersions)
          .set({ status: "approved" })
          .where(eq(memoryItemVersions.id, draft.id))
          .returning()
          .then((rows) => rows[0]);

        // Update the memory item content and currentVersionId
        await tx
          .update(memoryItems)
          .set({
            content: draft.content,
            currentVersionId: draft.id,
            updatedAt: new Date(),
          })
          .where(eq(memoryItems.id, memoryItemId));

        return published;
      });
    },

    restore: async (companyId: string, id: string) => {
      const item = await db
        .select(memoryItemsSelection())
        .from(memoryItems)
        .where(and(eq(memoryItems.id, id), eq(memoryItems.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!item || item.status !== "archived") return null;

      return db
        .update(memoryItems)
        .set({ status: "approved", updatedAt: new Date() })
        .where(eq(memoryItems.id, id))
        .returning(memoryItemsSelection())
        .then((rows) => rows[0] ?? null);
    },

    suggestArchive: async (
      companyId: string,
      memoryItemId: string,
      sourceContext: string,
      agentId: string,
    ) => {
      if (!sourceContext.trim()) {
        throw badRequest("sourceContext is required");
      }

      const item = await db
        .select(memoryItemsSelection())
        .from(memoryItems)
        .where(and(eq(memoryItems.id, memoryItemId), eq(memoryItems.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!item) {
        throw notFound("Memory item not found");
      }
      if (item.status !== "approved") {
        throw conflict("Only approved memory items can be archived");
      }

      const agent = await db
        .select({ name: agents.name })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      const agentName = agent?.name ?? agentId;

      const existing = await db
        .select()
        .from(suggestions)
        .where(
          and(
            eq(suggestions.companyId, companyId),
            eq(suggestions.category, "agent_proposal"),
            eq(suggestions.actionType, "archive_memory"),
            eq(suggestions.status, "pending"),
            eq(suggestions.relatedMemoryItemId, memoryItemId),
            sql`${suggestions.actionPayload}->>'agentId' = ${agentId}`,
          ),
        )
        .then((rows) => rows[0] ?? null);

      const title = `Agent ${agentName} suggests archiving '${item.title}'`;
      const actionPayload = {
        memoryItemId,
        reason: sourceContext,
        agentId,
      };
      const dedupeKey = `agent_proposal:archive_memory:${memoryItemId}:${agentId}`;

      if (existing) {
        return db
          .update(suggestions)
          .set({
            title,
            actionPayload,
            dedupeKey,
            updatedAt: new Date(),
          })
          .where(eq(suggestions.id, existing.id))
          .returning()
          .then((rows) => rows[0]);
      }

      const inserted = await db
        .insert(suggestions)
        .values({
          companyId,
          category: "agent_proposal",
          actionType: "archive_memory",
          actionPayload,
          title,
          dedupeKey,
          relatedMemoryItemId: memoryItemId,
        })
        .onConflictDoNothing()
        .returning()
        .then((rows) => rows[0] ?? null);

      if (inserted) return inserted;

      return db
        .select()
        .from(suggestions)
        .where(
          and(
            eq(suggestions.companyId, companyId),
            eq(suggestions.status, "pending"),
            eq(suggestions.dedupeKey, dedupeKey),
          ),
        )
        .then((rows) => rows[0]);
    },

    listPending: async (companyId: string) => {
      const [items, versionRows, archiveRows] = await Promise.all([
        db
          .select(memoryItemsSelection())
          .from(memoryItems)
          .where(
            and(
              eq(memoryItems.companyId, companyId),
              eq(memoryItems.status, "pending"),
              eq(memoryItems.source, "agent"),
            ),
          ),
        db
          .select({
            itemId: memoryItems.id,
            itemTitle: memoryItems.title,
            itemLayer: memoryItems.layer,
            itemDepartmentId: memoryItems.departmentId,
            itemCategory: memoryItems.category,
            itemSource: memoryItems.source,
            currentContent: memoryItems.content,
            currentVersionId: memoryItems.currentVersionId,
            versionId: memoryItemVersions.id,
            memoryItemId: memoryItemVersions.memoryItemId,
            versionNumber: memoryItemVersions.versionNumber,
            versionContent: memoryItemVersions.content,
            versionStatus: memoryItemVersions.status,
            versionCreatedBy: memoryItemVersions.createdBy,
            versionCreatedAt: memoryItemVersions.createdAt,
          })
          .from(memoryItemVersions)
          .innerJoin(memoryItems, eq(memoryItemVersions.memoryItemId, memoryItems.id))
          .where(
            and(
              eq(memoryItems.companyId, companyId),
              eq(memoryItemVersions.status, "pending"),
              eq(memoryItems.status, "approved"),
            ),
          )
          .orderBy(desc(memoryItemVersions.createdAt)),
        db
          .select({
            suggestionId: suggestions.id,
            suggestionCompanyId: suggestions.companyId,
            suggestionCategory: suggestions.category,
            suggestionActionType: suggestions.actionType,
            suggestionActionPayload: suggestions.actionPayload,
            suggestionTitle: suggestions.title,
            suggestionEvidence: suggestions.evidence,
            suggestionStatus: suggestions.status,
            suggestionExpiresAt: suggestions.expiresAt,
            suggestionRelatedMemoryItemId: suggestions.relatedMemoryItemId,
            suggestionCreatedAt: suggestions.createdAt,
            suggestionUpdatedAt: suggestions.updatedAt,
            itemId: memoryItems.id,
            itemCompanyId: memoryItems.companyId,
            itemTitle: memoryItems.title,
            itemContent: memoryItems.content,
            itemCategory: memoryItems.category,
            itemSource: memoryItems.source,
            itemStatus: memoryItems.status,
            itemTags: memoryItems.tags,
            itemDepartmentId: memoryItems.departmentId,
            itemProjectId: memoryItems.projectId,
            itemCreatedBy: memoryItems.createdBy,
            itemLayer: memoryItems.layer,
            itemPriority: memoryItems.priority,
            itemVisibility: memoryItems.visibility,
            itemExpiresAt: memoryItems.expiresAt,
            itemGoalId: memoryItems.goalId,
            itemTaskId: memoryItems.taskId,
            itemSourceArtifactId: memoryItems.sourceArtifactId,
            itemSourceContext: memoryItems.sourceContext,
            itemAccessedAt: memoryItems.accessedAt,
            itemCurrentVersionId: memoryItems.currentVersionId,
            itemCreatedAt: memoryItems.createdAt,
            itemUpdatedAt: memoryItems.updatedAt,
          })
          .from(suggestions)
          .innerJoin(memoryItems, eq(suggestions.relatedMemoryItemId, memoryItems.id))
          .where(
            and(
              eq(suggestions.companyId, companyId),
              eq(suggestions.category, "agent_proposal"),
              eq(suggestions.actionType, "archive_memory"),
              eq(suggestions.status, "pending"),
            ),
          )
          .orderBy(desc(suggestions.createdAt)),
      ]);

      const versions = versionRows.map((row) => ({
        itemId: row.itemId,
        itemTitle: row.itemTitle,
        itemLayer: row.itemLayer,
        itemDepartmentId: row.itemDepartmentId,
        itemCategory: row.itemCategory,
        itemSource: row.itemSource,
        currentContent: row.currentContent,
        currentVersionId: row.currentVersionId,
        version: {
          id: row.versionId,
          memoryItemId: row.memoryItemId,
          versionNumber: row.versionNumber,
          content: row.versionContent,
          status: row.versionStatus,
          createdBy: row.versionCreatedBy,
          createdAt: row.versionCreatedAt,
        },
      }));

      const archives = archiveRows.map((row) => ({
        item: {
          id: row.itemId,
          companyId: row.itemCompanyId,
          title: row.itemTitle,
          content: row.itemContent,
          category: row.itemCategory,
          source: row.itemSource,
          status: row.itemStatus,
          tags: row.itemTags,
          departmentId: row.itemDepartmentId,
          projectId: row.itemProjectId,
          createdBy: row.itemCreatedBy,
          layer: row.itemLayer,
          priority: row.itemPriority,
          visibility: row.itemVisibility,
          expiresAt: row.itemExpiresAt,
          goalId: row.itemGoalId,
          taskId: row.itemTaskId,
          sourceArtifactId: row.itemSourceArtifactId,
          sourceContext: row.itemSourceContext,
          accessedAt: row.itemAccessedAt,
          currentVersionId: row.itemCurrentVersionId,
          createdAt: row.itemCreatedAt,
          updatedAt: row.itemUpdatedAt,
        },
        suggestion: {
          id: row.suggestionId,
          companyId: row.suggestionCompanyId,
          category: row.suggestionCategory,
          actionType: row.suggestionActionType,
          actionPayload: row.suggestionActionPayload,
          title: row.suggestionTitle,
          evidence: row.suggestionEvidence,
          status: row.suggestionStatus,
          expiresAt: row.suggestionExpiresAt,
          relatedMemoryItemId: row.suggestionRelatedMemoryItemId,
          createdAt: row.suggestionCreatedAt,
          updatedAt: row.suggestionUpdatedAt,
        },
      }));

      return {
        items,
        versions,
        archives,
        totalCount: items.length + versions.length + archives.length,
      };
    },

    touchAccessedAt: (companyId: string, id: string) =>
      db
        .update(memoryItems)
        .set({ accessedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(memoryItems.id, id), eq(memoryItems.companyId, companyId)))
        .returning(memoryItemsSelection())
        .then((rows) => rows[0] ?? null),

    /**
     * List memory_retrievals rows for an issue (across all
     * its heartbeat runs), joined to memory_items so the UI can render the
     * item title/layer/category alongside the per-call audit metadata.
     *
     * Powers the workspace right-panel MemorySection. Sorted newest-first.
     * Item join is a LEFT JOIN — retrievals whose memory_items have been
     * deleted still surface (with null fields) so the audit trail
     * accurately reflects what happened, not what currently exists.
     *
     * Limit defaults to 100; UI typically renders ~30. Cap at 500 to
     * prevent runaway responses if a noisy run audits hundreds of items.
     */
    listRetrievalsForIssue: async (
      companyId: string,
      issueId: string,
      options: { limit?: number } = {},
    ) => {
      const limit = Math.min(options.limit ?? 100, 500);

      return await db
        .select({
          id: memoryRetrievals.id,
          companyId: memoryRetrievals.companyId,
          agentId: memoryRetrievals.agentId,
          runId: memoryRetrievals.runId,
          taskId: memoryRetrievals.taskId,
          triggeredBy: memoryRetrievals.triggeredBy,
          query: memoryRetrievals.query,
          itemId: memoryRetrievals.itemId,
          similarityScore: memoryRetrievals.similarityScore,
          rank: memoryRetrievals.rank,
          shownToAgent: memoryRetrievals.shownToAgent,
          createdAt: memoryRetrievals.createdAt,
          // joined item fields (LEFT JOIN — null when item deleted)
          itemTitle: memoryItems.title,
          itemContent: memoryItems.content,
          itemCategory: memoryItems.category,
          itemLayer: memoryItems.layer,
          itemStatus: memoryItems.status,
          itemPinnedToSkill: memoryItems.pinnedToSkill,
        })
        .from(memoryRetrievals)
        .leftJoin(memoryItems, eq(memoryRetrievals.itemId, memoryItems.id))
        .where(
          and(
            eq(memoryRetrievals.companyId, companyId),
            eq(memoryRetrievals.taskId, issueId),
          ),
        )
        .orderBy(desc(memoryRetrievals.createdAt))
        .limit(limit);
    },

    /**
     * Phase 7 — Memory cockpit card.
     *
     * Returns retrievals for a Commander conversation, newest first.
     * Items deleted after the retrieval surface with null fields (audit-preserve).
     * Limit defaults to 100; hard-cap 500.
     */
    listRetrievalsForConversation: async (
      companyId: string,
      conversationId: string,
      options: { limit?: number } = {},
    ) => {
      const limit = Math.min(options.limit ?? 100, 500);

      return await db
        .select({
          id: memoryRetrievals.id,
          companyId: memoryRetrievals.companyId,
          agentId: memoryRetrievals.agentId,
          runId: memoryRetrievals.runId,
          taskId: memoryRetrievals.taskId,
          conversationId: memoryRetrievals.conversationId,
          triggeredBy: memoryRetrievals.triggeredBy,
          query: memoryRetrievals.query,
          itemId: memoryRetrievals.itemId,
          similarityScore: memoryRetrievals.similarityScore,
          rank: memoryRetrievals.rank,
          shownToAgent: memoryRetrievals.shownToAgent,
          createdAt: memoryRetrievals.createdAt,
          // joined item fields (LEFT JOIN — null when item deleted)
          itemTitle: memoryItems.title,
          itemContent: memoryItems.content,
          itemCategory: memoryItems.category,
          itemLayer: memoryItems.layer,
          itemStatus: memoryItems.status,
          itemPinnedToSkill: memoryItems.pinnedToSkill,
        })
        .from(memoryRetrievals)
        .leftJoin(memoryItems, eq(memoryRetrievals.itemId, memoryItems.id))
        .where(
          and(
            eq(memoryRetrievals.companyId, companyId),
            eq(memoryRetrievals.conversationId, conversationId),
          ),
        )
        .orderBy(desc(memoryRetrievals.createdAt))
        .limit(limit);
    },

    moveItem: async (id: string, companyId: string, folderPath: string) => {
      const caps = getDbCapabilities();
      const path = normalizeMemoryFolderPath(folderPath);
      const [row] = await db
        .update(memoryItems)
        .set({ folderPath: path, updatedAt: new Date() })
        .where(and(eq(memoryItems.id, id), eq(memoryItems.companyId, companyId)))
        .returning(memoryItemsSelection(caps.hasVectorSupport));
      if (row) {
        publishLiveEvent({
          type: "memory.item.moved",
          companyId,
          payload: { item: row },
        });
      }
      return row ?? null;
    },

    setPinnedToTop: async (id: string, companyId: string, pinned: boolean) => {
      const caps = getDbCapabilities();
      const [row] = await db
        .update(memoryItems)
        .set({ founderPinnedToTop: pinned, updatedAt: new Date() })
        .where(and(eq(memoryItems.id, id), eq(memoryItems.companyId, companyId)))
        .returning(memoryItemsSelection(caps.hasVectorSupport));
      if (row) {
        publishLiveEvent({
          type: "memory.item.updated",
          companyId,
          payload: { item: row },
        });
      }
      return row ?? null;
    },

    changeLayer: async (
      id: string,
      companyId: string,
      input: {
        newLayer: "identity" | "domain" | "active_context" | "working";
        departmentId?: string | null;
        goalId?: string | null;
        taskId?: string | null;
        expiresAt?: Date | null;
        // Phase 6.2c follow-up: actor attribution for the audit row.
        // Falls back to "system" when not provided (e.g., internal callers).
        actorId?: string | null;
      },
    ) => {
      const VALID_LAYERS = ["identity", "domain", "active_context", "working"];
      if (!VALID_LAYERS.includes(input.newLayer)) {
        throw new Error(`Invalid layer: ${input.newLayer}`);
      }

      // Step 1: Fetch current item state.
      const caps = getDbCapabilities();
      const [target] = await db
        .select(memoryItemsSelection(caps.hasVectorSupport))
        .from(memoryItems)
        .where(and(eq(memoryItems.id, id), eq(memoryItems.companyId, companyId)));

      if (!target) return null;

      const fromLayer = target.layer ?? "domain"; // default to domain if null
      const toLayer = input.newLayer;

      // Step 2: Validate transition requirements.
      if (toLayer === "active_context" && !input.goalId) {
        throw new Error("goalId required for active_context layer");
      }
      if (toLayer === "working" && !input.taskId) {
        throw new Error("taskId required for working layer");
      }

      // Step 3: Compute field mutations per transition rules:
      //   - any → working      : set taskId; clear goalId+expiresAt
      //   - any → active_context: set goalId+expiresAt; clear taskId
      //   - any → domain       : clear taskId+goalId+expiresAt; departmentId from input or keep current
      //   - any → identity     : clear taskId+goalId+expiresAt+departmentId
      //   - folderPath always cleared (item moves layers; folder-tree position resets)
      const patch: Record<string, unknown> = {
        layer: toLayer,
        folderPath: "",
        updatedAt: new Date(),
      };

      if (toLayer === "working") {
        patch.taskId = input.taskId;
        patch.goalId = null;
        patch.expiresAt = null;
        patch.departmentId = input.departmentId ?? (target as Record<string, unknown>).departmentId;
      } else if (toLayer === "active_context") {
        patch.goalId = input.goalId;
        patch.expiresAt = input.expiresAt ?? null;
        patch.taskId = null;
        patch.departmentId = input.departmentId ?? (target as Record<string, unknown>).departmentId;
      } else if (toLayer === "domain") {
        patch.departmentId = input.departmentId ?? (target as Record<string, unknown>).departmentId;
        patch.taskId = null;
        patch.goalId = null;
        patch.expiresAt = null;
      } else if (toLayer === "identity") {
        patch.taskId = null;
        patch.goalId = null;
        patch.expiresAt = null;
        patch.departmentId = null;
      }

      // Step 4 + 5: Apply the update + write the audit row inside a single
      // transaction so the layer-change and its audit trail are atomic. If
      // either fails, neither is persisted. Per Phase 6.2c follow-up review.
      const changelog = `layer changed: ${fromLayer} → ${toLayer}`;
      const updated = await db.transaction(async (tx) => {
        // A-M6 — lock the PARENT memory_items row FOR UPDATE as the first
        // statement so version-number allocation is serialized. The tx already
        // wrapped the read+insert, but a bare max read at READ COMMITTED can
        // still race a concurrent suggestUpdate/saveDraft/changeLayer that
        // allocates the same max+1 → unique-index 23505. Locking the parent row
        // forces concurrent allocators to block until we commit.
        await tx.execute(
          sql`select id from memory_items where id = ${id} and company_id = ${companyId} for update`,
        );

        const [row] = await tx
          .update(memoryItems)
          .set(patch)
          .where(and(eq(memoryItems.id, id), eq(memoryItems.companyId, companyId)))
          .returning(memoryItemsSelection(caps.hasVectorSupport));

        // Look up the next version number inside the transaction so we don't
        // race a concurrent insert.
        const [latest] = await tx
          .select({ versionNumber: memoryItemVersions.versionNumber })
          .from(memoryItemVersions)
          .where(eq(memoryItemVersions.memoryItemId, id))
          .orderBy(desc(memoryItemVersions.versionNumber))
          .limit(1);
        const nextVersion = (latest?.versionNumber ?? 0) + 1;

        await tx.insert(memoryItemVersions).values({
          memoryItemId: id,
          versionNumber: nextVersion,
          content: changelog,
          status: "approved",
          // Plumb the actor ID through so the audit trail attributes the
          // change to the operator, not a generic "system".
          createdBy: input.actorId ?? "system",
        });

        return row;
      });

      // Step 6: Publish LiveEvent.
      publishLiveEvent({
        type: "memory.item.layer-changed",
        companyId,
        payload: { item: updated, fromLayer, toLayer },
      });

      // A layer change on a PENDING item can move it across the working ↔
      // non-working boundary, and the founder-gated pending count predicate
      // excludes layer='working' → the count (and thus the memory_review
      // signpost) shifts. changeLayer never mutates `status`, so the pre-image
      // `target.status` equals the post-image status. Recompute/close the Inbox
      // signpost only when the item was pending (best-effort; try/catch lives in
      // signpostMemoryReview). Mirrors the approve/update/reject/remove hooks.
      if (target.status === "pending") {
        await signpostMemoryReview(db, companyId);
      }

      return updated ?? null;
    },
  };
}
