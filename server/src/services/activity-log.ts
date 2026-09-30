import type { Db } from "@armyofagents/db";
import { activityLog } from "@armyofagents/db";
import type { ActivityActorType } from "@armyofagents/shared";
import { publishLiveEvent } from "./live-events.js";
import { sanitizeRecord } from "../redaction.js";
import { assertUnreservedActivityNamespace } from "./activity-namespace.js";

export interface LogActivityInput {
  companyId: string;
  actorType: ActivityActorType;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  agentId?: string | null;
  runId?: string | null;
  details?: Record<string, unknown> | null;
}

export interface PersistedActivity extends Omit<LogActivityInput, "details"> {
  /** The inserted activity_log row id (JOB-013 — the audit bridge links its
   * projection receipt's targetAggregateId to this). Additive/back-compatible:
   * existing callers simply ignore it. */
  id: string;
  details: Record<string, unknown> | null;
}

/**
 * Persist the mandatory audit row without publishing a pre-commit event.
 *
 * ★ THIS IS WHERE A CALLER-SUPPLIED `action` BELONGS. `activity_log` has no
 * single write chokepoint — thirty-four direct `insert(activityLog)` sites, two
 * of them guarded (see `activity-namespace.ts`) — so the reserved
 * `security.denied.*` namespace holds only because every direct writer hard-codes
 * its action. If your action comes from a caller, route it through here rather
 * than adding a thirty-fifth direct insert.
 */
export async function insertActivityLog(
  db: Pick<Db, "insert">,
  input: LogActivityInput
): Promise<PersistedActivity> {
  assertUnreservedActivityNamespace(input);
  const sanitizedDetails = input.details ? sanitizeRecord(input.details) : null;
  const [row] = await db.insert(activityLog).values({
    companyId: input.companyId,
    actorType: input.actorType,
    actorId: input.actorId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    agentId: input.agentId ?? null,
    runId: input.runId ?? null,
    details: sanitizedDetails,
  }).returning({ id: activityLog.id });

  return {
    ...input,
    id: row.id,
    agentId: input.agentId ?? null,
    runId: input.runId ?? null,
    details: sanitizedDetails,
  };
}

/** Publish only after the surrounding database transaction has committed. */
export function publishActivityLogged(input: PersistedActivity): void {
  publishLiveEvent({
    companyId: input.companyId,
    type: "activity.logged",
    payload: {
      actorType: input.actorType,
      actorId: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      agentId: input.agentId ?? null,
      runId: input.runId ?? null,
      details: input.details,
    },
  });
}

// --- Broker-flow compatibility API (used by mcp-connectors routes + token-refresh) ---
// Same insert-then-publish split as above, exposed with the prepared-event shape
// those call sites already consume. Delegates to insertActivityLog so there is one
// insert path and redaction stays consistent (the live event carries sanitized details).

export interface PreparedActivityEvent {
  /** The inserted activity_log row id (JOB-013). Additive — existing consumers
   * (mcp-connectors routes + token-refresh) ignore it. */
  id: string;
  companyId: string;
  payload: {
    actorType: ActivityActorType;
    actorId: string;
    action: string;
    entityType: string;
    entityId: string;
    agentId: string | null;
    runId: string | null;
    details: Record<string, unknown> | null;
  };
}

/** Persist an activity row without publishing (transaction-safe); returns a prepared event. */
export async function insertActivity(db: Db, input: LogActivityInput): Promise<PreparedActivityEvent> {
  const persisted = await insertActivityLog(db, input);
  return {
    id: persisted.id,
    companyId: persisted.companyId,
    payload: {
      actorType: persisted.actorType,
      actorId: persisted.actorId,
      action: persisted.action,
      entityType: persisted.entityType,
      entityId: persisted.entityId,
      agentId: persisted.agentId ?? null,
      runId: persisted.runId ?? null,
      details: persisted.details,
    },
  };
}

/** Publish only after the transaction containing insertActivity has committed. */
export function publishActivity(event: PreparedActivityEvent) {
  publishLiveEvent({
    companyId: event.companyId,
    type: "activity.logged",
    payload: event.payload,
  });
}

export async function logActivity(db: Db, input: LogActivityInput) {
  const persisted = await insertActivityLog(db, input);
  publishActivityLogged(persisted);
}
