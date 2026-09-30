import type { Db } from "@armyofagents/db";
import { memoryRetrievals } from "@armyofagents/db";
import type { MemoryRetrievalTrigger } from "@armyofagents/shared";
import { logger } from "../middleware/logger.js";

const log = logger.child({ service: "memory-retrieval-audit" });

/**
 * Per-item retrieval record.
 *
 *  - rank: 1-indexed position in the result list (lower = better).
 *  - similarityScore: cosine 1-distance from semantic search; null for
 *    keyword-only / temporal-only / skill-materialize hits.
 *  - shownToAgent: false when the item was returned by the search but
 *    filtered out by the RBAC gate (`filterMemoryForActor`) before reaching
 *    the agent (still useful audit signal for "queried but not delivered").
 */
export interface MemoryRetrievalItem {
  id: string;
  rank?: number;
  similarityScore?: number | null;
  shownToAgent?: boolean;
}

export interface RecordMemoryRetrievalsInput {
  companyId: string;
  agentId?: string | null;
  runId?: string | null;
  taskId?: string | null;
  /** Commander conversation that triggered this retrieval (null for agent/skill paths). */
  conversationId?: string | null;
  triggeredBy: MemoryRetrievalTrigger;
  query?: string | null;
  items: MemoryRetrievalItem[];
}

/**
 * Insert one row per retrieved item into `memory_retrievals`.
 *
 * Fire-and-forget by design — auditing should never block the main
 * retrieval path. Caller decides whether to await.
 *
 * Empty `items` array is a no-op (do not insert sentinel rows).
 */
export async function recordMemoryRetrievals(
  db: Db,
  input: RecordMemoryRetrievalsInput,
): Promise<void> {
  if (input.items.length === 0) return;

  try {
    await db.insert(memoryRetrievals).values(
      input.items.map((item) => ({
        companyId: input.companyId,
        agentId: input.agentId ?? null,
        runId: input.runId ?? null,
        taskId: input.taskId ?? null,
        conversationId: input.conversationId ?? null,
        triggeredBy: input.triggeredBy,
        query: input.query ?? null,
        itemId: item.id,
        // numeric(10,6) — pass as string per Drizzle convention
        similarityScore:
          item.similarityScore != null && Number.isFinite(item.similarityScore)
            ? String(item.similarityScore)
            : null,
        rank: item.rank ?? null,
        shownToAgent: item.shownToAgent ?? true,
      })),
    );
  } catch (err) {
    log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        companyId: input.companyId,
        triggeredBy: input.triggeredBy,
        itemCount: input.items.length,
      },
      "Failed to record memory retrievals (audit only — not user-visible)",
    );
  }
}
