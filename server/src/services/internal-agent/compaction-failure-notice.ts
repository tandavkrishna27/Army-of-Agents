/**
 * U13.6 — founder-visible signal when Commander's post-turn history
 * compaction (`summarizeViaCli`, cli-summarizer.ts) throws on `cloud_auth`.
 *
 * Before this wave, ANY compaction throw (desktop or cloud) was silently
 * swallowed by agent-loop.ts's post-turn try/catch (R3 silent-degrade): the
 * conversation just kept growing unbounded with zero founder-visible signal.
 * Compaction stays best-effort — this ONLY adds a notification surface; it
 * never turns compaction into something that can fail the Commander turn.
 *
 * Scoped to cloud only by the caller (agent-loop.ts): on desktop, a
 * compaction failure is far more likely to be a transient/local condition
 * (CLI not installed/authed) and raising a standing founder notification for
 * every such turn would be noisy. On cloud, U13.6 routes compaction through
 * the same ephemeral-sandbox seam as extraction (U13.1); a failure there
 * (no company provider key, sandbox unavailable, budget exhausted) is an
 * actionable, founder-facing condition worth surfacing.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { userRoles } from "@armyofagents/db";
import { createNotification } from "../notifications.js";
import { logger } from "../../middleware/logger.js";

/** Mirrors companies.ts's `resolveCompanyFoundingOperator` / work-questions.ts's
 *  `founderUserId` — the earliest-created founder role row for the company.
 *  This is a best-effort side-notification, not an authorization check, so a
 *  single (primary) founder recipient is sufficient — the goal is ONE
 *  founder-visible row, not fan-out to every founder. */
async function resolveFounderUserId(db: Db, companyId: string): Promise<string | null> {
  const rows = await db
    .select({ userId: userRoles.userId, createdAt: userRoles.createdAt })
    .from(userRoles)
    .where(and(eq(userRoles.companyId, companyId), eq(userRoles.role, "founder")));
  if (rows.length === 0) return null;
  const sorted = [...rows].sort(
    (a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0),
  );
  return sorted[0].userId;
}

/**
 * Resolve the company's founder and raise ONE `internal_agent.compaction_failed`
 * notification row. Never throws — the caller (agent-loop.ts) already treats
 * compaction as best-effort and this surface must never affect the delivered
 * reply or fail the Commander run.
 */
export async function notifyFounderOfCompactionFailure(
  db: Db,
  companyId: string,
  err: unknown,
  conversationId?: string,
): Promise<void> {
  try {
    const founderUserId = await resolveFounderUserId(db, companyId);
    if (!founderUserId) return;
    const detail = err instanceof Error ? err.message : String(err);
    await createNotification(db, {
      companyId,
      userId: founderUserId,
      type: "internal_agent.compaction_failed",
      title: "Commander could not compact this conversation",
      message:
        `History compaction failed on this turn — the conversation will keep growing until it succeeds. ${detail}`.slice(
          0,
          1000,
        ),
      relatedEntityType: "internal_agent_conversation",
      relatedEntityId: conversationId ?? null,
    });
  } catch (notifyErr) {
    logger.error(
      { err: notifyErr, companyId },
      "notifyFounderOfCompactionFailure failed (compaction stays best-effort; no founder row was raised)",
    );
  }
}
