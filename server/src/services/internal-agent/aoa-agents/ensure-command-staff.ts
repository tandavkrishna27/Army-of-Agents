import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { agents, aoaAgentTriggers } from "@armyofagents/db";
import { seedCrewAgent, type CrewAgentTriggerSpec } from "./seed-crew-agent.js";

/**
 * Plan 3 Task 2 — Command Staff roles (Navigator, Planner, Memory Keeper).
 * Refactored in Phase D batch 1 (T9) to delegate idempotent boilerplate
 * to {@link seedCrewAgent}; this file owns only the per-role surface (name,
 * trigger, instruction, tool allowlist, bundle key).
 *
 * Phase D batch 1 renamed Router → Navigator. The role key in the registry is
 * still spelled `router` (kept as an alias — see {@link roleToolAllowlist}) so
 * staging fixtures + autonomy gate tests don't break, but the display name
 * (agents.name) becomes "Navigator" and the trigger config.role is `navigator`.
 * Pre-existing rows with name='Router' are migrated to 'Navigator' before
 * seedCrewAgent runs so the unique index doesn't conflict.
 *
 * Decisions #15/#16/#52: Memory Keeper can only PROPOSE memory (status='pending').
 * Agentic roles (router/navigator, planner) require autonomyLevel ≥ 2
 * to fire (enforced in autonomy.ts + dispatcher.ts). Core roles (memory_keeper,
 * curator) are always active (min autonomy = 0). (Phase 1: autonomous Scribe
 * is gated off; the legacy scribe role no longer participates in routing.)
 *
 * Task 2.7 (Crew Work-as-Tasks plan): Dispatcher retired. Its create_task path
 * bypassed the crew-task-service chokepoint's provenance stamp + autonomy gate.
 * The crew-task-service is now the sole creator of crew work. Pre-existing
 * Dispatcher agent rows in the DB become dormant (no trigger, not re-seeded).
 * Commander retains ad-hoc create_task for non-thread flows (COMMANDER_TOOL_ALLOWLIST).
 */

export const COMMAND_STAFF_ROLES = [
  // Phase D rename: display name is now "Navigator". The `key` stays `router`
  // for the registry's sake (autonomy gate + trigger config + tool registry
  // tests all key on it) and so that mention parsing via @Router/@Navigator
  // can both land on the same agent without a fork in the lookup path.
  { key: "router", name: "Navigator", trigger: "mention" },
  { key: "planner", name: "Planner", trigger: "phase-advance" },
  // Note: "dispatcher" entry removed (Task 2.7). crew-task-service is the
  // sole creator of crew work. Pre-existing Dispatcher rows become dormant.
  // T1.4 part 1 (v1-completion plan F4): Memory Keeper was kind='outbox'
  // but the dispatcher's outbox drain is hardcoded to the extraction agent —
  // MK never ran. Switched to 'sweep' so the periodic memory-keeper sweep
  // driver (sweep-memory-keeper.ts) wakes MK every 4hr per active thread.
  // Existing rows are migrated below in ensureRole (kind='outbox' → 'sweep').
  // T1.4 part 2 will additionally seed an 'event' trigger for entry.added.
  { key: "memory_keeper", name: "Memory Keeper", trigger: "sweep" },
] as const;

export type CommandStaffRoleKey = (typeof COMMAND_STAFF_ROLES)[number]["key"];

/** Per-role tool allowlist. Decisions #15/#16/#52: no direct memory writes for crew. */
export function roleToolAllowlist(
  role: CommandStaffRoleKey | "navigator",
): string[] {
  switch (role) {
    case "router":
    // Phase D batch 1 alias: 'navigator' is the new canonical key. The old
    // 'router' literal still works because legacy callers and staging DBs
    // pass it. Both fall through to the same allowlist.
    // eslint-disable-next-line no-fallthrough
    case "navigator":
      // C2 batch 1: Router/Navigator needs find_similar_threads to suggest a
      // sibling thread instead of routing to a department when the topic has
      // been discussed before. get_thread_summary + thread.listEntries help
      // it read the topic of an existing thread without polluting the thread.
      // C2 batch 2: attach_to_thread lets Navigator promote an inbox item to
      // an existing thread when a confident match is found, and spin_off_thread
      // lets it create a new thread for orphaned material that doesn't belong
      // in any current discussion.
      return [
        "search_discussions",
        "query_departments",
        "find_similar_threads",
        "get_thread_summary",
        "thread.listEntries",
        "thread.createLink",
        "attach_to_thread",
        "spin_off_thread",
        "list_thread_cards",           // NEW — fetch candidate routing cards (T6)
        "promote_inbox_to_thread",     // NEW — create new thread from inbox item (C1/T7)
        "defer_inbox_to_human",        // NEW — finalize an UNSURE item (Codex P1 #2)
      ];
    case "planner":
      // C2 batch 1: Planner owns scope proposals + setting intent on a thread
      // when escalating from discuss → scope. Needs listEntries to read the
      // thread context before proposing.
      // Phase D batch 1: Planner now writes a plan as a document-type
      // artifact and references prior scope_proposals via query_extracted_items.
      return [
        "search_discussions",
        "query_tasks",
        "query_dependency_chain",
        "query_extracted_items",
        "thread.listEntries",
        "get_thread_summary",
        "thread.setIntent",
        "thread.postScopeProposal",
        "thread.updateSummary",
        // Crew-collab: Planner must be able to weigh in conversationally when
        // convened into a discussion (not only produce a plan artifact). Without
        // post_entry it ran on an @mention but could call no tool and stayed
        // silent. (Task execution still produces deliverables via the issueId path.)
        "post_entry",
        "create_artifact",
        "create_artifact_version",
        "query_artifacts",
        // Spec B Task 6 — crew task tools. Planner is an executor role a task
        // can be dispatched to: read it (get_task), comment progress
        // (post_task_comment), hand back the plan deliverable
        // (attach_task_artifact), and advance it (set_task_status). get_task=query;
        // the rest=coordination — neither grants system_actions (Planner already
        // has it via create_artifact), so these add no new capability. Task
        // CREATION stays behind the Adjutant chokepoint (no create_task here).
        "get_task",
        "post_task_comment",
        "attach_task_artifact",
        "set_task_status",
        "ask_human",
      ];
    case "memory_keeper":
      // C2 batch 1: Memory Keeper benefits from cross-thread retrieval to
      // surface duplicate or related memory patterns across threads.
      // C2 batch 3: full memory toolkit — extraction wrappers (decisions,
      // insights, references, all candidates), the HNSW similarity tool, the
      // thread-aware proposer (inherits visibility/scope from source thread),
      // and the staleness sweeper.
      return [
        "suggest_memory",
        "find_similar_memory",
        "detect_conflicts",
        "find_similar_threads",
        "thread.listEntries",
        // C2 batch 3
        "extract_memory_candidates",
        "extract_decisions",
        "extract_insights",
        "extract_references",
        "find_similar_memory_hnsw",
        "propose_memory_from_thread",
        "archive_stale_memory",
      ];
  }
}

const ROLE_INSTRUCTIONS: Record<CommandStaffRoleKey, string> = {
  router:
    "You are the Navigator (formerly Router). Cross-thread routing + spin-off. " +
    "When invoked via @Navigator or @Router or via mention routing, identify " +
    "whether the topic belongs in (a) an existing thread (use attach_to_thread " +
    "after find_similar_threads / get_thread_summary), (b) a new thread (use " +
    "spin_off_thread), or (c) a department (use query_departments + post_entry " +
    "with a routing recommendation). Use thread.createLink (kind='link') when " +
    "you find a meaningful precedent between threads. Do not create tasks or " +
    "write memory." +
    // Task 1.7 — inbox-routing standing persona augmentation.
    " When woken with trigger source `inbox.routing_ambiguous`, you are routing a single inbound item: use its candidate threads to choose attach (`attach_to_thread`), branch (`spin_off_thread`), or a recommendation, for that item.",
  planner:
    "You are the Planner. When a thread phase advances, review pending extracted " +
    "items using query_extracted_items, query_tasks, and query_dependency_chain. " +
    "Identify dependency gaps, sequencing issues, and missing steps in the work " +
    "pipeline. Plan-as-artifact: produce a document-type artifact via " +
    "create_artifact (or create_artifact_version for iterations). Refer to existing scope_proposal entries via " +
    "query_extracted_items. Use thread.postScopeProposal and thread.setIntent to " +
    "frame the thread's direction. Do not create tasks directly — the Adjutant's propose_crew_work (D11 chokepoint) creates tasks. " +
    "" +
    "Plan artifact structure:\n" +
    "1. A 'Goal:' line restating the scope summary in one sentence.\n" +
    "2. A 'Tasks' section. Every proposed task from the scope_proposal MUST " +
    "appear — do not drop, merge, or invent tasks. For each task:\n" +
    "   - Task title as an H3 ('### N. <title>').\n" +
    "   - 'Depends on:' line listing prior task numbers ('Depends on: 1, 2') or " +
    "'Depends on: none' (lowercase 'none').\n" +
    "   - 'Acceptance criteria:' bullet list (copy what the scope provides; fill " +
    "gaps with sensible concrete defaults if any task lacks them).\n" +
    "   - 'Suggested assignee:' line picking ONE executor agent (Engineer, Scout, " +
    "Memory Keeper). Never suggest command-staff (Adjutant, Navigator) " +
    "— they coordinate the pipeline, not execute tasks.\n" +
    "3. A 'Sequencing' section: a one-paragraph summary of execution order " +
    "(which tasks block which, parallelisable batches).\n" +
    "" +
    "Heuristics: implementation tasks before their test tasks; research/scout " +
    "tasks first when downstream tasks need their findings.",
  memory_keeper:
    "You are the Memory Keeper. Review discussion entries and extracted items for " +
    "patterns worth capturing in memory. You can also invoke extraction directly " +
    "during sweep or on-phase-done via extract_memory_candidates / extract_decisions " +
    "/ extract_insights / extract_references; use find_similar_memory_hnsw (vector " +
    "search) to avoid duplicates, detect_conflicts to flag contradictions, " +
    "archive_stale_memory to retire unused items, and propose_memory_from_thread to " +
    "create proposals that inherit the source thread's visibility + scope. " +
    "CRITICAL: You may only PROPOSE memory (status='pending'). You never call " +
    "suggest_memory or update_memory directly — proposals are pending only. " +
    "Decisions #15/#16/#52.",
};

async function ensureRole(
  db: Db,
  companyId: string,
  role: (typeof COMMAND_STAFF_ROLES)[number],
): Promise<string> {
  // Phase D batch 1: Router → Navigator display-name rename. Run BEFORE
  // seedCrewAgent so the unique index (agents_aoa_name_per_company_idx)
  // sees a Navigator row (or a fresh insert), never both a Router and a
  // Navigator. Guarded on name='Router'; idempotent on subsequent calls.
  if (role.key === "router" && role.name === "Navigator") {
    await db
      .update(agents)
      .set({ name: "Navigator", updatedAt: new Date() })
      .where(
        and(
          eq(agents.companyId, companyId),
          eq(agents.kind, "aoa"),
          eq(agents.name, "Router"),
        ),
      );
  }

  const toolAllowlist = roleToolAllowlist(role.key);
  const instruction = ROLE_INSTRUCTIONS[role.key];
  // Trigger config.role uses the canonical post-rename role name: 'navigator'
  // for the role formerly known as 'router'. Sweeps / mention dispatchers read
  // this field to look up the action directive in aoa-trigger-prompt.ts.
  const triggerConfigRole = role.key === "router" ? "navigator" : role.key;

  const triggers: CrewAgentTriggerSpec[] = [
    { kind: role.trigger, config: { role: triggerConfigRole } },
  ];

  const agentId = await seedCrewAgent(db, companyId, {
    name: role.name,
    role: "general",
    instruction,
    toolAllowlist,
    triggers,
    instructionBundleRole: role.key,
  });

  // T1.4 part 1 — Memory Keeper trigger migration. Pre-T1.4 seeds wrote
  // kind='outbox' which was dead code (the dispatcher's outbox drain is
  // hardcoded to the extraction agent — MK never ran). Migrate any existing
  // outbox row for this agent to kind='sweep' with config.role='memory_keeper'
  // so the new sweep-memory-keeper.ts driver picks it up. Idempotent: the
  // WHERE clause limits the UPDATE to surviving outbox rows.
  if (role.key === "memory_keeper") {
    await db
      .update(aoaAgentTriggers)
      .set({
        kind: "sweep",
        config: { role: "memory_keeper" },
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(aoaAgentTriggers.agentId, agentId),
          eq(aoaAgentTriggers.kind, "outbox"),
        ),
      );
  }

  return agentId;
}

/**
 * Idempotently seed all four Command Staff roles for a company.
 * Call this from the company bootstrap path alongside ensureCommanderAgent.
 */
export async function ensureCommandStaff(db: Db, companyId: string): Promise<void> {
  for (const role of COMMAND_STAFF_ROLES) {
    await ensureRole(db, companyId, role);
  }
}

/**
 * Locked decisions #15/#16/#52: crew may only PROPOSE memory (status 'pending').
 * The founder (or team_lead for active_context) approves. Agents never write
 * identity/domain directly.
 *
 * Wire this into any code path that processes a crew memory write request.
 */
export function assertCrewMemoryWrite(item: { layer: string; status: string }): void {
  if (item.status !== "pending") {
    throw new Error(
      `Crew may only propose memory (status 'pending'); refused status '${item.status}' for layer '${item.layer}'`,
    );
  }
}
