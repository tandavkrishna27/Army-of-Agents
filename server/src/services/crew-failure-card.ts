/**
 * P2-T2: Agent-failure cards.
 *
 * When a thread-linked deliverable task's heartbeat run fails, post a visible
 * `system` entry to the source thread so the failure surfaces in the chat (with
 * Retry/Reassign/Skip affordances in the UI) instead of being a silent `failed`
 * status. Mirrors the hop-cap card pattern in thread-orchestration.ts.
 *
 * The entry is inputType:"system" with sourceInfo.type:"crew_failed". It is
 * marked extractionStatus:"skipped" so the LLM-extraction sweeps never claim it
 * (same guard the hop-cap + scope_proposal entries use).
 */
import { eq, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { discussions, discussionEntries } from "@armyofagents/db";
import { publishLiveEvent } from "./live-events.js";
import { logger } from "../middleware/logger.js";

const log = logger.child({ svc: "crew-failure-card" });

export interface CrewFailureSourceInfo {
  type: "crew_failed";
  issueId: string;
  agentId: string;
  agentName: string;
  taskTitle: string;
  error: string;
}

export interface PostCrewFailureCardParams {
  threadId: string;
  companyId: string;
  issueId: string;
  agentId: string;
  agentName: string;
  taskTitle: string;
  error: string;
}

/**
 * Pure builder for the sourceInfo payload — easy to unit-test. Truncates the
 * error to keep the entry small (the full error lives on the heartbeat run).
 */
export function buildCrewFailureSourceInfo(params: {
  issueId: string;
  agentId: string;
  agentName: string;
  taskTitle: string;
  error: string;
}): CrewFailureSourceInfo {
  const MAX_ERROR = 500;
  const error =
    params.error.length > MAX_ERROR
      ? params.error.slice(0, MAX_ERROR) + "…"
      : params.error;
  return {
    type: "crew_failed",
    issueId: params.issueId,
    agentId: params.agentId,
    agentName: params.agentName,
    taskTitle: params.taskTitle,
    error,
  };
}

/**
 * Post a crew-failure system entry to a thread. Best-effort — the caller wraps
 * this in try/catch so a failure to post NEVER masks the original task failure.
 * Bumps discussions.entrySeq + entryCount atomically and assigns the entry seq,
 * then publishes discussion.entry.created + thread.entry.created live events.
 */
export async function postCrewFailureCard(
  db: Db,
  params: PostCrewFailureCardParams,
): Promise<void> {
  const sourceInfo = buildCrewFailureSourceInfo(params);
  const rawContent = `${params.agentName} could not complete "${params.taskTitle}".`;
  const now = new Date();

  const { entry, companyId } = await db.transaction(async (tx) => {
    const [{ entrySeq, companyId: cid }] = await tx
      .update(discussions)
      .set({
        entrySeq: sql`${discussions.entrySeq} + 1`,
        entryCount: sql`${discussions.entryCount} + 1`,
        updatedAt: now,
      })
      .where(eq(discussions.id, params.threadId))
      .returning({ entrySeq: discussions.entrySeq, companyId: discussions.companyId });

    const [inserted] = await tx
      .insert(discussionEntries)
      .values({
        discussionId: params.threadId,
        inputType: "system",
        rawContent,
        sourceInfo: sourceInfo as unknown as Record<string, unknown>,
        authorAgentId: null,
        createdBy: params.agentId,
        extractionStatus: "skipped",
        seq: entrySeq,
      })
      .returning();

    return { entry: inserted, companyId: cid };
  });

  publishLiveEvent({
    companyId,
    type: "discussion.entry.created",
    payload: { discussionId: params.threadId, entryId: entry.id, inputType: "system" },
  });
  publishLiveEvent({
    companyId,
    type: "thread.entry.created",
    payload: { threadId: params.threadId, entryId: entry.id, seq: entry.seq ?? 0 },
  });

  log.debug(
    { threadId: params.threadId, issueId: params.issueId },
    "posted crew-failure card",
  );
}
