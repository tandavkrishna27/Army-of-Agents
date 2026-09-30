import { and, eq, ne } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { agents, agentWakeupRequests } from "@armyofagents/db";
import { logger } from "../../../middleware/logger.js";

const log = logger.child({ svc: "memory-extraction-on-close" });

/**
 * P3-T1: Memory-extraction-on-close.
 *
 * When a thread is closed/archived, enqueue a Memory Keeper invocation so the
 * thread's durable knowledge is captured as memory proposals BEFORE the thread
 * goes dormant. The Memory Keeper reads the thread and proposes memory items
 * with `status: pending` — founder-gated per the memory rules (Decisions
 * #15/#16/#52); crew agents never write memory directly. This is the durable
 * cross-thread channel: a finished thread's decisions/insights become reusable
 * company knowledge instead of evaporating.
 *
 * Mechanism: reuses the existing wakeup → dispatcher → Memory Keeper pipeline
 * (the same wakeup shape as `runMemoryKeeperSweep`), but triggered by the
 * archive event instead of the 4-hour periodic sweep. The dispatcher claims the
 * wakeup and runs the MK via `runAoaAgent`; the MK proposes items via its tools.
 *
 * Idempotent + best-effort:
 *   - `dedupKey = mk-close:<threadId>` + `.onConflictDoNothing()` paired with the
 *     partial unique index on `agent_wakeup_requests(dedup_key) WHERE status='queued'`
 *     means a re-archive (PATCH status=archived on an already-archived thread)
 *     does not double-enqueue while one is still queued.
 *   - The caller wraps this in try/catch so a failure NEVER blocks the archive.
 */
export async function enqueueMemoryExtractionOnClose(
  db: Db,
  companyId: string,
  threadId: string,
): Promise<void> {
  // Resolve the company's Memory Keeper. Exactly one per company by construction
  // (agents_aoa_name_per_company_idx). Skip terminated agents — a deleted MK
  // can't extract.
  const [mk] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        eq(agents.kind, "aoa"),
        eq(agents.name, "Memory Keeper"),
        ne(agents.status, "terminated"),
      ),
    )
    .limit(1);

  if (!mk) {
    log.debug({ companyId, threadId }, "memory-on-close: no Memory Keeper agent — skipping");
    return;
  }

  await db
    .insert(agentWakeupRequests)
    .values({
      companyId,
      agentId: mk.id,
      source: "thread.close",
      reason: "memory_extraction_on_close",
      payload: { threadId, role: "memory_keeper" },
      dedupKey: `mk-close:${threadId}`,
      status: "queued",
    })
    .onConflictDoNothing();

  log.debug(
    { companyId, threadId, agentId: mk.id },
    "memory-on-close: enqueued Memory Keeper extraction",
  );
}
