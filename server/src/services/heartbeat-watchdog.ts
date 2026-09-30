import { and, desc, eq, isNotNull, lt, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { heartbeatRuns, heartbeatRunWatchdogDecisions } from "@armyofagents/db";
import { logger } from "../middleware/logger.js";

const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 min — heartbeat run with no output for this long is stale
const SNOOZE_DURATION_MS = 60 * 60 * 1000; // 1 hr per decision

export interface HeartbeatWatchdogSweepResult {
  checked: number;
  recorded: number;
}

/**
 * Sweep heartbeat_runs for stale running entries (no output for STALE_THRESHOLD_MS),
 * record a watchdog decision, and snooze re-evaluation for SNOOZE_DURATION_MS.
 *
 * Idempotent: if a recent decision exists with snoozed_until > now, the run is skipped.
 *
 * Future extension (per upstream Paperclip 0070): the recorded decision can drive
 * automatic recovery actions (e.g., kill the process, mark the run failed). This
 * implementation only records observations.
 */
export async function sweepStaleHeartbeatRuns(db: Db): Promise<HeartbeatWatchdogSweepResult> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - STALE_THRESHOLD_MS);

  const stale = await db
    .select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      lastOutputAt: heartbeatRuns.lastOutputAt,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.status, "running"),
        isNotNull(heartbeatRuns.lastOutputAt),
        lt(heartbeatRuns.lastOutputAt, cutoff),
      ),
    );

  let recorded = 0;
  for (const run of stale) {
    // Look up the most recent watchdog decision for this run, if any
    const recent = await db
      .select({
        snoozedUntil: heartbeatRunWatchdogDecisions.snoozedUntil,
      })
      .from(heartbeatRunWatchdogDecisions)
      .where(eq(heartbeatRunWatchdogDecisions.runId, run.id))
      .orderBy(desc(heartbeatRunWatchdogDecisions.createdAt))
      .limit(1);

    const lastDecision = recent[0];
    if (lastDecision?.snoozedUntil && lastDecision.snoozedUntil > now) {
      continue; // still snoozed
    }

    await db.insert(heartbeatRunWatchdogDecisions).values({
      companyId: run.companyId,
      runId: run.id,
      decision: "stale_no_output",
      snoozedUntil: new Date(now.getTime() + SNOOZE_DURATION_MS),
      reason: `No output since ${run.lastOutputAt?.toISOString()}`,
    });

    logger.warn(
      { runId: run.id, companyId: run.companyId, lastOutputAt: run.lastOutputAt },
      "[watchdog] Stale heartbeat run detected",
    );
    recorded += 1;
  }

  return { checked: stale.length, recorded };
}

/**
 * Register the watchdog sweeper to run every 60s.
 * Returns the interval handle (callers can clearInterval if needed).
 */
export function registerHeartbeatWatchdogSweeper(db: Db): NodeJS.Timeout {
  const SWEEP_INTERVAL_MS = 60_000;
  return setInterval(() => {
    void sweepStaleHeartbeatRuns(db).catch((err) => {
      logger.error({ err }, "[watchdog] sweep failed");
    });
  }, SWEEP_INTERVAL_MS);
}
