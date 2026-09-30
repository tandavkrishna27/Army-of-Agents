import { and, eq, ne, gt, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { agents, aoaAgentTriggers, discussions, agentWakeupRequests } from "@armyofagents/db";

/**
 * T1.4 part 1 — Periodic sweep driver for the Memory Keeper role.
 *
 * WHY THIS EXISTS:
 * Memory Keeper was originally seeded with `kind='outbox'`, but the
 * dispatcher's Phase-2 outbox drain (see listEnabledOutboxAgents + the
 * Phase-2 loop in dispatcher.ts) is hardcoded to the extraction agent. Net
 * effect pre-T1.4: Memory Keeper's trigger row was dead code (F4 in the
 * v1-completion plan) — it never ran for any company. This driver replaces
 * that with a periodic sweep so MK runs at least once every 4hr per active
 * thread. (T1.4 part 2 layers an event-driven entry.added trigger on top
 * for faster reaction; the sweep is the safety floor.)
 *
 * SHAPE — mirrors runAdjutantSweep with two important differences:
 *  - Filters by `config.role='memory_keeper'`. Adjutant's seed also uses
 *    `kind='sweep'` so without the role filter both drivers would
 *    cross-fire on each other's triggers. The Adjutant driver was
 *    simultaneously updated in this task to filter by role='adjutant'.
 *  - Per-thread debounce: skips threads with an MK wakeup queued in the
 *    last 4hr. Prevents resweep storms on tick boundaries and keeps the
 *    LLM-spend cost predictable.
 *
 * WAKEUP PAYLOAD: { threadId, role: 'memory_keeper' }
 * SOURCE: 'sweep.memory_keeper' (T1.2 codex F6 — dispatcher passes this
 *   through to the runner so the trigger-context block in the LLM prompt
 *   says "Trigger source: sweep.memory_keeper").
 *
 * CADENCE: Called by index.ts setInterval every 4hr (DEBOUNCE_MS below
 *   matches that cadence so the debounce window aligns with sweep cadence).
 */

/** 4hr in ms. The sweep cadence + per-thread debounce window use the same
 *  value — sweeping every 4hr with a 4hr debounce means each active thread
 *  gets exactly one wakeup per cycle (no resweep storms on tick edges). */
export const MK_SWEEP_DEBOUNCE_MS = 4 * 60 * 60 * 1000;

export async function runMemoryKeeperSweep(db: Db): Promise<void> {
  // ── Phase 1: pull all enabled kind='sweep' triggers, then JS-filter by
  //    config.role='memory_keeper'.
  //
  // Why JS filter (not SQL): the test mocks would need to grow a
  // payload->>'role' awareness to do the filter in SQL; doing it in JS
  // keeps the mock setup simple and the volume is trivial (a few sweep
  // triggers per company at most).
  const allSweepTriggers = await db
    .select({
      agentId: aoaAgentTriggers.agentId,
      companyId: aoaAgentTriggers.companyId,
      config: aoaAgentTriggers.config,
    })
    .from(aoaAgentTriggers)
    .innerJoin(agents, eq(agents.id, aoaAgentTriggers.agentId))
    .where(
      and(
        eq(aoaAgentTriggers.kind, "sweep"),
        eq(aoaAgentTriggers.enabled, true),
        ne(agents.status, "paused"),
        ne(agents.status, "terminated"),
      ),
    );

  const mkTriggers = allSweepTriggers.filter((t: { config: Record<string, unknown> | null }) => {
    // Defense: if config is missing or doesn't pin a role, do NOT pick it up.
    // Pre-T1.4 some seeds wrote bare config={} — those rows must be backfilled
    // (handled in ensure-command-staff.ts) before this driver fires for them.
    const role = (t.config as Record<string, unknown> | null)?.role;
    return role === "memory_keeper";
  });

  if (mkTriggers.length === 0) return;

  const debounceCutoff = new Date(Date.now() - MK_SWEEP_DEBOUNCE_MS);

  for (const trigger of mkTriggers) {
    // ── Phase 2: active threads for this company (not done, crew not paused). ─
    const activeThreads = await db
      .select({ id: discussions.id })
      .from(discussions)
      .where(
        and(
          eq(discussions.companyId, trigger.companyId),
          ne(discussions.phase, "done"),
          eq(discussions.crewPaused, false),
        ),
      );

    if (activeThreads.length === 0) continue;

    // ── Phase 3: per-thread debounce — fetch threadIds with a recent MK
    //    wakeup queued (or processing/finished). The 4hr window is matched to
    //    the sweep cadence so each thread gets at most one MK wakeup per
    //    cycle. Projecting via SQL `->>'threadId'` keeps the result rows
    //    small (just the JSON path value, no full payload payload bloat).
    const debouncedRows: Array<{ threadId: string | null }> = await db
      .select({
        threadId: sql<string | null>`${agentWakeupRequests.payload}->>'threadId'`,
      })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, trigger.agentId),
          gt(agentWakeupRequests.createdAt, debounceCutoff),
        ),
      );

    const debouncedSet = new Set(
      debouncedRows
        .map((r: { threadId: string | null }) => r.threadId)
        .filter((id: string | null): id is string => typeof id === "string"),
    );

    for (const thread of activeThreads) {
      if (debouncedSet.has(thread.id)) continue; // recent wakeup → skip

      await db.insert(agentWakeupRequests).values({
        companyId: trigger.companyId,
        agentId: trigger.agentId,
        source: "sweep.memory_keeper",
        reason: "memory_keeper_sweep",
        payload: { threadId: thread.id, role: "memory_keeper" },
        status: "queued",
      });
    }
  }
}
