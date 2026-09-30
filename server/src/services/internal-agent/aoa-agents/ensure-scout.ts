import type { Db } from "@armyofagents/db";
import { seedCrewAgent } from "./seed-crew-agent.js";

/**
 * Phase D batch 1 (T2) — Scout role seed.
 *
 * Scout is the research/investigation arm of the thread crew. The Adjutant
 * delegates Scout via agent.dispatch when a thread needs background — prior
 * decisions, related threads, or knowledge in memory. Scout is internal-only
 * for Phase 1 (no web browse); Phase 2 will add external research adapters.
 *
 * Triggered via:
 *   - mention   (@Scout in a thread entry)
 *   - agent.dispatch from Adjutant (mention-shaped wakeup)
 *
 * Decisions #15/#16/#52: Scout does NOT write memory directly. It can find
 * similar items via find_similar_memory_hnsw and post its synthesis to the
 * thread for the founder or Memory Keeper to act on.
 */

const SCOUT_INSTRUCTION = `You are Scout — research and investigation for threads.

Adjutant delegates research to you. When dispatched:
1. Read the thread context (entries + summary + related threads) provided in your wakeup payload.
2. Use internal-only sources to investigate (Phase 1 — no web browse):
   - find_similar_memory_hnsw to find related existing knowledge
   - query_threads to find adjacent threads in the company
   - get_thread_summary to read another thread's gist
   - search_discussions for keyword matches
3. Synthesize findings and post ONE summary entry to the thread (use post_entry).
4. If you found a meaningful precedent in another thread, create a thread.createLink with kind='link'.

Browse and external research are deferred to Phase 2. Stay focused on internal knowledge.`;

export const SCOUT_TOOL_ALLOWLIST: string[] = [
  "find_similar_memory_hnsw",
  "find_similar_threads",
  "query_threads",
  "get_thread_summary",
  "search_discussions",
  "thread.listEntries",
  "thread.createLink",
  "post_entry",
  "use_skill",
  // Spec B Task 6 — crew task tools. When Scout is dispatched onto a task it
  // reads its assignment (get_task), reports progress (post_task_comment),
  // hands back findings as a deliverable (attach_task_artifact), and advances
  // the task (set_task_status). get_task=query; the other three=coordination —
  // neither category grants system_actions, so these add no capability.
  "get_task",
  "post_task_comment",
  "attach_task_artifact",
  "set_task_status",
  "ask_human",
];

/**
 * Idempotently seed the Scout role for a company.
 * Call this from the company bootstrap path alongside the other crew ensures.
 */
export async function ensureScout(db: Db, companyId: string): Promise<void> {
  await seedCrewAgent(db, companyId, {
    name: "Scout",
    role: "general",
    instruction: SCOUT_INSTRUCTION,
    toolAllowlist: SCOUT_TOOL_ALLOWLIST,
    triggers: [
      {
        // Mention-driven: @Scout in a thread, or Adjutant's agent.dispatch
        // arrives as a mention-shaped wakeup.
        kind: "mention",
        config: { role: "scout" },
      },
    ],
    instructionBundleRole: "scout",
  });
}
