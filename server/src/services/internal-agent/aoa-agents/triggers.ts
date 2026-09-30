import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { aoaAgentTriggers, agents } from "@armyofagents/db";

// ── Plan 3 Task 5: trigger event evaluators ──────────────────────────────────

export type TriggerEventInput =
  | { type: "thread.mention"; targetType: "agent" | "user" }
  | { type: "thread.phase.changed" }
  | { type: "routine.tick" }
  | { type: "sweep.tick" }
  | { type: string; targetType?: string };

/**
 * Returns true if the given trigger's kind matches the event.
 *
 * Trigger kinds:
 *  - `mention`     — fires ONLY on @agent mentions (not @human)
 *  - `phase-advance` — fires on thread phase transitions
 *  - `routine`     — fires on scheduled ticks
 *  - `sweep`       — fires on periodic sweep ticks (one wakeup per active thread)
 *  - `event`       — T1.4: fires when a LiveEvent matches `config.eventName`
 *                    (e.g. config.eventName='entry.added' fires on
 *                    discussion.entry.created). Evaluated by evaluate-event-
 *                    triggers.ts (T1.4 part 2), NOT by this matcher — the
 *                    LiveEvent name check is shape-aware and lives there.
 *                    Returns false here so a misrouted sweep.tick/mention/etc.
 *                    doesn't accidentally fire an event trigger.
 *  - `outbox`      — drained by the durable poll, never by event match
 */
export function triggerMatchesEvent(
  trigger: { kind: string },
  event: TriggerEventInput,
): boolean {
  switch (trigger.kind) {
    case "mention":
      return event.type === "thread.mention" && event.targetType === "agent";
    case "phase-advance":
      return event.type === "thread.phase.changed";
    case "routine":
      return event.type === "routine.tick";
    case "sweep":
      return event.type === "sweep.tick";
    case "event":
      // T1.4: event triggers go through a different evaluator
      // (evaluate-event-triggers.ts) that consults config.eventName against
      // the LiveEvent name. Return false here so this matcher doesn't
      // claim ownership.
      return false;
    case "outbox":
      return false; // outbox is drained by the durable poll, not event-matched
    default:
      return false;
  }
}

// ── Outbox agent listing (pre-existing) ─────────────────────────────────────

/** Agent ids in `companyId` that have an enabled `outbox`
 *  (discussion_entry_pending) trigger and are not paused/terminated.
 *  v1 implements outbox only; routine/event/mention are recognized
 *  kinds with no evaluator yet (the seam exists, later plans extend). */
export async function listEnabledOutboxAgents(db: Db, companyId: string): Promise<string[]> {
  const rows = await db
    .select({ agentId: aoaAgentTriggers.agentId, status: agents.status })
    .from(aoaAgentTriggers)
    .innerJoin(agents, eq(agents.id, aoaAgentTriggers.agentId))
    .where(and(
      eq(aoaAgentTriggers.companyId, companyId),
      eq(aoaAgentTriggers.kind, "outbox"),
      eq(aoaAgentTriggers.enabled, true),
    ))
    .then((r: Array<{ agentId: string; status: string }>) => r);
  return rows.filter((r) => r.status !== "paused" && r.status !== "terminated").map((r) => r.agentId);
}
