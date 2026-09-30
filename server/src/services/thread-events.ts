/**
 * Thread event listener — 30s human-entries-only debounce for Adjutant wakeups
 * (Task B2, T12, Decisions D5 + D7).
 *
 * Subscribes to discussion-entry inserts from `discussions.addEntry`. When a
 * HUMAN posts (entry with `authorAgentId IS NULL` AND `inputType` not in
 * {agent, system, scope_proposal}), starts a 30-second trailing-edge debounce
 * timer scoped to the thread. Subsequent human entries within the window
 * reset the timer. When the timer fires, we insert ONE `agent_wakeup_requests`
 * row addressed to that company's Adjutant agent, using A4's `dedupKey`
 * partial unique index for cross-process dedup.
 *
 * Critical contracts:
 *   - Agent / system / scope_proposal entries do NOT trigger. The signal we
 *     care about is "humans are talking" — Adjutant should weigh in only after
 *     humans pause for 30s, otherwise crew agents would keep waking each
 *     other up in a thrash loop.
 *   - The dedup key shape is `${adjutantAgentId}:${threadId}:queued`. This
 *     matches A4's partial unique index `status = 'queued' AND dedup_key IS NOT NULL`,
 *     so the .onConflictDoNothing() pairs cleanly: while a queued wakeup
 *     exists for (adjutant, thread), no second one can be created. Once the
 *     row transitions to claimed/finished/failed the dedup key may legitimately
 *     recur.
 *   - Respects per-thread opt-outs: skips if `discussions.crewPaused = true`
 *     or `discussions.adjutantEnabled = false` (re-checked at fire time, not at
 *     onEntryCreated time, so toggling mid-debounce is honored).
 *   - hopCount caps cross-agent cascades. dispatchMention(@agent) increments
 *     payload.hopCount; once it would exceed MAX_HOP_COUNT (3), the dispatch
 *     is blocked instead. Wakeups triggered by *humans* always reset to 0.
 *
 * In-memory timers are acceptable-loss for Phase 1: a server restart drops
 * pending timers, but the next human entry retriggers the debounce. The
 * design doc §15 documents this — no DB persistence for the debounce in v1.
 */

import { eq, and } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  agents,
  agentWakeupRequests,
  discussions,
  internalAgentConfig,
} from "@armyofagents/db";
import { logger } from "../middleware/logger.js";
import { threadOrchestrationService } from "./thread-orchestration.js";
import { makeControllerAdjutantRunner } from "./internal-agent/aoa-agents/controller-adjutant-runner.js";

const log = logger.child({ service: "thread-events" });

/**
 * Max hop count before agent→agent cascade is blocked. Humans always reset to 0.
 *
 * Task 1.3 hop-cap reconciliation: this cap governs ONLY the LEGACY peer-wake
 * `dispatchMention` path (still used by non-controller threads and the
 * `agent.dispatch` MCP tool, which mirrors this literal). The unified
 * controller/participation path — what a controller-path @mention now flows
 * through (processMentions → requestParticipation, Tasks 1.2/2.1) — is governed
 * by `HOP_CAP=5` in `thread-orchestration.ts`, NOT this constant. Kept here
 * (not retired) because legacy threads + the dispatch tool still depend on it;
 * do NOT route controller-path mentions through `dispatchMention`/this cap.
 */
export const MAX_HOP_COUNT = 3;

/** Debounce window after the last human entry, in milliseconds. */
export const DEFAULT_DEBOUNCE_MS = 30_000;

/**
 * Shape of the entry-creation event consumed by the listener. Mirrors the
 * fields the listener actually reads from `discussion_entries` — keeping the
 * payload narrow makes the listener cheaper to call from `addEntry`'s hot
 * path and decouples it from full row shapes.
 */
export interface EntryCreatedEvent {
  id: string;
  discussionId: string;
  authorAgentId: string | null;
  inputType: string;
  createdBy: string;
  /**
   * Task 1.3 (de-dup the double-drive): true when `discussions.addEntry` resolved
   * that this entry's `rawContent` @mentions a kind='aoa' crew agent in the
   * company. When true, the mentioned agent answers DIRECTLY via the controller
   * participation path (`processMentions` → `requestParticipation`, Task 1.2), so
   * `onEntryCreated` must NOT also arm the proactive Adjutant debounce — otherwise
   * a single `@Scout …` drives twice (Scout directly + the ambient Adjutant). The
   * event payload itself carries no text, so the resolution happens upstream in
   * `addEntry` and is passed through here. Absent/false ⇒ ambient human chatter ⇒
   * arm the debounce as before (back-compat: older callers omit the field).
   */
  hasCrewMention?: boolean;
}

export interface DispatchMentionParams {
  agentId: string;
  threadId: string;
  entryId: string;
  /** hopCount from the incoming wakeup payload that triggered the mention dispatch. 0 = human-originated. */
  currentHopCount: number;
}

export interface DispatchMentionResult {
  /** New wakeup row id, or null when the dedup key collided OR the dispatch was blocked. */
  wakeupId: string | null;
  /** True when hopCount cap blocked the dispatch — distinguishes from "queued duplicate already exists". */
  blocked: boolean;
}

export interface ThreadEventListenerOpts {
  /** Override the 30s default. Tests pass `0` + manual flush; sweepers may go shorter for canary. */
  debounceMs?: number;
}

export interface ThreadEventListener {
  /** Called by `discussions.addEntry` after a successful entry insert. */
  onEntryCreated(event: EntryCreatedEvent): Promise<void>;
  /**
   * Programmatic dispatch path used by the @mention pipeline (currently in
   * `services/threads.ts`). Returns the inserted wakeup id, OR `null` when
   * deduped, OR `null + blocked: true` when hopCount cap was hit.
   */
  dispatchMention(params: DispatchMentionParams): Promise<DispatchMentionResult>;
  /** Clear pending timers — for test cleanup and graceful shutdown. */
  shutdown(): void;
}

/**
 * Recognize human-authored discussion entries.
 *
 * An entry is "human-authored" iff:
 *   - `authorAgentId === null` (no agent claimed authorship), AND
 *   - `inputType` is not one of the explicit non-human signals:
 *     - `agent`          — explicit agent-authored entry
 *     - `system`         — system / lifecycle-posted entry
 *     - `scope_proposal` — Adjutant-posted scope proposal (A3)
 *
 * Other inputTypes (paste, write, voice, mcp, transcript, document, routine,
 * webhook, integration, ...) are all treated as human signal sources. This
 * keeps the rule additive: unknown future human inputTypes default to
 * "yes, fire Adjutant" rather than silently breaking.
 */
export function isHumanEntry(event: EntryCreatedEvent): boolean {
  if (event.authorAgentId !== null) return false;
  if (event.inputType === "agent") return false;
  if (event.inputType === "system") return false;
  if (event.inputType === "scope_proposal") return false;
  return true;
}

export function createThreadEventListener(
  db: Db,
  opts: ThreadEventListenerOpts = {},
): ThreadEventListener {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  // threadId → pending timer handle. Single-process state — see header note
  // on in-memory acceptable-loss for Phase 1.
  const timers = new Map<string, NodeJS.Timeout>();

  async function fireAdjutantWakeup(threadId: string): Promise<void> {
    // Always drop the timer entry first — even if subsequent work throws,
    // the next human entry can install a fresh timer without a leaked handle.
    timers.delete(threadId);

    // Re-fetch the thread row inside the firing closure so toggles to
    // crewPaused / adjutantEnabled while the timer was pending are honored.
    const [thread] = await db
      .select()
      .from(discussions)
      .where(eq(discussions.id, threadId))
      .limit(1);

    if (!thread) {
      // Thread was deleted between debounce start and fire — nothing to do.
      return;
    }
    if (thread.crewPaused) {
      log.debug({ threadId }, "skip adjutant wakeup — thread.crewPaused");
      return;
    }
    if (thread.adjutantEnabled === false) {
      log.debug({ threadId }, "skip adjutant wakeup — thread.adjutantEnabled=false");
      return;
    }

    // Task 3.2 — dial-as-experience: the PROACTIVE Adjutant wake (this ambient
    // human-chatter debounce) is Assist+ only. At Manual (0) an agent answers
    // ONLY when directly @mentioned — there is no proactive jumping-in — so this
    // wake must suppress itself before driving anything.
    //
    // Resolve the SAME effective dial the dispatcher (dispatcher.ts D10) and the
    // controller-adjutant-runner use: effectiveAutonomy = thread.autonomyLevel ??
    // company.autonomyLevel. The thread row (selected above with `select()`) already
    // carries autonomyLevel; the company config is only fetched as the fallback when
    // the thread has no per-thread override — keeping the common Manual-at-thread case
    // to a single select.
    //
    // This gate governs the PROACTIVE path ONLY. A direct @mention answers via the
    // controller participation path (processMentions → requestParticipation, Tasks
    // 1.2/3.1) which never flows through fireAdjutantWakeup and is dial-exempt for
    // activation (founder-driven). The crewPaused / adjutantEnabled gates above stay.
    let effectiveAutonomy: number;
    if (thread.autonomyLevel != null) {
      effectiveAutonomy = thread.autonomyLevel;
    } else {
      const [companyCfg] = await db
        // D18: the proactive Adjutant wake is crew work — agent-work dial.
        .select({ autonomyLevel: internalAgentConfig.crewAutonomyLevel })
        .from(internalAgentConfig)
        .where(eq(internalAgentConfig.companyId, thread.companyId))
        .limit(1);
      effectiveAutonomy = companyCfg?.autonomyLevel ?? 0;
    }

    if (effectiveAutonomy < 1) {
      log.debug(
        { threadId, companyId: thread.companyId, effectiveAutonomy },
        "skip proactive adjutant wake — Manual dial (answers only when @mentioned)",
      );
      return;
    }

    // Resolve the company's Adjutant. There is exactly one per company by
    // construction (see agents_aoa_name_per_company_idx + ensure-adjutant
    // bootstrap). If absent the company hasn't been bootstrapped yet — skip
    // quietly rather than crash; sweep-adjutant will catch up.
    const [adjutant] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, thread.companyId),
          eq(agents.kind, "aoa"),
          eq(agents.name, "Adjutant"),
        ),
      )
      .limit(1);

    if (!adjutant) {
      log.debug(
        { threadId, companyId: thread.companyId },
        "skip adjutant wakeup — no Adjutant agent for company",
      );
      return;
    }

    const dedupKey = `${adjutant.id}:${threadId}:queued`;

    // P1-T3: mark the orchestration controller as "a run is due" ALONGSIDE
    // the peer-wake insert below. Best-effort — failure must not block the
    // wakeup. The two operations are additive and do not conflict.
    // NOTE: triggerOnHumanEntry calls ensureController internally so legacy
    // threads without a controller row are handled transparently.
    await threadOrchestrationService(db)
      .triggerOnHumanEntry(threadId)
      .catch((err) => {
        log.warn({ err, threadId }, "triggerOnHumanEntry failed — continuing with peer-wake");
      });

    // P1-T11 + controller wiring: controller-path threads are driven by the
    // orchestration controller, not peer-wake. triggerOnHumanEntry (above) set
    // pendingRun; now drive the run inline. Fire-and-forget — the run executes
    // the Adjutant (seconds to minutes) and must not block entry creation. The
    // atomic claim inside runController (pendingRun true→false) serializes this
    // against the backstop sweep: only one caller wins the claim, so no
    // double-execution. A second human entry mid-run bumps the epoch → this run
    // self-suppresses (cursor not advanced) and the next drain picks up the
    // newer entries. The peer-wake pipeline (agentWakeupRequests insert) remains
    // dormant for controller-path threads — do NOT delete it; old threads need it.
    if (thread.useControllerPath) {
      // Hard phase gate, symmetric with runControllerSweep's `phase != 'done'`
      // filter — a closed thread must not drive the Adjutant even if a late human
      // entry arrives. This is an enforced gate, not the Adjutant's soft prompt
      // guard. Review M3 (opus, 2026-05-30). Controller-path threads NEVER use
      // peer-wake, so we return in both branches.
      if (thread.phase !== "done") {
        log.debug({ threadId }, "skip peer-wake insert — thread uses controller path; firing inline drain");
        const runner = makeControllerAdjutantRunner(db);
        void threadOrchestrationService(db)
          .runController(threadId, { adjutantRunner: runner })
          .catch((err) => log.warn({ err, threadId }, "controller inline drain failed"));
      } else {
        log.debug({ threadId }, "skip controller drain — thread phase is done");
      }
      return; // skip the peer-wake insert below
    }

    // .onConflictDoNothing() pairs with the partial unique index on
    // (dedup_key) WHERE status='queued' AND dedup_key IS NOT NULL.
    // If a queued wakeup with the same dedupKey already exists (e.g. another
    // server in the same cluster fired first) we silently no-op.
    await db
      .insert(agentWakeupRequests)
      .values({
        companyId: thread.companyId,
        agentId: adjutant.id,
        source: "thread.event",
        reason: "human_entry_debounce",
        // hopCount=0 because this wakeup is human-originated; cap only counts
        // agent→agent hops, not the initial human→adjutant edge.
        payload: { threadId, hopCount: 0 } as Record<string, unknown>,
        dedupKey,
        status: "queued",
      })
      .onConflictDoNothing();
  }

  return {
    async onEntryCreated(event: EntryCreatedEvent) {
      if (!isHumanEntry(event)) return;

      // Task 1.3 — de-dup the double-drive. If this human entry directly
      // @mentions a crew agent, that agent answers via the controller
      // participation path (processMentions → requestParticipation, Task 1.2).
      // The proactive Adjutant debounce must NOT also fire on the same entry, or
      // a single `@Scout …` drives twice. So we skip arming the debounce here.
      // Ambient human chatter (no crew @mention) still arms it below — that is
      // the "Adjutant weighs in after humans pause" signal this listener exists
      // for. Note the controller participation path counts toward HOP_CAP=5
      // (thread-orchestration.ts), which is the cap that governs the unified
      // controller/participation path; the peer-wake-only MAX_HOP_COUNT below
      // governs the legacy dispatchMention path exclusively.
      if (event.hasCrewMention) {
        // Cancel a timer armed by an earlier human entry. Direct mentions use
        // participation, so leaving it alive would launch a second Adjutant run.
        const existing = timers.get(event.discussionId);
        if (existing) {
          clearTimeout(existing);
          timers.delete(event.discussionId);
        }
        log.debug(
          { threadId: event.discussionId, entryId: event.id },
          "skip arming adjutant debounce — entry @mentions a crew agent (answered directly via participation)",
        );
        return;
      }

      // Trailing-edge debounce: kill any existing timer for this thread, then
      // schedule a fresh one. Last human entry wins.
      const existing = timers.get(event.discussionId);
      if (existing) clearTimeout(existing);

      const t = setTimeout(() => {
        fireAdjutantWakeup(event.discussionId).catch((err) => {
          log.error(
            { err, threadId: event.discussionId },
            "fireAdjutantWakeup failed",
          );
        });
      }, debounceMs);
      // Unref so a pending timer doesn't prevent test workers (or graceful
      // shutdown) from exiting. .unref is a no-op in environments without it.
      if (typeof t.unref === "function") t.unref();
      timers.set(event.discussionId, t);
    },

    async dispatchMention(params: DispatchMentionParams) {
      // hopCount cap: if we'd be storing hopCount+1 >= MAX, block instead.
      // Using >= because currentHopCount is the *incoming* count and we
      // increment when storing — a wakeup at hop 2 produces a hop-3 mention,
      // and we want to block before the chain extends past 3 total hops.
      if (params.currentHopCount >= MAX_HOP_COUNT) {
        log.info(
          {
            agentId: params.agentId,
            threadId: params.threadId,
            entryId: params.entryId,
            hopCount: params.currentHopCount,
          },
          "dispatchMention blocked — hopCount cap reached",
        );
        return { wakeupId: null, blocked: true };
      }

      const [agent] = await db
        .select({ companyId: agents.companyId })
        .from(agents)
        .where(eq(agents.id, params.agentId))
        .limit(1);

      if (!agent) {
        log.debug(
          { agentId: params.agentId },
          "dispatchMention — agent not found, no-op",
        );
        return { wakeupId: null, blocked: false };
      }

      const dedupKey = `${params.agentId}:${params.threadId}:queued`;

      const result = await db
        .insert(agentWakeupRequests)
        .values({
          companyId: agent.companyId,
          agentId: params.agentId,
          source: "thread.mention",
          reason: "agent_mentioned",
          payload: {
            threadId: params.threadId,
            mentionEntryId: params.entryId,
            hopCount: params.currentHopCount + 1,
          } as Record<string, unknown>,
          dedupKey,
          status: "queued",
        })
        .onConflictDoNothing()
        .returning({ id: agentWakeupRequests.id });

      const row = result[0];
      return { wakeupId: row?.id ?? null, blocked: false };
    },

    shutdown() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}

// ── Singleton wiring ────────────────────────────────────────────────────────
//
// The listener is process-singleton because its debounce timers live in-memory.
// Routes/services that need to fire `onEntryCreated` import the singleton
// directly rather than reconstructing it per-request — otherwise each request
// would carry its own timer Map and the debounce semantic would break.

let _instance: ThreadEventListener | null = null;

/**
 * Initialize the process-wide listener singleton. Called once from
 * `server/src/index.ts` after `db` is ready. Idempotent — calling again with
 * the same db is a no-op; calling with a different db throws (would split
 * timer state across two listeners).
 */
export function initThreadEventListener(
  db: Db,
  opts: ThreadEventListenerOpts = {},
): ThreadEventListener {
  if (_instance) return _instance;
  _instance = createThreadEventListener(db, opts);
  return _instance;
}

/**
 * Resolve the singleton. Returns null if `initThreadEventListener` hasn't
 * been called yet — callers (e.g. `discussions.addEntry`) should treat null
 * as "feature not yet wired" and no-op, not crash. This keeps test setups
 * that skip startup-side wiring green.
 */
export function getThreadEventListener(): ThreadEventListener | null {
  return _instance;
}

/**
 * Test-only escape hatch. Resets the singleton so a fresh listener can be
 * installed for the next test case. Never call from production code paths.
 */
export function __resetThreadEventListenerForTests(): void {
  if (_instance) _instance.shutdown();
  _instance = null;
}
