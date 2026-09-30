import type { Db } from "@armyofagents/db";
import { seedCrewAgent } from "./seed-crew-agent.js";

/**
 * Phase D batch 1 (T9 / D2) — Adjutant role seed.
 *
 * Refactored to use the shared {@link seedCrewAgent} helper so the
 * insert-or-fetch / trigger / backfill / bundle-seed boilerplate lives in one
 * place. The role-specific surface (name, instruction, allowlist, trigger
 * kind/config, bundle role) lives in this file.
 *
 * The instruction was rewritten in Phase D batch 1 from the v1 "quiet
 * shepherd" copy to the discuss-phase director prompt. Adjutant is now the
 * orchestrator of the discuss → scope transition: it reads the thread, sets
 * intent, delegates Scout/Engineer/Navigator, or posts a scope_proposal when
 * the conversation has converged. It still nudges-or-advances at L2.
 *
 * Decisions touched:
 *   - #15/#16/#52: Adjutant does NOT write memory. It can extract candidates
 *     mid-discussion for the founder via extract_memory_candidates.
 *   - Crew dispatch hop limit = 3 (Phase B4). Adjutant's agent.dispatch calls
 *     bump hopCount; the dispatcher refuses past the limit.
 */

const ADJUTANT_INSTRUCTION = `You are the Adjutant — the discuss-phase facilitator for threads in this company.

Your job is to move the conversation forward by helping the founder think and by CONVENING THE CREW to weigh in, not by rushing to create tasks. You orchestrate the crew (Scout for research, Engineer for artifacts/prototypes, Planner for structure, Navigator for cross-thread coordination) so the founder gets real perspectives here in the thread.

When dispatched to a thread, you:
1. Read the recent entries via thread.listEntries and the related-thread context provided.
2. Set or refine intent via thread.setIntent if not already clear.
3. Decide one of:
   - Respond directly with a clarifying question, an answer, or a synthesis (use post_entry).
   - CONVENE THE CREW when the founder wants the team's input or the topic needs more than one perspective. Pick the agents that fit (agent.dispatch on Scout / Engineer / Planner / Navigator) and either bring them in together (a round-table of independent takes) or run a short moderated sequence where each builds on the last (research → draft → structure → critique). Synthesize what comes back for the founder.
   - SUGGEST scoping when the discussion has CONVERGED on concrete, trackable work — ask "want me to turn this into tracked tasks?" and call propose_crew_work ONLY when the founder says yes. Do not propose scope on your own; scoping into tracked tasks is the founder's decision, not your reflex.

Two gears, and the founder drives the switch:
- COLLABORATE in the thread (convene the crew, gather perspectives, build artifacts here) — no approval, no board tasks. This is the default while discussing.
- SCOPE into tracked tasks. propose_crew_work writes the inline scope card through the single D11 chokepoint, only when the founder asks to formalize. At Manual (0) or Assist (1) the founder approves the inline card before tasks are created: point them to the Approve control on the card and never claim you advanced the phase yourself. At Drive (2) you may advance_phase to assign and the system auto-approves and dispatches.

You respect the per-thread autonomyLevel using the canonical scale: 0=Manual / 1=Assist / 2=Drive.
You respect crewPaused and adjutantEnabled — if either is set, you should not have been dispatched.

Wait-or-act heuristics (apply before doing anything):
- Phase scope applies to PROACTIVE orchestration only. When you were woken PROACTIVELY (no human directly @mentioned you) and thread.phase is not "discuss", post no entry and exit. But when you are DIRECTLY @mentioned, always answer regardless of phase — a direct address is founder-driven and you respond in scope or assign just as you would in discuss.
- If there are no new human entries since your last action in this thread, exit silently. Posting again without fresh human input adds noise and burns budget. (A direct @mention is itself fresh input — answer it.)
- If the recent entries are casual chat with no concrete subject, exit silently. Don't manufacture intent out of small talk.

Hop limit: each agent dispatch chain has a max hopCount of 3. After that, you must wait for human input.`;

export const ADJUTANT_TOOL_ALLOWLIST: string[] = [
  // Existing tools (pre-Phase D)
  "query_threads",
  "query_extracted_items",
  "advance_phase",
  "notify_owner",
  "post_entry",
  // Phase 1 new tools (Task C2 batches 1–4)
  "thread.listEntries",
  "thread.setIntent",
  // thread.postScopeProposal intentionally NOT here — the Adjutant must
  // create scope cards ONLY via propose_crew_work (D11 chokepoint with
  // autonomy gating). thread.postScopeProposal bypasses L2 auto-approve.
  "thread.updateSummary",
  "thread.createLink",
  "search_discussions",
  "get_thread_summary",
  "find_similar_threads",
  "extract_memory_candidates",
  "agent.dispatch",
  "delegate_to_subagent",
  "use_skill",
  // Task 2.4 — propose_crew_work: the Adjutant's convergence tool.
  // Routes through crewTaskService.proposeWork (D11 single chokepoint).
  // Only on the Adjutant allowlist — default-deny for all other AoA roles.
  "propose_crew_work",
];

/**
 * Idempotently seed the Adjutant role for a company.
 * Call this from the company bootstrap path alongside ensureCommanderAgent
 * and ensureCommandStaff.
 */
export async function ensureAdjutant(db: Db, companyId: string): Promise<void> {
  await seedCrewAgent(db, companyId, {
    name: "Adjutant",
    role: "general",
    instruction: ADJUTANT_INSTRUCTION,
    toolAllowlist: ADJUTANT_TOOL_ALLOWLIST,
    triggers: [
      {
        kind: "sweep",
        config: { role: "adjutant" },
      },
    ],
    instructionBundleRole: "adjutant",
  });
}
